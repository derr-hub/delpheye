//! Finding files with identical content.
//!
//! Candidates arrive already narrowed to files that share a size. They are then compared in
//! two rounds so that as little as possible is read: first a fingerprint of the beginning and
//! end of each file, and only for those that still match, a hash of the whole content.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use rayon::prelude::*;
use serde::Serialize;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};

/// How much of each end of a file the first round reads.
const SAMPLE: u64 = 64 * 1024;
const BLOCK: usize = 1024 * 1024;

type Hash = [u8; 32];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// `"sampling"` while fingerprinting, `"hashing"` while reading whole files.
    stage: &'static str,
    done: u64,
    total: u64,
}

/// Which file on disk this is. Two paths with the same identity are hard links to one file:
/// removing either frees nothing, so they are not duplicates of each other.
fn identity(file: &File) -> Option<(u32, u64)> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle belongs to `file`, which is open for the duration of the call.
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info).ok()? };
    Some((info.dwVolumeSerialNumber, (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow)))
}

/// Fingerprints the first and last `SAMPLE` bytes. `None` if the file cannot be read or is
/// no longer the size the index recorded.
fn sample(path: &Path, size: u64) -> Option<((u32, u64), Hash)> {
    let mut file = File::open(path).ok()?;
    if file.metadata().ok()?.len() != size {
        return None;
    }
    let id = identity(&file)?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0u8; SAMPLE.min(size) as usize];
    file.read_exact(&mut buffer).ok()?;
    hasher.update(&buffer);
    if size > SAMPLE * 2 {
        file.seek(SeekFrom::End(-(SAMPLE as i64))).ok()?;
        file.read_exact(&mut buffer).ok()?;
        hasher.update(&buffer);
    }
    Some((id, *hasher.finalize().as_bytes()))
}

/// Hashes the whole file, reporting each block read. `None` if unreadable or cancelled.
fn hash(path: &Path, cancel: &AtomicBool, read: &dyn Fn(u64)) -> Option<Hash> {
    let mut file = File::open(path).ok()?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0u8; BLOCK];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        let got = file.read(&mut buffer).ok()?;
        if got == 0 {
            return Some(*hasher.finalize().as_bytes());
        }
        hasher.update(&buffer[..got]);
        read(got as u64);
    }
}

/// Splits `items` into groups with equal keys, dropping items that stand alone.
fn group<K: std::hash::Hash + Eq, T>(items: impl IntoIterator<Item = (K, T)>) -> Vec<Vec<T>> {
    let mut groups: HashMap<K, Vec<T>> = HashMap::new();
    for (key, item) in items {
        groups.entry(key).or_default().push(item);
    }
    groups.into_values().filter(|group| group.len() > 1).collect()
}

/// Groups `(id, size, path)` candidates by content. Returns the ids of each group of two or
/// more identical files, or `None` if cancelled. Unreadable files are simply left out.
pub fn find(
    candidates: Vec<(u32, u64, PathBuf)>,
    cancel: &AtomicBool,
    report: &(dyn Fn(Progress) + Sync),
) -> Option<Vec<Vec<u32>>> {
    let cancelled = || cancel.load(Ordering::Relaxed);

    // Round one: same size and same fingerprint.
    let total = candidates.len() as u64;
    let done = AtomicU64::new(0);
    let sampled: Vec<((u64, Hash), Sampled)> = candidates
        .into_par_iter()
        .filter_map(|(id, size, path)| {
            let fingerprint = if cancelled() { None } else { sample(&path, size) };
            report(Progress { stage: "sampling", done: done.fetch_add(1, Ordering::Relaxed) + 1, total });
            fingerprint.map(|(file, fingerprint)| ((size, fingerprint), Sampled { file, id, size, path }))
        })
        .collect();
    if cancelled() {
        return None;
    }

    // Hard links to one file count once; a group needs two really separate files to go on.
    let mut to_hash: Vec<(usize, Sampled)> = Vec::new();
    for (number, files) in group(sampled).into_iter().enumerate() {
        let mut seen = HashSet::new();
        let separate: Vec<Sampled> = files.into_iter().filter(|f| seen.insert(f.file)).collect();
        if separate.len() > 1 {
            to_hash.extend(separate.into_iter().map(|f| (number, f)));
        }
    }

    // Round two: the whole content. Files from different first-round groups are never compared.
    let total = to_hash.iter().map(|(_, f)| f.size).sum();
    let done = AtomicU64::new(0);
    let hashed: Vec<((usize, Hash), u32)> = to_hash
        .into_par_iter()
        .filter_map(|(number, file)| {
            let read = |bytes: u64| {
                report(Progress { stage: "hashing", done: done.fetch_add(bytes, Ordering::Relaxed) + bytes, total });
            };
            Some(((number, hash(&file.path, cancel, &read)?), file.id))
        })
        .collect();
    if cancelled() {
        return None;
    }
    Some(group(hashed))
}

struct Sampled {
    file: (u32, u64),
    id: u32,
    size: u64,
    path: PathBuf,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cleanup::testing::Sandbox;
    use std::fs;

    fn put(path: &Path, content: &[u8]) -> (u64, PathBuf) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
        (content.len() as u64, path.to_path_buf())
    }

    fn run(candidates: Vec<(u32, u64, PathBuf)>) -> Vec<Vec<u32>> {
        let mut groups = find(candidates, &AtomicBool::new(false), &|_| {}).unwrap();
        groups.iter_mut().for_each(|g| g.sort_unstable());
        groups.sort();
        groups
    }

    #[test]
    fn identical_content_is_grouped_and_near_misses_are_not() {
        let sandbox = Sandbox::new();
        let root = &sandbox.root;
        let big = vec![7u8; 400_000];
        // Same size, same beginning and end, one different byte in the middle: only the
        // full-content round can tell it apart.
        let mut near_miss = big.clone();
        near_miss[200_000] = 8;
        let mut other_start = big.clone();
        other_start[0] = 9;

        let files = [
            put(&root.join("a").join("video.bin"), &big),
            put(&root.join("b").join("copy of video.bin"), &big),
            put(&root.join("c").join("near-miss.bin"), &near_miss),
            put(&root.join("d").join("other-start.bin"), &other_start),
            put(&root.join("e").join("third copy.bin"), &big),
            put(&root.join("small-1"), b"hello"),
            put(&root.join("small-2"), b"hello"),
            put(&root.join("small-3"), b"world"),
        ];
        let candidates = files.iter().enumerate().map(|(i, (size, path))| (i as u32, *size, path.clone())).collect();
        assert_eq!(run(candidates), [vec![0, 1, 4], vec![5, 6]]);
    }

    #[test]
    fn hard_links_are_one_file_not_duplicates() {
        let sandbox = Sandbox::new();
        let (size, original) = put(&sandbox.root.join("original.bin"), &[1u8; 1000]);
        let link = sandbox.root.join("hard-link.bin");
        fs::hard_link(&original, &link).unwrap();

        assert!(run(vec![(0, size, original.clone()), (1, size, link.clone())]).is_empty());

        let (_, copy) = put(&sandbox.root.join("real-copy.bin"), &[1u8; 1000]);
        let groups = run(vec![(0, size, original), (1, size, link), (2, size, copy)]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].len(), 2, "one of the two links, plus the real copy");
        assert!(groups[0].contains(&2));
    }

    #[test]
    fn stale_or_missing_candidates_are_left_out() {
        let sandbox = Sandbox::new();
        let (size, a) = put(&sandbox.root.join("a.bin"), &[3u8; 500]);
        let (_, b) = put(&sandbox.root.join("b.bin"), &[3u8; 500]);
        let missing = sandbox.root.join("deleted-since.bin");
        // `b` is claimed to be a size it no longer has: the index is out of date for it.
        assert!(run(vec![(0, size, a.clone()), (1, size + 1, b.clone()), (2, size, missing)]).is_empty());
        assert_eq!(run(vec![(0, size, a), (1, size, b)]), [vec![0, 1]]);
    }

    #[test]
    fn cancelling_yields_nothing() {
        let sandbox = Sandbox::new();
        let (size, a) = put(&sandbox.root.join("a.bin"), &[3u8; 500]);
        assert!(find(vec![(0, size, a)], &AtomicBool::new(true), &|_| {}).is_none());
    }
}

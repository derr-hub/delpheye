//! Reading an NTFS volume's file table (`$MFT`) directly.
//!
//! NTFS keeps one fixed-size record per file in a single table. Reading that table from the
//! raw volume yields every name, parent and size on the drive in a few seconds, without
//! opening a single folder. It needs administrator rights, and it only ever reads.
//!
//! Anything unexpected is reported as an error rather than guessed at; the caller then falls
//! back to walking the folders.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use rayon::prelude::*;

use super::{Entry, Watcher};

/// The record that describes the drive's top folder.
const ROOT_RECORD: u32 = 5;
/// Records below this one are NTFS's own bookkeeping files, not the user's.
const FIRST_USER_RECORD: u32 = 24;
/// NTFS protects each 512 bytes of a record against torn writes, whatever the sector size.
const FIXUP_STRIDE: usize = 512;
/// How much of the table is read and parsed at a time.
const CHUNK: u64 = 32 << 20;
/// The low 48 bits of a file reference are the record number; the rest is a reuse counter.
const RECORD_NUMBER: u64 = 0xFFFF_FFFF_FFFF;

const ATTR_STANDARD_INFORMATION: u32 = 0x10;
const ATTR_ATTRIBUTE_LIST: u32 = 0x20;
const ATTR_FILE_NAME: u32 = 0x30;
const ATTR_DATA: u32 = 0x80;
const ATTR_REPARSE_POINT: u32 = 0xC0;
const ATTR_END: u32 = 0xFFFF_FFFF;

const RECORD_IN_USE: u16 = 0x1;
const RECORD_IS_DIRECTORY: u16 = 0x2;
/// A short 8.3 alias of a file that also has a proper name.
const NAMESPACE_DOS: u8 = 2;
const TAG_MOUNT_POINT: u32 = 0xA000_0003;
const TAG_SYMLINK: u32 = 0xA000_000C;
/// The content is not on this disk (cloud placeholder).
const FILE_OFFLINE: u32 = 0x1000 | 0x0040_0000;

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn u64_at(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(bytes.get(at..at + 8)?.try_into().ok()?))
}

/// Sizes and positions taken from the volume's boot sector.
#[derive(Debug, PartialEq)]
struct Geometry {
    cluster: u64,
    record: usize,
    /// Where the table starts on the volume, in bytes.
    table_at: u64,
}

fn geometry(boot: &[u8]) -> Result<Geometry, String> {
    if boot.get(3..11) != Some(b"NTFS    ") {
        return Err("not an NTFS volume".into());
    }
    let read = || {
        let sector = u64::from(u16_at(boot, 0x0B)?);
        // Above 0x80 the byte is a negative power of two rather than a count.
        let per_cluster = match *boot.get(0x0D)? {
            raw @ 0..=0x80 => u64::from(raw),
            raw => 1u64.checked_shl(256 - u32::from(raw))?,
        };
        let cluster = sector.checked_mul(per_cluster)?;
        // Negative means "2 to that power bytes"; positive means that many clusters.
        let record = match *boot.get(0x40)? as i8 {
            raw @ ..0 => 1u64.checked_shl(u32::from(raw.unsigned_abs()))?,
            raw => cluster.checked_mul(raw as u64)?,
        };
        let table_at = u64_at(boot, 0x30)?.checked_mul(cluster)?;
        Some((cluster, record, table_at))
    };
    let (cluster, record, table_at) = read().ok_or("unreadable boot sector")?;
    let sane = cluster.is_power_of_two()
        && (FIXUP_STRIDE as u64..=65_536).contains(&record)
        && record % FIXUP_STRIDE as u64 == 0
        // Records must not straddle clusters, or one could be split between two extents.
        && cluster % record == 0
        && CHUNK % cluster == 0;
    sane.then_some(Geometry { cluster, record: record as usize, table_at })
        .ok_or_else(|| format!("unsupported layout (cluster {cluster}, record {record})"))
}

/// Undoes NTFS's torn-write protection in place. Returns false for a record that is not a
/// file record or whose check values do not match, meaning it was only partly written.
fn fix_up(record: &mut [u8]) -> bool {
    let restore = |record: &mut [u8]| {
        if record.get(..4)? != b"FILE" {
            return None;
        }
        let at = usize::from(u16_at(record, 4)?);
        let count = usize::from(u16_at(record, 6)?);
        let check: [u8; 2] = record.get(at..at + 2)?.try_into().ok()?;
        for i in 1..count {
            let end = i * FIXUP_STRIDE;
            let original: [u8; 2] = record.get(at + 2 * i..at + 2 * i + 2)?.try_into().ok()?;
            let tail = record.get_mut(end - 2..end)?;
            if tail != check {
                return None;
            }
            tail.copy_from_slice(&original);
        }
        Some(())
    };
    restore(record).is_some()
}

struct Attr<'a> {
    kind: u32,
    bytes: &'a [u8],
}

impl<'a> Attr<'a> {
    fn is_resident(&self) -> bool {
        self.bytes.get(8) == Some(&0)
    }

    /// The attribute has no name of its own; for `$DATA` that is the file's main content.
    fn is_unnamed(&self) -> bool {
        self.bytes.get(9) == Some(&0)
    }

    /// The content of an attribute stored inside the record.
    fn value(&self) -> Option<&'a [u8]> {
        if !self.is_resident() {
            return None;
        }
        let len = u32_at(self.bytes, 0x10)? as usize;
        let at = usize::from(u16_at(self.bytes, 0x14)?);
        self.bytes.get(at..at.checked_add(len)?)
    }

    /// For content stored outside the record: the first cluster number this piece covers.
    fn first_vcn(&self) -> Option<u64> {
        (!self.is_resident()).then(|| u64_at(self.bytes, 0x10)).flatten()
    }

    fn real_size(&self) -> Option<u64> {
        (!self.is_resident()).then(|| u64_at(self.bytes, 0x30)).flatten()
    }

    fn runs(&self) -> Option<Vec<(Option<u64>, u64)>> {
        let at = usize::from(u16_at(self.bytes, 0x20)?);
        decode_runs(self.bytes.get(at..)?)
    }
}

fn attributes(record: &[u8]) -> impl Iterator<Item = Attr<'_>> {
    let mut at = u16_at(record, 0x14).map_or(usize::MAX, usize::from);
    std::iter::from_fn(move || {
        let kind = u32_at(record, at)?;
        let len = u32_at(record, at.checked_add(4)?)? as usize;
        if kind == ATTR_END || len < 0x18 {
            return None;
        }
        let bytes = record.get(at..at.checked_add(len)?)?;
        at += len;
        Some(Attr { kind, bytes })
    })
}

/// Decodes a run list into `(first cluster on disk, cluster count)` pieces, in file order.
/// A piece with no cluster is a hole. Returns `None` for a malformed list.
fn decode_runs(mut bytes: &[u8]) -> Option<Vec<(Option<u64>, u64)>> {
    let mut runs = Vec::new();
    let mut cluster: i64 = 0;
    loop {
        let header = *bytes.first()?;
        if header == 0 {
            return Some(runs);
        }
        let (count_size, offset_size) = (usize::from(header & 0x0F), usize::from(header >> 4));
        if count_size == 0 || count_size > 8 || offset_size > 8 {
            return None;
        }
        let little_endian = |bytes: &[u8]| bytes.iter().rev().fold(0u64, |value, &byte| (value << 8) | u64::from(byte));
        let count = little_endian(bytes.get(1..1 + count_size)?);
        let offset = bytes.get(1 + count_size..1 + count_size + offset_size)?;
        let start = if offset.is_empty() {
            None
        } else {
            // Each offset is signed and relative to where the previous piece started.
            let unused_bits = 64 - 8 * offset_size as u32;
            cluster = cluster.checked_add(((little_endian(offset) << unused_bits) as i64) >> unused_bits)?;
            Some(u64::try_from(cluster).ok()?)
        };
        runs.push((start, count));
        bytes = &bytes[1 + count_size + offset_size..];
    }
}

/// What one table record says about one file.
#[derive(Default, Debug, PartialEq)]
struct Parsed {
    is_dir: bool,
    /// For a record that only continues another one: that record's number.
    continues: Option<u32>,
    parent: u32,
    name: Option<String>,
    size: Option<u64>,
    modified: i64,
    /// A junction or symbolic link: it leads elsewhere and holds nothing itself.
    is_link: bool,
    is_offline: bool,
}

/// Reads one record. `None` for an unused, damaged or malformed one.
fn parse(record: &mut [u8]) -> Option<Parsed> {
    if !fix_up(record) {
        return None;
    }
    let flags = u16_at(record, 0x16)?;
    if flags & RECORD_IN_USE == 0 {
        return None;
    }
    let base = u64_at(record, 0x20)? & RECORD_NUMBER;
    let mut parsed = Parsed {
        is_dir: flags & RECORD_IS_DIRECTORY != 0,
        continues: (base != 0).then(|| u32::try_from(base).ok()).flatten(),
        ..Parsed::default()
    };
    if base != 0 && parsed.continues.is_none() {
        return None;
    }

    let mut best_name = 0;
    for attr in attributes(record) {
        match attr.kind {
            ATTR_STANDARD_INFORMATION => {
                let value = attr.value()?;
                // Times count 100 ns steps since 1601; the index wants seconds since 1970.
                parsed.modified = ((u64_at(value, 8)? / 10_000_000) as i64 - 11_644_473_600).max(0);
                parsed.is_offline = u32_at(value, 0x20)? & FILE_OFFLINE != 0;
            }
            ATTR_FILE_NAME => {
                let value = attr.value()?;
                // A file can carry several names; prefer a proper one over a POSIX one,
                // and never use the 8.3 alias.
                let rank = match *value.get(0x41)? {
                    NAMESPACE_DOS => 0,
                    0 => 1,
                    _ => 2,
                };
                if rank > best_name {
                    best_name = rank;
                    let length = usize::from(*value.get(0x40)?);
                    let units: Vec<u16> = value
                        .get(0x42..0x42 + 2 * length)?
                        .chunks_exact(2)
                        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                        .collect();
                    parsed.name = Some(String::from_utf16_lossy(&units));
                    parsed.parent = u32::try_from(u64_at(value, 0)? & RECORD_NUMBER).ok()?;
                }
            }
            ATTR_DATA if attr.is_unnamed() => {
                if attr.is_resident() {
                    parsed.size = Some(u64::from(u32_at(attr.bytes, 0x10)?));
                } else if attr.first_vcn()? == 0 {
                    // Later pieces of a fragmented file repeat no size; only the first counts.
                    parsed.size = attr.real_size();
                }
            }
            ATTR_REPARSE_POINT => {
                // Other tags (cloud files, compressed system files) are ordinary files to us.
                let tag = attr.value().and_then(|value| u32_at(value, 0));
                parsed.is_link = matches!(tag, Some(TAG_MOUNT_POINT | TAG_SYMLINK));
            }
            _ => {}
        }
    }
    Some(parsed)
}

/// Turns parsed records, indexed by record number, into index entries.
fn assemble(records: Vec<Option<Parsed>>) -> Vec<Option<Entry>> {
    let mut entries: Vec<Option<Entry>> = Vec::with_capacity(records.len());
    let mut continued: Vec<(u32, u64)> = Vec::new();
    let mut offline: HashSet<u32> = HashSet::new();

    for (number, parsed) in records.into_iter().enumerate() {
        let number = number as u32;
        let entry = parsed.and_then(|parsed| {
            if let Some(base) = parsed.continues {
                // A file with too many attributes for one record keeps the rest in others.
                continued.extend(parsed.size.map(|size| (base, size)));
                return None;
            }
            let is_system = number < FIRST_USER_RECORD && number != ROOT_RECORD;
            if is_system || parsed.is_link {
                return None;
            }
            if parsed.is_offline {
                offline.insert(number);
            }
            Some(Entry {
                parent: parsed.parent,
                name: parsed.name?,
                is_dir: parsed.is_dir,
                size: if parsed.is_offline { 0 } else { parsed.size.unwrap_or(0) },
                modified: parsed.modified,
            })
        });
        entries.push(entry);
    }

    for (base, size) in continued {
        if let Some(Some(entry)) = entries.get_mut(base as usize) {
            if entry.size == 0 && !entry.is_dir && !offline.contains(&base) {
                entry.size = size;
            }
        }
    }
    entries
}

/// One contiguous piece of the table: where it sits in the table and on the volume, in clusters.
struct Extent {
    table_cluster: u64,
    disk_cluster: u64,
    clusters: u64,
}

struct Volume {
    file: File,
    geometry: Geometry,
}

impl Volume {
    fn open(drive: &Path) -> Result<Self, String> {
        let letter = drive
            .to_str()
            .and_then(|text| text.chars().next())
            .filter(char::is_ascii_alphabetic)
            .ok_or("not a lettered drive")?;
        let file = File::open(format!(r"\\.\{letter}:")).map_err(|e| format!("cannot open the volume: {e}"))?;
        let mut volume = Self { file, geometry: Geometry { cluster: 0, record: 0, table_at: 0 } };
        // Raw volume reads must cover whole sectors; 4096 bytes does for every sector size.
        let mut boot = vec![0u8; 4096];
        volume.read_at(0, &mut boot)?;
        volume.geometry = geometry(&boot)?;
        Ok(volume)
    }

    fn read_at(&mut self, offset: u64, buffer: &mut [u8]) -> Result<(), String> {
        self.file
            .seek(SeekFrom::Start(offset))
            .and_then(|_| self.file.read_exact(buffer))
            .map_err(|e| format!("cannot read the volume at {offset}: {e}"))
    }

    /// Reads the single record that starts `offset` bytes into the volume.
    fn record_at(&mut self, offset: u64) -> Result<Vec<u8>, String> {
        let cluster = self.geometry.cluster;
        let mut block = vec![0u8; cluster as usize];
        self.read_at(offset - offset % cluster, &mut block)?;
        let within = (offset % cluster) as usize;
        let mut record = block[within..within + self.geometry.record].to_vec();
        fix_up(&mut record).then_some(record).ok_or_else(|| "the file table's own record is damaged".to_string())
    }

    /// Works out where every piece of the table lies, from the table's own first record.
    fn table_layout(&mut self) -> Result<(Vec<Extent>, u64), String> {
        let cluster = self.geometry.cluster;
        let record_size = self.geometry.record as u64;
        let first = self.record_at(self.geometry.table_at)?;

        let mut extents: Vec<Extent> = Vec::new();
        let mut size = None;
        let mut elsewhere: Vec<u64> = Vec::new();
        let mut take_data = |record: &[u8], extents: &mut Vec<Extent>| -> Result<(), String> {
            for attr in attributes(record).filter(|a| a.kind == ATTR_DATA && a.is_unnamed()) {
                let mut table_cluster = attr.first_vcn().ok_or("the file table is stored inline")?;
                if table_cluster == 0 {
                    size = attr.real_size();
                }
                for (start, clusters) in attr.runs().ok_or("the file table's run list is malformed")? {
                    let disk_cluster = start.ok_or("the file table has a hole in it")?;
                    extents.push(Extent { table_cluster, disk_cluster, clusters });
                    table_cluster += clusters;
                }
            }
            Ok(())
        };
        take_data(&first, &mut extents)?;

        // A badly fragmented table lists further pieces in other records of itself.
        for attr in attributes(&first).filter(|a| a.kind == ATTR_ATTRIBUTE_LIST) {
            let list = attr.value().ok_or("the file table's attribute list is stored externally")?;
            let mut at = 0;
            while let (Some(kind), Some(length)) = (u32_at(list, at), u16_at(list, at + 4)) {
                let named = list.get(at + 6).is_some_and(|&n| n != 0);
                let holder = u64_at(list, at + 0x10).map_or(0, |r| r & RECORD_NUMBER);
                if kind == ATTR_DATA && !named && holder != 0 && !elsewhere.contains(&holder) {
                    elsewhere.push(holder);
                }
                if length == 0 {
                    break;
                }
                at += usize::from(length);
            }
        }
        for holder in elsewhere {
            // Each further record must lie in a piece already known, which NTFS guarantees.
            let table_byte = holder * record_size;
            let on_disk = extents
                .iter()
                .find(|e| (e.table_cluster..e.table_cluster + e.clusters).contains(&(table_byte / cluster)))
                .map(|e| (e.disk_cluster + table_byte / cluster - e.table_cluster) * cluster + table_byte % cluster)
                .ok_or("a piece of the file table cannot be located")?;
            let record = self.record_at(on_disk)?;
            take_data(&record, &mut extents)?;
        }

        extents.sort_unstable_by_key(|e| e.table_cluster);
        let mut expected = 0;
        for extent in &extents {
            if extent.table_cluster != expected {
                return Err("the file table's pieces do not line up".into());
            }
            expected += extent.clusters;
        }
        let size = size.ok_or("the file table's size is unknown")?;
        if size == 0 || size > expected * cluster {
            return Err("the file table's size does not match its pieces".into());
        }
        Ok((extents, size))
    }
}

/// Reads every file record of the NTFS volume mounted at `drive` (e.g. `C:\`).
///
/// Returns the entries indexed by record number and the position of the top folder.
pub fn read(
    drive: &Path,
    cancel: &AtomicBool,
    watcher: &dyn Watcher,
) -> Result<(Vec<Option<Entry>>, u32), String> {
    let mut volume = Volume::open(drive)?;
    let (extents, table_size) = volume.table_layout()?;
    let (cluster, record_size) = (volume.geometry.cluster, volume.geometry.record);

    let mut records: Vec<Option<Parsed>> = Vec::with_capacity((table_size / record_size as u64) as usize);
    let mut buffer = vec![0u8; CHUNK as usize];
    let mut left = table_size - table_size % record_size as u64;
    for extent in &extents {
        let mut at = extent.disk_cluster * cluster;
        let mut in_extent = (extent.clusters * cluster).min(left);
        while in_extent > 0 {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let wanted = in_extent.min(CHUNK);
            // The table's last cluster may be only partly used, but reads must be whole clusters.
            let chunk = &mut buffer[..wanted.next_multiple_of(cluster) as usize];
            volume.read_at(at, chunk)?;
            let parsed: Vec<Option<Parsed>> = chunk[..wanted as usize].par_chunks_mut(record_size).map(parse).collect();

            let files = parsed.iter().flatten().filter(|p| !p.is_dir && p.continues.is_none());
            let (count, bytes) = files.fold((0, 0), |(count, bytes), p| (count + 1, bytes + p.size.unwrap_or(0)));
            watcher.found(count, bytes, drive);
            records.extend(parsed);

            at += wanted;
            in_extent -= wanted;
            left -= wanted;
        }
    }

    let entries = assemble(records);
    let has_root = entries.get(ROOT_RECORD as usize).is_some_and(Option::is_some);
    if !has_root || entries.iter().flatten().count() < 2 {
        return Err("the file table holds no usable records".into());
    }
    Ok((entries, ROOT_RECORD))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECORD: usize = 1024;

    fn pad8(mut bytes: Vec<u8>) -> Vec<u8> {
        bytes.resize(bytes.len().next_multiple_of(8), 0);
        bytes
    }

    fn resident(kind: u32, value: &[u8]) -> Vec<u8> {
        let mut attr = vec![0u8; 0x18];
        attr[0..4].copy_from_slice(&kind.to_le_bytes());
        attr[0x10..0x14].copy_from_slice(&(value.len() as u32).to_le_bytes());
        attr[0x14..0x16].copy_from_slice(&0x18u16.to_le_bytes());
        attr.extend_from_slice(value);
        let mut attr = pad8(attr);
        let len = attr.len() as u32;
        attr[4..8].copy_from_slice(&len.to_le_bytes());
        attr
    }

    fn external_data(first_vcn: u64, real_size: u64, runs: &[u8]) -> Vec<u8> {
        let mut attr = vec![0u8; 0x40];
        attr[0..4].copy_from_slice(&ATTR_DATA.to_le_bytes());
        attr[8] = 1;
        attr[0x10..0x18].copy_from_slice(&first_vcn.to_le_bytes());
        attr[0x20..0x22].copy_from_slice(&0x40u16.to_le_bytes());
        attr[0x30..0x38].copy_from_slice(&real_size.to_le_bytes());
        attr.extend_from_slice(runs);
        attr.push(0);
        let mut attr = pad8(attr);
        let len = attr.len() as u32;
        attr[4..8].copy_from_slice(&len.to_le_bytes());
        attr
    }

    fn standard_information(modified_unix: i64, attributes: u32) -> Vec<u8> {
        let mut value = vec![0u8; 0x30];
        let filetime = (modified_unix + 11_644_473_600) as u64 * 10_000_000;
        value[8..16].copy_from_slice(&filetime.to_le_bytes());
        value[0x20..0x24].copy_from_slice(&attributes.to_le_bytes());
        resident(ATTR_STANDARD_INFORMATION, &value)
    }

    fn file_name(parent: u64, name: &str, namespace: u8) -> Vec<u8> {
        let units: Vec<u16> = name.encode_utf16().collect();
        let mut value = vec![0u8; 0x42];
        // The high 16 bits are a reuse counter and must be ignored.
        value[0..8].copy_from_slice(&(parent | 7 << 48).to_le_bytes());
        value[0x40] = units.len() as u8;
        value[0x41] = namespace;
        value.extend(units.iter().flat_map(|u| u.to_le_bytes()));
        resident(ATTR_FILE_NAME, &value)
    }

    fn reparse(tag: u32) -> Vec<u8> {
        resident(ATTR_REPARSE_POINT, &[tag.to_le_bytes().as_slice(), &[0; 12]].concat())
    }

    /// A record as it lies on disk, with the torn-write protection applied.
    fn record(flags: u16, continues: u64, attrs: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = vec![0u8; RECORD];
        bytes[0..4].copy_from_slice(b"FILE");
        bytes[4..6].copy_from_slice(&0x30u16.to_le_bytes());
        bytes[6..8].copy_from_slice(&3u16.to_le_bytes());
        bytes[0x14..0x16].copy_from_slice(&0x38u16.to_le_bytes());
        bytes[0x16..0x18].copy_from_slice(&flags.to_le_bytes());
        bytes[0x20..0x28].copy_from_slice(&continues.to_le_bytes());
        let mut at = 0x38;
        for attr in attrs {
            bytes[at..at + attr.len()].copy_from_slice(attr);
            at += attr.len();
        }
        bytes[at..at + 4].copy_from_slice(&ATTR_END.to_le_bytes());
        // Distinctive bytes at both protected spots, so the test can see them come back.
        bytes[510..512].copy_from_slice(&[0x11, 0x22]);
        bytes[1022..1024].copy_from_slice(&[0x33, 0x44]);
        for i in 1..3 {
            let end = i * FIXUP_STRIDE;
            let original = [bytes[end - 2], bytes[end - 1]];
            bytes[0x30 + 2 * i..0x32 + 2 * i].copy_from_slice(&original);
            bytes[end - 2..end].copy_from_slice(&[0xCD, 0xAB]);
        }
        bytes[0x30..0x32].copy_from_slice(&[0xCD, 0xAB]);
        bytes
    }

    #[test]
    fn fix_up_restores_the_protected_bytes_and_spots_damage() {
        let mut good = record(RECORD_IN_USE, 0, &[]);
        assert!(fix_up(&mut good));
        assert_eq!((&good[510..512], &good[1022..1024]), (&[0x11, 0x22][..], &[0x33, 0x44][..]));

        let mut torn = record(RECORD_IN_USE, 0, &[]);
        torn[1022] ^= 0xFF;
        assert!(!fix_up(&mut torn));

        let mut not_a_record = vec![0u8; RECORD];
        assert!(!fix_up(&mut not_a_record));
        assert!(!fix_up(&mut [0u8; 3]));
    }

    #[test]
    fn a_file_record_gives_name_parent_size_and_time() {
        let mut bytes = record(
            RECORD_IN_USE,
            0,
            &[
                standard_information(1_700_000_000, 0x20),
                file_name(41, "REPORT~1.DOC", NAMESPACE_DOS),
                file_name(41, "Report 2026 — підсумок.docx", 1),
                external_data(0, 123_456_789, &[0x21, 0x18, 0x34, 0x56]),
            ],
        );
        let parsed = parse(&mut bytes).unwrap();
        assert_eq!(parsed.name.as_deref(), Some("Report 2026 — підсумок.docx"));
        assert_eq!((parsed.parent, parsed.size, parsed.modified), (41, Some(123_456_789), 1_700_000_000));
        assert!(!parsed.is_dir && !parsed.is_link && !parsed.is_offline && parsed.continues.is_none());
    }

    #[test]
    fn small_files_folders_links_and_cloud_files_are_told_apart() {
        let inline = resident(ATTR_DATA, b"hello");
        let mut small = record(RECORD_IN_USE, 0, &[file_name(5, "a.txt", 3), inline]);
        assert_eq!(parse(&mut small).unwrap().size, Some(5));

        let mut folder = record(RECORD_IN_USE | RECORD_IS_DIRECTORY, 0, &[file_name(5, "Games", 3)]);
        let parsed = parse(&mut folder).unwrap();
        assert!(parsed.is_dir && parsed.size.is_none());

        let mut junction = record(RECORD_IN_USE | RECORD_IS_DIRECTORY, 0, &[file_name(5, "Link", 3), reparse(TAG_MOUNT_POINT)]);
        assert!(parse(&mut junction).unwrap().is_link);

        // A OneDrive placeholder is a reparse point too, but not a link, and takes no space.
        let cloud = [standard_information(0, 0x0040_0000), file_name(5, "photo.jpg", 3), reparse(0x9000_101A), external_data(0, 9_000_000, &[])];
        let parsed = parse(&mut record(RECORD_IN_USE, 0, &cloud)).unwrap();
        assert!(!parsed.is_link && parsed.is_offline);

        let mut unused = record(0, 0, &[file_name(5, "deleted.txt", 3)]);
        assert!(parse(&mut unused).is_none());

        // Only the first piece of a fragmented file states the size.
        let mut later_piece = record(RECORD_IN_USE, 77, &[external_data(4096, 1, &[])]);
        let parsed = parse(&mut later_piece).unwrap();
        assert_eq!((parsed.continues, parsed.size), (Some(77), None));
    }

    #[test]
    fn run_lists_decode_with_relative_and_negative_offsets() {
        // 0x18 clusters at 0x5634; then 0x10 clusters 16 earlier; then a 5-cluster hole.
        let runs = decode_runs(&[0x21, 0x18, 0x34, 0x56, 0x11, 0x10, 0xF0, 0x01, 0x05, 0x00]).unwrap();
        assert_eq!(runs, [(Some(0x5634), 0x18), (Some(0x5624), 0x10), (None, 5)]);

        assert_eq!(decode_runs(&[0x00]).unwrap(), []);
        assert!(decode_runs(&[0x21, 0x18, 0x34]).is_none(), "cut short");
        assert!(decode_runs(&[0x11, 0x01, 0x80, 0x00]).is_none(), "points before the volume start");
        assert!(decode_runs(&[]).is_none(), "no terminator");
    }

    #[test]
    fn boot_sector_geometry_is_read_and_checked() {
        let mut boot = vec![0u8; 512];
        boot[3..11].copy_from_slice(b"NTFS    ");
        boot[0x0B..0x0D].copy_from_slice(&512u16.to_le_bytes());
        boot[0x0D] = 8;
        boot[0x30..0x38].copy_from_slice(&786_432u64.to_le_bytes());
        boot[0x40] = (-10i8) as u8;
        assert_eq!(geometry(&boot), Ok(Geometry { cluster: 4096, record: 1024, table_at: 786_432 * 4096 }));

        boot[0x40] = 1; // one cluster per record
        assert_eq!(geometry(&boot).unwrap().record, 4096);

        boot[0x0D] = 1; // 512-byte clusters cannot hold a 1 KB record whole
        boot[0x40] = (-10i8) as u8;
        assert!(geometry(&boot).is_err());

        boot[3..11].copy_from_slice(b"EXFAT   ");
        assert!(geometry(&boot).is_err());
    }

    fn parsed(parent: u32, name: &str, is_dir: bool, size: Option<u64>) -> Option<Parsed> {
        Some(Parsed { is_dir, parent, name: Some(name.into()), size, ..Parsed::default() })
    }

    #[test]
    fn records_become_entries_without_system_files_or_links() {
        let mut records: Vec<Option<Parsed>> = (0..30).map(|_| None).collect();
        records[0] = parsed(5, "$MFT", false, Some(1_000_000));
        records[5] = parsed(5, ".", true, None);
        records[24] = parsed(5, "Games", true, None);
        records[25] = parsed(24, "big.pak", false, None);
        records[26] = Some(Parsed { continues: Some(25), size: Some(9_000), ..Parsed::default() });
        records[27] = Some(Parsed { is_link: true, ..parsed(5, "Documents and Settings", true, None).unwrap() });
        records[28] = Some(Parsed { is_offline: true, ..parsed(24, "cloud.jpg", false, Some(500)).unwrap() });
        records[29] = Some(Parsed { name: None, ..Parsed::default() });

        let entries = assemble(records);
        let kept: Vec<usize> = entries.iter().enumerate().filter(|(_, e)| e.is_some()).map(|(i, _)| i).collect();
        assert_eq!(kept, [5, 24, 25, 28]);
        assert_eq!(entries[25].as_ref().unwrap().size, 9_000, "the size came from the continuation record");
        assert_eq!(entries[28].as_ref().unwrap().size, 0, "cloud-only content takes no space");

        let index = crate::disk::DiskIndex::from_entries("C:", 1, entries, ROOT_RECORD);
        let summary = index.summary();
        assert_eq!((summary.bytes, summary.files, summary.folders), (9_000, 2, 1));
        assert_eq!(index.search("pak", 5).items[0].path, "C:\\Games\\big.pak");
    }
}

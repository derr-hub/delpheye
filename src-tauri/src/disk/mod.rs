//! The Disk module: an in-memory index of one drive that answers "what is taking the space?",
//! finds files by name instantly, spots duplicates, and can move chosen items to the Recycle Bin.
//!
//! The index is filled either from the NTFS file table (fast, administrators only) or by
//! walking the folders on every core. Indexing, searching and duplicate-finding only read;
//! the one thing here that changes the disk is [`disk_trash`].

mod dupes;
mod mft;
mod trash;

use std::collections::VecDeque;
use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use rayon::prelude::*;
use serde::Serialize;
use sysinfo::Disks;
use tauri::{AppHandle, Emitter, State};

use crate::journal::Journal;
use crate::system::{self, Dirs};

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
/// The file's content lives in the cloud and would have to be downloaded to be read.
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

const PROGRESS_EVENT: &str = "disk:progress";
const DUPES_EVENT: &str = "disk:dupes";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const NO_PARENT: u32 = u32::MAX;
/// How many of a folder's entries are sent to the UI; the rest are summed up as one remainder.
const CHILDREN_SENT: usize = 250;
/// How many duplicate groups are sent to the UI, the most wasteful first.
const GROUPS_SENT: usize = 300;

/// One file or folder. Names live in the index's shared text buffers, not per node.
struct Node {
    name: Span,
    /// The lower-cased name, kept separately so searching never has to convert anything.
    lower: Span,
    parent: u32,
    is_dir: bool,
    /// Moved to the Recycle Bin since the index was built.
    removed: bool,
    /// A file's own size, or everything inside for a folder. Cloud-only files count as zero.
    size: u64,
    /// Files inside, at any depth. Zero for a file.
    files: u32,
    /// Unix seconds; zero when unknown.
    modified: i64,
    /// How old the data is: a file's own time, or for a folder the average time of
    /// everything inside, weighted by size, so a fresh log file does not hide 100 GB of old data.
    mark: i64,
    /// A folder's entries sit next to each other, starting here.
    first_child: u32,
    child_count: u32,
}

#[derive(Clone, Copy)]
struct Span {
    at: u32,
    len: u16,
}

#[derive(Default)]
struct Builder {
    nodes: Vec<Node>,
    names: String,
    lower: String,
}

impl Builder {
    fn push(&mut self, name: &str, parent: u32, is_dir: bool, size: u64, modified: i64) -> u32 {
        fn append(buffer: &mut String, text: &str) -> Span {
            let at = buffer.len() as u32;
            // Windows caps a name at 255 UTF-16 units, which always fits; clamp regardless.
            let len = text.len().min(u16::MAX as usize);
            let len = (0..=len).rev().find(|&l| text.is_char_boundary(l)).unwrap_or(0);
            buffer.push_str(&text[..len]);
            Span { at, len: len as u16 }
        }
        let node = Node {
            name: append(&mut self.names, name),
            lower: append(&mut self.lower, &name.to_lowercase()),
            parent,
            is_dir,
            removed: false,
            size,
            files: 0,
            modified,
            mark: modified,
            first_child: 0,
            child_count: 0,
        };
        self.nodes.push(node);
        (self.nodes.len() - 1) as u32
    }

    /// Adds up folder sizes and seals the index.
    fn finish(self, id: u64, unreadable: u32, method: Method) -> DiskIndex {
        let Builder { mut nodes, names, lower } = self;
        // Size-weighted sums of modification times; empty files still count a little.
        let mut weight: Vec<f64> = nodes.iter().map(|n| if n.is_dir { 0.0 } else { n.size.max(1) as f64 }).collect();
        let mut weighted: Vec<f64> = nodes.iter().zip(&weight).map(|(n, w)| n.modified as f64 * w).collect();
        // A folder is always recorded before what it holds, so one pass from the end
        // carries every size up to its parent.
        for i in (1..nodes.len()).rev() {
            let (size, files, parent) = {
                let node = &nodes[i];
                (node.size, if node.is_dir { node.files } else { 1 }, node.parent as usize)
            };
            nodes[parent].size += size;
            nodes[parent].files += files;
            weight[parent] += weight[i];
            weighted[parent] += weighted[i];
        }
        for (i, node) in nodes.iter_mut().enumerate() {
            if node.is_dir && weight[i] > 0.0 {
                node.mark = (weighted[i] / weight[i]) as i64;
            }
        }
        DiskIndex { id, nodes, names, lower, unreadable, method, duration_ms: 0 }
    }
}

/// How an index was filled.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    /// Read straight from the NTFS file table.
    Mft,
    /// Walked folder by folder.
    Walk,
}

/// One file or folder as a source other than the walker describes it, e.g. an NTFS record.
pub struct Entry {
    /// Position of the parent folder in the same list.
    pub parent: u32,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
}

pub struct DiskIndex {
    id: u64,
    nodes: Vec<Node>,
    names: String,
    lower: String,
    /// Folders that could not be opened; their content is missing from the totals.
    unreadable: u32,
    method: Method,
    duration_ms: u64,
}

/// Receives news of indexing in progress. `()` ignores it.
pub trait Watcher: Sync {
    fn found(&self, _files: u64, _bytes: u64, _dir: &Path) {}
}

impl Watcher for () {}

struct Walk<'a> {
    builder: Mutex<Builder>,
    unreadable: AtomicU32,
    cancel: &'a AtomicBool,
    watcher: &'a dyn Watcher,
}

impl Walk<'_> {
    /// Records the entries of `dir` (node `id`) and hands each sub-folder to the thread pool.
    fn visit<'s>(&'s self, scope: &rayon::Scope<'s>, dir: PathBuf, id: u32) {
        if self.cancel.load(Ordering::Relaxed) {
            return;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            self.unreadable.fetch_add(1, Ordering::Relaxed);
            return;
        };

        // (name, is_dir, size, modified)
        let mut found: Vec<(String, bool, u64, i64)> = Vec::new();
        let (mut files, mut bytes) = (0u64, 0u64);
        for entry in entries.flatten() {
            // Entry metadata comes with the listing itself: no extra disk access per file.
            let Ok(md) = entry.metadata() else { continue };
            let attributes = md.file_attributes();
            // Links lead elsewhere; following them would count things twice or loop forever.
            if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                continue;
            }
            let is_dir = md.is_dir();
            let in_cloud = attributes & FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS != 0;
            let size = if is_dir || in_cloud { 0 } else { md.len() };
            let modified = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs() as i64);
            if !is_dir {
                files += 1;
                bytes += size;
            }
            found.push((entry.file_name().to_string_lossy().into_owned(), is_dir, size, modified));
        }
        self.watcher.found(files, bytes, &dir);

        let first = {
            let mut builder = self.builder.lock().unwrap();
            let first = builder.nodes.len() as u32;
            for (name, is_dir, size, modified) in &found {
                builder.push(name, id, *is_dir, *size, *modified);
            }
            builder.nodes[id as usize].first_child = first;
            builder.nodes[id as usize].child_count = found.len() as u32;
            first
        };

        for (offset, (name, is_dir, ..)) in found.into_iter().enumerate() {
            if is_dir {
                let child = dir.join(name);
                scope.spawn(move |scope| self.visit(scope, child, first + offset as u32));
            }
        }
    }
}

/// The name a root is shown under: `C:` for a drive, the full path for anything else.
fn root_label(root: &Path) -> String {
    root.to_string_lossy().trim_end_matches(['\\', '/']).to_string()
}

impl DiskIndex {
    /// Indexes everything below `root` by walking its folders. Returns `None` if cancelled.
    pub fn build(root: &Path, id: u64, cancel: &AtomicBool, watcher: &dyn Watcher) -> Option<Self> {
        let mut builder = Builder::default();
        builder.push(&root_label(root), NO_PARENT, true, 0, 0);

        let walk = Walk {
            builder: Mutex::new(builder),
            unreadable: AtomicU32::new(0),
            cancel,
            watcher,
        };
        rayon::scope(|scope| walk.visit(scope, root.to_path_buf(), 0));
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        let unreadable = walk.unreadable.into_inner();
        Some(walk.builder.into_inner().unwrap().finish(id, unreadable, Method::Walk))
    }

    /// Builds the index from a flat list in which each entry names its parent's position.
    ///
    /// `root` is the position of the top folder. Entries that do not hang off it, directly
    /// or through other entries, are left out.
    pub fn from_entries(label: &str, id: u64, entries: Vec<Option<Entry>>, root: u32) -> Self {
        // Group every entry under its parent: count, turn counts into offsets, then fill.
        let mut starts = vec![0u32; entries.len() + 1];
        let child_of = |at: usize, entry: &Entry| {
            let parent = entry.parent as usize;
            (parent < entries.len() && at != parent && at != root as usize).then_some(parent)
        };
        for (at, entry) in entries.iter().enumerate() {
            if let Some(parent) = entry.as_ref().and_then(|e| child_of(at, e)) {
                starts[parent + 1] += 1;
            }
        }
        for i in 1..starts.len() {
            starts[i] += starts[i - 1];
        }
        let mut children = vec![0u32; starts[entries.len()] as usize];
        let mut next = starts.clone();
        for (at, entry) in entries.iter().enumerate() {
            if let Some(parent) = entry.as_ref().and_then(|e| child_of(at, e)) {
                children[next[parent] as usize] = at as u32;
                next[parent] += 1;
            }
        }

        // Go level by level so that each folder's entries land next to each other.
        let mut builder = Builder::default();
        builder.push(label, NO_PARENT, true, 0, 0);
        let mut queue = VecDeque::from([(root as usize, 0u32)]);
        while let Some((at, node)) = queue.pop_front() {
            let kids = &children[starts[at] as usize..starts[at + 1] as usize];
            let first = builder.nodes.len() as u32;
            for (offset, &kid) in kids.iter().enumerate() {
                // Everything in `children` came from a filled slot.
                let entry = entries[kid as usize].as_ref().expect("grouped entries exist");
                builder.push(&entry.name, node, entry.is_dir, if entry.is_dir { 0 } else { entry.size }, entry.modified);
                if entry.is_dir {
                    queue.push_back((kid as usize, first + offset as u32));
                }
            }
            builder.nodes[node as usize].first_child = first;
            builder.nodes[node as usize].child_count = kids.len() as u32;
        }
        builder.finish(id, 0, Method::Mft)
    }

    fn name(&self, node: &Node) -> &str {
        &self.names[node.name.at as usize..node.name.at as usize + node.name.len as usize]
    }

    fn lower(&self, node: &Node) -> &str {
        &self.lower[node.lower.at as usize..node.lower.at as usize + node.lower.len as usize]
    }

    /// Whether `id` names something that is still there.
    fn is_live(&self, id: u32) -> bool {
        self.nodes.get(id as usize).is_some_and(|n| !n.removed)
    }

    /// The ids from the root down to `id`, inclusive.
    fn trail(&self, id: u32) -> Vec<u32> {
        let mut trail = vec![id];
        let mut at = id;
        while self.nodes[at as usize].parent != NO_PARENT {
            at = self.nodes[at as usize].parent;
            trail.push(at);
        }
        trail.reverse();
        trail
    }

    fn path(&self, id: u32) -> String {
        let parts: Vec<&str> = self.trail(id).iter().map(|&i| self.name(&self.nodes[i as usize])).collect();
        // A bare "C:" means "current folder on C"; the drive itself is "C:\".
        if parts.len() == 1 { format!("{}\\", parts[0]) } else { parts.join("\\") }
    }

    fn item(&self, id: u32) -> Item {
        let node = &self.nodes[id as usize];
        Item {
            id,
            name: self.name(node).to_string(),
            path: self.path(id),
            is_dir: node.is_dir,
            size: node.size,
            files: node.files,
            modified: node.modified,
            mark: node.mark,
        }
    }

    /// The folder `id` and what is inside it, `depth` levels down, for the ring chart.
    /// Entries smaller than `min_share` of the whole are folded into one remainder per folder.
    pub fn rings(&self, id: u32, depth: u32, min_share: f64) -> Option<Ring> {
        let node = self.nodes.get(id as usize).filter(|n| n.is_dir && !n.removed)?;
        let floor = (node.size as f64 * min_share) as u64;
        Some(self.ring(id, depth, floor))
    }

    fn ring(&self, id: u32, depth: u32, floor: u64) -> Ring {
        let node = &self.nodes[id as usize];
        let mut ring = Ring {
            id,
            name: self.name(node).to_string(),
            size: node.size,
            is_dir: node.is_dir,
            mark: node.mark,
            children: Vec::new(),
            rest_size: 0,
            rest_count: 0,
        };
        if !node.is_dir || depth == 0 {
            return ring;
        }
        let mut ids: Vec<u32> = (node.first_child..node.first_child + node.child_count)
            .filter(|&i| !self.nodes[i as usize].removed && self.nodes[i as usize].size > 0)
            .collect();
        ids.sort_unstable_by_key(|&i| std::cmp::Reverse(self.nodes[i as usize].size));
        for child in ids {
            let size = self.nodes[child as usize].size;
            if size >= floor.max(1) {
                ring.children.push(self.ring(child, depth - 1, floor));
            } else {
                ring.rest_size += size;
                ring.rest_count += 1;
            }
        }
        ring
    }

    pub fn summary(&self) -> Summary {
        let root = &self.nodes[0];
        Summary {
            index_id: self.id,
            root: self.path(0),
            bytes: root.size,
            files: root.files as u64,
            folders: self.nodes.iter().filter(|n| n.is_dir && !n.removed).count() as u64 - 1,
            unreadable: self.unreadable,
            duration_ms: self.duration_ms,
            method: self.method,
            elevated: system::is_elevated(),
        }
    }

    /// A folder's entries, biggest first, with the way back up to the root.
    pub fn folder(&self, id: u32) -> Option<Folder> {
        let node = self.nodes.get(id as usize).filter(|n| n.is_dir && !n.removed)?;
        let mut ids: Vec<u32> = (node.first_child..node.first_child + node.child_count)
            .filter(|&i| !self.nodes[i as usize].removed)
            .collect();
        ids.sort_unstable_by_key(|&i| std::cmp::Reverse(self.nodes[i as usize].size));
        let rest = ids.split_off(ids.len().min(CHILDREN_SENT));
        Some(Folder {
            trail: self
                .trail(id)
                .into_iter()
                .map(|i| Crumb { id: i, name: self.name(&self.nodes[i as usize]).to_string() })
                .collect(),
            item: self.item(id),
            children: ids.into_iter().map(|i| self.item(i)).collect(),
            more_count: rest.len() as u32,
            more_bytes: rest.iter().map(|&i| self.nodes[i as usize].size).sum(),
        })
    }

    /// The ids of everything still there except the root, filtered by `keep`.
    fn live(&self, keep: impl Fn(&Node) -> bool + Sync) -> Vec<u32> {
        (1..self.nodes.len() as u32)
            .into_par_iter()
            .filter(|&i| {
                let node = &self.nodes[i as usize];
                !node.removed && keep(node)
            })
            .collect()
    }

    /// The biggest files on the drive, largest first.
    pub fn largest(&self, limit: usize) -> Vec<Item> {
        self.top(self.live(|node| !node.is_dir), limit)
    }

    /// Files and folders whose name contains every word of `query`, biggest first.
    pub fn search(&self, query: &str, limit: usize) -> Found {
        let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        if words.is_empty() {
            return Found { total: 0, items: Vec::new() };
        }
        let hits = self.live(|node| {
            let name = self.lower(node);
            words.iter().all(|word| name.contains(word.as_str()))
        });
        Found {
            total: hits.len() as u64,
            items: self.top(hits, limit),
        }
    }

    fn top(&self, mut ids: Vec<u32>, limit: usize) -> Vec<Item> {
        let by_size = |i: &u32| std::cmp::Reverse(self.nodes[*i as usize].size);
        if ids.len() > limit {
            ids.select_nth_unstable_by_key(limit, by_size);
            ids.truncate(limit);
        }
        ids.sort_unstable_by_key(by_size);
        ids.into_iter().map(|i| self.item(i)).collect()
    }

    /// Files of at least `min_size` bytes that share their exact size with another file,
    /// as `(id, size, path)`. Only these can possibly be duplicates.
    pub fn same_size_files(&self, min_size: u64) -> Vec<(u32, u64, PathBuf)> {
        let mut files = self.live(|node| !node.is_dir && node.size >= min_size.max(1));
        files.sort_unstable_by_key(|&i| self.nodes[i as usize].size);
        let size = |i: u32| self.nodes[i as usize].size;
        files
            .iter()
            .enumerate()
            .filter(|&(at, &id)| {
                (at > 0 && size(files[at - 1]) == size(id)) || files.get(at + 1).is_some_and(|&n| size(n) == size(id))
            })
            .map(|(_, &id)| (id, size(id), PathBuf::from(self.path(id))))
            .collect()
    }

    /// Forgets `id` and everything inside it, taking their size off every folder above.
    pub fn remove(&mut self, id: u32) {
        if id == 0 || !self.is_live(id) {
            return;
        }
        let (size, files) = {
            let node = &self.nodes[id as usize];
            (node.size, if node.is_dir { node.files } else { 1 })
        };
        let mut pending = vec![id];
        while let Some(at) = pending.pop() {
            let node = &mut self.nodes[at as usize];
            node.removed = true;
            if node.is_dir {
                pending.extend(node.first_child..node.first_child + node.child_count);
            }
        }
        let mut at = self.nodes[id as usize].parent;
        while at != NO_PARENT {
            let node = &mut self.nodes[at as usize];
            node.size = node.size.saturating_sub(size);
            node.files = node.files.saturating_sub(files);
            at = node.parent;
        }
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    id: u32,
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    files: u32,
    modified: i64,
    mark: i64,
}

/// A folder and its contents a few levels down, for the ring chart.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Ring {
    id: u32,
    name: String,
    size: u64,
    is_dir: bool,
    mark: i64,
    children: Vec<Ring>,
    /// Entries too small to draw, summed up.
    rest_size: u64,
    rest_count: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Crumb {
    id: u32,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    trail: Vec<Crumb>,
    item: Item,
    children: Vec<Item>,
    /// Entries left out of `children` because the folder has too many, and their combined size.
    more_count: u32,
    more_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    total: u64,
    items: Vec<Item>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    index_id: u64,
    root: String,
    bytes: u64,
    files: u64,
    folders: u64,
    unreadable: u32,
    duration_ms: u64,
    method: Method,
    elevated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    mount: String,
    name: String,
    file_system: String,
    total: u64,
    available: u64,
    removable: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    files: u64,
    bytes: u64,
    path: String,
}

/// Forwards indexing progress to the UI at a steady pace.
struct Reporter {
    app: AppHandle,
    files: AtomicU64,
    bytes: AtomicU64,
    last_sent: Mutex<Instant>,
}

impl Reporter {
    fn new(app: AppHandle) -> Self {
        Self {
            app,
            files: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            last_sent: Mutex::new(Instant::now()),
        }
    }
}

impl Watcher for Reporter {
    fn found(&self, files: u64, bytes: u64, dir: &Path) {
        let files = self.files.fetch_add(files, Ordering::Relaxed) + files;
        let bytes = self.bytes.fetch_add(bytes, Ordering::Relaxed) + bytes;
        let Ok(mut last_sent) = self.last_sent.try_lock() else {
            return;
        };
        if last_sent.elapsed() >= PROGRESS_INTERVAL {
            *last_sent = Instant::now();
            let _ = self.app.emit(PROGRESS_EVENT, ProgressEvent { files, bytes, path: dir.display().to_string() });
        }
    }
}

#[derive(Default)]
pub struct DiskState {
    index: RwLock<Option<DiskIndex>>,
    cancel: Arc<AtomicBool>,
    busy: AtomicBool,
    last_id: AtomicU64,
}

impl DiskState {
    fn read<T>(&self, ask: impl FnOnce(&DiskIndex) -> T) -> Result<T, String> {
        self.index.read().unwrap().as_ref().map(ask).ok_or_else(|| "no-index".to_string())
    }
}

/// Holds the module's "busy" flag; indexing, duplicate search and trashing never overlap.
struct Busy<'a>(&'a AtomicBool);

impl<'a> Busy<'a> {
    fn claim(flag: &'a AtomicBool) -> Result<Self, String> {
        if flag.swap(true, Ordering::SeqCst) { Err("busy".into()) } else { Ok(Self(flag)) }
    }
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Whether `path` is something DelphEye never moves or deletes (Windows, whole profiles…).
pub fn is_protected(path: &Path, dirs: &Dirs) -> bool {
    trash::refusal(path, dirs).is_some()
}

/// The drives that can be indexed.
#[tauri::command]
pub fn disk_drives() -> Result<Vec<Drive>, String> {
    let disks = Disks::new_with_refreshed_list().map_err(|e| e.to_string())?;
    Ok(disks
        .iter()
        .map(|d| Drive {
            mount: d.mount_point().to_string_lossy().into_owned(),
            name: d.name().to_string_lossy().into_owned(),
            file_system: d.file_system().to_string_lossy().into_owned(),
            total: d.total_space(),
            available: d.available_space(),
            removable: d.is_removable(),
        })
        .collect())
}

/// Indexes a whole drive, replacing any earlier index. Errors: `"busy"`, `"cancelled"`, `"bad-drive"`.
///
/// With administrator rights an NTFS drive is read from its file table; if that is not
/// possible for any reason, the folders are walked instead.
#[tauri::command]
pub async fn disk_index(app: AppHandle, state: State<'_, DiskState>, drive: String) -> Result<Summary, String> {
    let _busy = Busy::claim(&state.busy)?;
    let root = PathBuf::from(&drive);
    if !(root.is_absolute() && root.parent().is_none()) {
        return Err("bad-drive".into());
    }
    // Free the old index first: two of them at once would double the memory needed.
    *state.index.write().unwrap() = None;
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();
    let id = state.last_id.fetch_add(1, Ordering::SeqCst) + 1;

    let built = tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let reporter = Reporter::new(app);
        let from_table = system::is_elevated()
            .then(|| mft::read(&root, &cancel, &reporter))
            .and_then(|read| read.inspect_err(|why| eprintln!("disk: file table unavailable, walking instead: {why}")).ok())
            .map(|(entries, top)| DiskIndex::from_entries(&root_label(&root), id, entries, top));
        let mut index = match from_table {
            Some(_) if cancel.load(Ordering::Relaxed) => return None,
            Some(index) => index,
            None => DiskIndex::build(&root, id, &cancel, &reporter)?,
        };
        index.duration_ms = started.elapsed().as_millis() as u64;
        Some(index)
    })
    .await
    .map_err(|e| e.to_string())?;

    let index = built.ok_or("cancelled")?;
    let summary = index.summary();
    *state.index.write().unwrap() = Some(index);
    Ok(summary)
}

/// Stops indexing or a duplicate search in progress.
#[tauri::command]
pub fn disk_cancel(state: State<'_, DiskState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn disk_folder(state: State<'_, DiskState>, id: u32) -> Result<Folder, String> {
    state.read(|index| index.folder(id))?.ok_or_else(|| "not-a-folder".to_string())
}

#[tauri::command(async)]
pub fn disk_rings(state: State<'_, DiskState>, id: u32) -> Result<Ring, String> {
    state.read(|index| index.rings(id, 3, 0.004))?.ok_or_else(|| "not-a-folder".to_string())
}

#[tauri::command(async)]
pub fn disk_largest(state: State<'_, DiskState>, limit: usize) -> Result<Vec<Item>, String> {
    state.read(|index| index.largest(limit.min(1000)))
}

#[tauri::command(async)]
pub fn disk_search(state: State<'_, DiskState>, query: String, limit: usize) -> Result<Found, String> {
    state.read(|index| index.search(&query, limit.min(1000)))
}

/// Files with identical content. Every item of a group is the same size.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupeGroup {
    size: u64,
    items: Vec<Item>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dupes {
    groups: Vec<DupeGroup>,
    /// Groups found in total; `groups` holds only the most wasteful ones.
    total_groups: u64,
    /// Space that would be freed by keeping one copy from every group found.
    wasted_bytes: u64,
    duration_ms: u64,
}

/// Finds files of at least `min_size` bytes with identical content, by reading and hashing
/// the candidates. Changes nothing. Errors: `"busy"`, `"cancelled"`, `"no-index"`.
#[tauri::command]
pub async fn disk_duplicates(app: AppHandle, state: State<'_, DiskState>, min_size: u64) -> Result<Dupes, String> {
    let _busy = Busy::claim(&state.busy)?;
    let started = Instant::now();
    let (index_id, mut candidates) = state.read(|index| (index.id, index.same_size_files(min_size)))?;
    // Windows and installers keep deliberate second copies of drivers and packages in their
    // own folders. Those are not the user's to tidy up, so they are not offered at all.
    if let Some(dirs) = Dirs::real() {
        candidates.retain(|(_, _, path)| !trash::is_system_managed(path, &dirs));
    }
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();

    let found = tauri::async_runtime::spawn_blocking(move || {
        let last_sent = Mutex::new(Instant::now());
        dupes::find(candidates, &cancel, &|progress: dupes::Progress| {
            let Ok(mut last_sent) = last_sent.try_lock() else { return };
            if last_sent.elapsed() >= PROGRESS_INTERVAL {
                *last_sent = Instant::now();
                let _ = app.emit(DUPES_EVENT, progress);
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .ok_or("cancelled")?;

    state.read(|index| {
        // The hashing ran without holding the index; make sure it is still the same one.
        if index.id != index_id {
            return Err("no-index".to_string());
        }
        let mut groups: Vec<DupeGroup> = found
            .into_iter()
            .map(|ids| ids.into_iter().filter(|&id| index.is_live(id)).map(|id| index.item(id)).collect::<Vec<_>>())
            .filter(|items| items.len() > 1)
            .map(|items| DupeGroup { size: items[0].size, items })
            .collect();
        let wasted = |group: &DupeGroup| group.size * (group.items.len() as u64 - 1);
        groups.sort_unstable_by_key(|group| std::cmp::Reverse(wasted(group)));
        let total_groups = groups.len() as u64;
        let wasted_bytes = groups.iter().map(wasted).sum();
        groups.truncate(GROUPS_SENT);
        Ok(Dupes { groups, total_groups, wasted_bytes, duration_ms: started.elapsed().as_millis() as u64 })
    })?
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrashFailure {
    path: String,
    /// `"protected"` or `"failed"`.
    reason: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashReport {
    /// Ids that are no longer on the disk, and so no longer in the index.
    trashed: Vec<u32>,
    freed_bytes: u64,
    failed: Vec<TrashFailure>,
    summary: Summary,
}

/// Moves the given files and folders to the Recycle Bin and records it in the journal.
///
/// The UI sends ids from the current index, never paths. System folders and files are refused.
/// Errors: `"busy"`, `"no-index"`.
#[tauri::command]
pub async fn disk_trash(
    state: State<'_, DiskState>,
    journal: State<'_, Journal>,
    ids: Vec<u32>,
) -> Result<TrashReport, String> {
    let _busy = Busy::claim(&state.busy)?;
    let dirs = Dirs::real().ok_or("environment")?;
    let wanted: Vec<Item> = state.read(|index| {
        // Something inside a folder that is also being trashed goes with that folder.
        let covered = |id: u32| index.trail(id).iter().rev().skip(1).any(|ancestor| ids.contains(ancestor));
        ids.iter().filter(|&&id| id != 0 && index.is_live(id) && !covered(id)).map(|&id| index.item(id)).collect()
    })?;

    // Ok(true): moved to the bin. Ok(false): it was already gone.
    let results: Vec<(Item, Result<bool, &'static str>)> = tauri::async_runtime::spawn_blocking(move || {
        wanted
            .into_iter()
            .map(|item| {
                let path = PathBuf::from(&item.path);
                let outcome = if trash::refusal(&path, &dirs).is_some() {
                    Err("protected")
                } else if !path.exists() {
                    Ok(false)
                } else if trash::recycle(&path) {
                    Ok(true)
                } else {
                    Err("failed")
                };
                (item, outcome)
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?;

    let mut slot = state.index.write().unwrap();
    let index = slot.as_mut().ok_or("no-index")?;
    let (mut trashed, mut failed, mut recorded, mut freed_bytes) = (Vec::new(), Vec::new(), Vec::new(), 0u64);
    for (item, outcome) in results {
        match outcome {
            Ok(moved) => {
                index.remove(item.id);
                trashed.push(item.id);
                if moved {
                    freed_bytes += item.size;
                    recorded.push(serde_json::json!({ "path": item.path, "bytes": item.size, "isDir": item.is_dir }));
                }
            }
            Err(reason) => failed.push(TrashFailure { path: item.path, reason }),
        }
    }
    let summary = index.summary();
    drop(slot);

    if !recorded.is_empty() || !failed.is_empty() {
        let details = serde_json::json!({ "items": recorded, "failed": failed });
        let _ = journal
            .add("trash", freed_bytes, recorded.len() as u64, failed.len() as u64, &details)
            .inspect_err(|e| eprintln!("journal: cannot record trashing: {e}"));
    }
    Ok(TrashReport { trashed, freed_bytes, failed, summary })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cleanup::testing::{Sandbox, junction, write};

    fn index(root: &Path) -> DiskIndex {
        DiskIndex::build(root, 1, &AtomicBool::new(false), &()).unwrap()
    }

    fn names(items: &[Item]) -> Vec<&str> {
        items.iter().map(|i| i.name.as_str()).collect()
    }

    /// docs/{report.pdf 300, Notes.TXT 50, deep/a/b/video.mkv 9000}, music/song.mp3 4000, empty/
    fn tree(sandbox: &Sandbox) -> PathBuf {
        let root = sandbox.root.join("drive");
        write(&root.join("docs").join("report.pdf"), 300);
        write(&root.join("docs").join("Notes.TXT"), 50);
        write(&root.join("docs").join("deep").join("a").join("b").join("video.mkv"), 9_000);
        write(&root.join("music").join("song.mp3"), 4_000);
        fs::create_dir_all(root.join("empty")).unwrap();
        root
    }

    #[test]
    fn folder_sizes_add_up_from_the_bottom() {
        let sandbox = Sandbox::new();
        let index = index(&tree(&sandbox));
        let summary = index.summary();
        assert_eq!((summary.bytes, summary.files, summary.folders, summary.unreadable), (13_350, 4, 6, 0));
        assert_eq!(summary.method, Method::Walk);

        let top = index.folder(0).unwrap();
        assert_eq!(names(&top.children), ["docs", "music", "empty"]);
        assert_eq!((top.children[0].size, top.children[0].files), (9_350, 3));
        assert_eq!((top.more_count, top.more_bytes), (0, 0));

        let docs = index.folder(top.children[0].id).unwrap();
        assert_eq!(names(&docs.children), ["deep", "report.pdf", "Notes.TXT"]);
        assert_eq!(docs.trail.len(), 2);
        assert!(docs.item.path.ends_with("drive\\docs"));
        assert!(index.folder(docs.children[1].id).is_none(), "a file is not a folder");
    }

    #[test]
    fn folder_age_is_weighted_by_size() {
        let sandbox = Sandbox::new();
        let root = sandbox.root.join("drive");
        write(&root.join("archive").join("old-big.bin"), 9_000);
        crate::cleanup::testing::age(&root.join("archive").join("old-big.bin"), 1_000);
        write(&root.join("archive").join("fresh-small.log"), 1_000);
        let index = index(&root);
        let archive = index.search("archive", 1).items[0].clone();
        let now = crate::leftovers::quarantine::now();
        let age_days = (now - archive.mark) / 86_400;
        // 90% of the bytes are 1000 days old, so the folder reads as about 900 days old.
        assert!((850..=950).contains(&age_days), "age was {age_days} days");
    }

    #[test]
    fn rings_go_a_few_levels_down_and_fold_small_things() {
        let sandbox = Sandbox::new();
        let root = tree(&sandbox);
        for i in 0..5 {
            write(&root.join("music").join(format!("tiny-{i}.txt")), 1);
        }
        let index = index(&root);
        let rings = index.rings(0, 2, 0.01).unwrap();
        assert_eq!(rings.size, 13_355);
        let names: Vec<&str> = rings.children.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["docs", "music"], "an empty folder takes no room");
        let docs = &rings.children[0];
        assert_eq!(docs.children.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["deep", "report.pdf"]);
        assert_eq!((docs.rest_count, docs.rest_size), (1, 50), "Notes.TXT is 50 bytes, under 1% of 13 355");
        assert!(docs.children[0].children.is_empty(), "depth stops at two levels");
        let music = &rings.children[1];
        assert_eq!((music.rest_count, music.rest_size), (5, 5), "the tiny files are folded together");
        assert!(index.rings(docs.children[1].id, 2, 0.01).is_none(), "a file has no rings");
    }

    #[test]
    fn largest_lists_files_only_in_order() {
        let sandbox = Sandbox::new();
        let index = index(&tree(&sandbox));
        assert_eq!(names(&index.largest(3)), ["video.mkv", "song.mp3", "report.pdf"]);
        assert!(index.largest(3)[0].path.ends_with("docs\\deep\\a\\b\\video.mkv"));
        assert_eq!(index.largest(100).len(), 4);
    }

    #[test]
    fn search_ignores_case_and_needs_every_word() {
        let sandbox = Sandbox::new();
        let index = index(&tree(&sandbox));
        assert_eq!(names(&index.search("NOTES", 10).items), ["Notes.TXT"]);
        assert_eq!(names(&index.search("o", 10).items), ["docs", "video.mkv", "song.mp3", "report.pdf", "Notes.TXT"]);
        assert_eq!(names(&index.search("re pdf", 10).items), ["report.pdf"]);
        assert_eq!(index.search("o", 2).total, 5, "the total counts matches beyond the limit");
        assert_eq!(index.search("  ", 10).total, 0);
        assert_eq!(index.search("nothing-like-this", 10).total, 0);
    }

    #[test]
    fn links_are_not_followed() {
        let sandbox = Sandbox::new();
        let root = tree(&sandbox);
        junction(&root.join("shortcut-to-music"), &root.join("music"));
        let index = index(&root);
        assert_eq!(index.summary().bytes, 13_350, "music is counted once");
        assert_eq!(index.search("shortcut", 10).total, 0);
    }

    #[test]
    fn a_cancelled_walk_yields_nothing() {
        let sandbox = Sandbox::new();
        assert!(DiskIndex::build(&tree(&sandbox), 1, &AtomicBool::new(true), &()).is_none());
    }

    #[test]
    fn a_drive_root_is_shown_with_its_backslash() {
        let index = DiskIndex::from_entries("C:", 1, vec![Some(entry(0, "", true, 0)), Some(entry(0, "Users", true, 0))], 0);
        assert_eq!(index.path(0), "C:\\");
        assert_eq!(index.path(1), "C:\\Users");
    }

    #[test]
    fn removing_a_folder_takes_its_size_off_everything_above() {
        let sandbox = Sandbox::new();
        let mut index = index(&tree(&sandbox));
        let deep = index.search("deep", 1).items[0].id;
        index.remove(deep);

        let summary = index.summary();
        assert_eq!((summary.bytes, summary.files, summary.folders), (4_350, 3, 3));
        assert_eq!(names(&index.largest(10)), ["song.mp3", "report.pdf", "Notes.TXT"]);
        assert_eq!(index.search("video", 10).total, 0, "what was inside is gone too");
        assert!(index.folder(deep).is_none());
        let docs = index.search("docs", 1).items[0].clone();
        assert_eq!((docs.size, docs.files), (350, 2));
        assert_eq!(names(&index.folder(docs.id).unwrap().children), ["report.pdf", "Notes.TXT"]);

        index.remove(deep);
        index.remove(0);
        assert_eq!(index.summary().bytes, 4_350, "removing twice, or the root, changes nothing");
    }

    #[test]
    fn only_files_sharing_a_size_are_duplicate_candidates() {
        let sandbox = Sandbox::new();
        let root = tree(&sandbox);
        write(&root.join("copy").join("song-copy.mp3"), 4_000);
        write(&root.join("copy").join("tiny-a"), 5);
        write(&root.join("copy").join("tiny-b"), 5);
        let index = index(&root);

        let found = index.same_size_files(100);
        let mut found_names: Vec<String> =
            found.iter().map(|(_, _, p)| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        found_names.sort();
        assert_eq!(found_names, ["song-copy.mp3", "song.mp3"]);
        assert!(found.iter().all(|(_, size, _)| *size == 4_000));
        assert_eq!(index.same_size_files(1).len(), 4, "a lower threshold lets the tiny pair in");
    }

    fn entry(parent: u32, name: &str, is_dir: bool, size: u64) -> Entry {
        Entry { parent, name: name.into(), is_dir, size, modified: 0 }
    }

    #[test]
    fn a_flat_list_becomes_the_same_tree() {
        // Positions are NTFS-style record numbers: the root is its own parent, gaps are unused.
        let entries = vec![
            Some(entry(2, "b.bin", false, 700)),  // 0, in docs
            None,                                 // 1
            Some(entry(5, "docs", true, 999)),    // 2, a folder's own size is ignored
            Some(entry(5, "a.txt", false, 100)),  // 3
            Some(entry(9, "lost.txt", false, 5)), // 4, parent is not in the list
            Some(entry(5, "", true, 0)),          // 5, root
            Some(entry(2, "c.bin", false, 200)),  // 6, in docs
            Some(entry(1, "orphan", false, 50)),  // 7, parent is an unused slot
        ];
        let index = DiskIndex::from_entries("X:", 3, entries, 5);
        let summary = index.summary();
        assert_eq!((summary.bytes, summary.files, summary.folders, summary.method), (1_000, 3, 1, Method::Mft));

        let top = index.folder(0).unwrap();
        assert_eq!(names(&top.children), ["docs", "a.txt"]);
        let docs = index.folder(top.children[0].id).unwrap();
        assert_eq!(names(&docs.children), ["b.bin", "c.bin"]);
        assert_eq!(docs.children[0].path, "X:\\docs\\b.bin");
        assert_eq!(index.search("lost", 5).total + index.search("orphan", 5).total, 0);
    }
}

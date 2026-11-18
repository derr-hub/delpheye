//! App leftovers: folders and registry entries that programs left behind when uninstalled.
//!
//! A folder is a candidate only if nothing installed, running or registered as a service
//! claims it, and nothing has touched it for a while. How sure we are depends on how long it
//! has been idle and whether it still holds programs. Nothing is deleted from here: chosen
//! leftovers go to quarantine for a week, from where they can be put back.

mod installed;
mod matcher;
pub mod quarantine;

pub use installed::command_path;

use std::collections::BTreeMap;
use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, UNIX_EPOCH};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter, State};

use crate::journal::Journal;
use crate::system::{self, Dirs};
use installed::{BrokenEntry, Installed};
use matcher::Owners;
use quarantine::now;

const PROGRESS_EVENT: &str = "leftovers:progress";
const DAY: i64 = 86_400;
/// Anything touched more recently than this is clearly still used by something.
const BUSY_DAYS: i64 = 7;
/// Idle for less than this, a folder may belong to something used now and then.
const QUIET_DAYS: i64 = 60;
/// Idle for longer than this, a folder with no programs inside is almost surely abandoned.
const ABANDONED_DAYS: i64 = 180;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Area {
    ProgramFiles,
    ProgramData,
    AppData,
}

/// What is inside one candidate folder.
#[derive(Default, Debug)]
struct Measure {
    bytes: u64,
    files: u64,
    /// Unix seconds of the most recent change anywhere inside.
    last_used: i64,
    has_programs: bool,
    /// Something inside is named like saved games; those are worth keeping even when the game is gone.
    has_saves: bool,
}

fn touched(md: &fs::Metadata) -> i64 {
    [md.created(), md.modified()]
        .into_iter()
        .flatten()
        .filter_map(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .max()
        .unwrap_or(0)
}

fn is_reparse(md: &fs::Metadata) -> bool {
    md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn measure(dir: &Path, cancel: &AtomicBool) -> Measure {
    let mut found = Measure { last_used: fs::metadata(dir).map_or(0, |md| touched(&md)), ..Measure::default() };
    let mut pending = vec![dir.to_path_buf()];
    while let Some(dir) = pending.pop() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(md) = entry.metadata() else { continue };
            if is_reparse(&md) {
                continue;
            }
            found.last_used = found.last_used.max(touched(&md));
            let name = entry.file_name().to_string_lossy().to_lowercase();
            found.has_saves |= name.contains("save");
            if md.is_dir() {
                pending.push(entry.path());
            } else {
                found.bytes += md.len();
                found.files += 1;
                found.has_programs |= [".exe", ".dll", ".sys"].iter().any(|ext| name.ends_with(ext));
            }
        }
    }
    found
}

/// How sure we are that a folder is abandoned, or `None` if it is clearly still in use.
fn confidence(found: &Measure, area: Area, now: i64) -> Option<Confidence> {
    let idle_days = (now - found.last_used) / DAY;
    if idle_days < BUSY_DAYS {
        return None;
    }
    let sure = if found.files == 0 {
        Confidence::High
    } else if idle_days < QUIET_DAYS {
        Confidence::Low
    } else if found.has_programs {
        // Programs sitting in Program Files with no entry anywhere may be installed by hand.
        if area == Area::AppData { Confidence::Medium } else { Confidence::Low }
    } else if idle_days >= ABANDONED_DAYS {
        Confidence::High
    } else {
        Confidence::Medium
    };
    // Saved games outlive the game: never offer them as a sure thing.
    Some(if found.has_saves { sure.min(Confidence::Medium) } else { sure })
}

/// Folders whose sub-folders are the candidates.
fn roots(dirs: &Dirs) -> Vec<(PathBuf, Area, bool)> {
    let mut roots: Vec<(PathBuf, Area, bool)> = Vec::new();
    for folder in &dirs.program_files {
        let duplicate = roots.iter().any(|(r, ..)| r.to_string_lossy().eq_ignore_ascii_case(&folder.to_string_lossy()));
        if !duplicate {
            roots.push((folder.clone(), Area::ProgramFiles, true));
        }
    }
    roots.push((dirs.program_data.clone(), Area::ProgramData, true));
    for folder in [dirs.local.clone(), dirs.local.join("Programs"), dirs.roaming.clone(), dirs.home.join("AppData").join("LocalLow")] {
        roots.push((folder, Area::AppData, false));
    }
    roots
}

#[derive(Debug)]
struct Candidate {
    name: String,
    path: PathBuf,
    area: Area,
    needs_admin: bool,
}

fn candidates(dirs: &Dirs) -> Vec<Candidate> {
    let mut found = Vec::new();
    for (root, area, needs_admin) in roots(dirs) {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_folder = entry.metadata().is_ok_and(|md| md.is_dir() && !is_reparse(&md));
            if is_folder && !matcher::is_reserved(&name) {
                found.push(Candidate { name, path: entry.path(), area, needs_admin });
            }
        }
    }
    found
}

/// What is installed, read from the registry, or from `installed.json` in the sandbox.
struct Machine {
    installed: Vec<Installed>,
    broken: Vec<BrokenEntry>,
    services: Vec<PathBuf>,
    running_paths: Vec<PathBuf>,
    running_names: Vec<String>,
    /// Registry access, absent in the sandbox.
    registry: bool,
}

impl Machine {
    fn detect(dirs: &Dirs) -> Self {
        if let Some(root) = &dirs.sandbox {
            let installed = fs::read(root.join("installed.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
            return Self { installed, broken: Vec::new(), services: Vec::new(), running_paths: Vec::new(), running_names: Vec::new(), registry: false };
        }
        let (installed, broken) = installed::from_registry();
        let (running_paths, running_names) = running();
        Self { installed, broken, services: installed::service_folders(), running_paths, running_names, registry: true }
    }

    fn owners(&self) -> Owners {
        let folders: Vec<PathBuf> = self.services.iter().chain(&self.running_paths).cloned().collect();
        Owners::new(&self.installed, &folders, &self.running_names)
    }
}

/// Folders and name stems of every running program.
fn running() -> (Vec<PathBuf>, Vec<String>) {
    let Ok(mut sys) = System::new() else { return (Vec::new(), Vec::new()) };
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_exe(UpdateKind::Always));
    let mut paths = Vec::new();
    let mut names = Vec::new();
    // DelphEye itself and its helper own nothing; counting them would shield any folder
    // whose name happens to contain "delpheye".
    let own = |process: &sysinfo::Process| {
        let name = process.name().to_string_lossy().to_lowercase();
        name.starts_with("delpheye") || process.pid().as_u32() == std::process::id()
    };
    for process in sys.processes().values().filter(|p| !own(p)) {
        if let Some(folder) = process.exe().and_then(Path::parent) {
            paths.push(folder.to_path_buf());
        }
        let name = process.name().to_string_lossy();
        names.push(name.strip_suffix(".exe").unwrap_or(&name).to_string());
    }
    paths.sort();
    paths.dedup();
    names.sort();
    names.dedup();
    (paths, names)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FolderReport {
    path: String,
    bytes: u64,
    files: u64,
    last_used: i64,
    has_programs: bool,
    has_saves: bool,
    needs_admin: bool,
    confidence: Confidence,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyReport {
    path: String,
    needs_admin: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Leftover {
    id: u32,
    name: String,
    /// `"folders"` for leftover folders (with any matching registry keys),
    /// `"entry"` for an "Apps & features" entry whose program is gone.
    kind: &'static str,
    confidence: Confidence,
    bytes: u64,
    files: u64,
    last_used: i64,
    has_programs: bool,
    has_saves: bool,
    needs_admin: bool,
    folders: Vec<FolderReport>,
    keys: Vec<KeyReport>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    scan_id: u64,
    elevated: bool,
    sandbox: bool,
    duration_ms: u64,
    /// Programs Windows lists as installed.
    installed: usize,
    /// Folders checked against that list.
    checked: usize,
    items: Vec<Leftover>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: usize,
    total: usize,
    path: String,
}

struct StoredScan {
    id: u64,
    elevated: bool,
    dirs: Dirs,
    items: Vec<Leftover>,
}

/// Finds leftovers. Reads only. Returns `None` if cancelled.
fn scan(dirs: Dirs, machine: &Machine, elevated: bool, id: u64, at: i64, cancel: &AtomicBool, report: &(dyn Fn(Progress) + Sync)) -> Option<(StoredScan, ScanReport)> {
    let started = Instant::now();
    let owners = machine.owners();
    let free: Vec<Candidate> = candidates(&dirs).into_iter().filter(|c| !owners.owns(&c.path)).collect();
    let checked = free.len();

    let done = AtomicUsize::new(0);
    let measured: Vec<(Candidate, Measure, Confidence)> = free
        .into_par_iter()
        .filter_map(|candidate| {
            let found = measure(&candidate.path, cancel);
            report(Progress { done: done.fetch_add(1, Ordering::Relaxed) + 1, total: checked, path: candidate.path.display().to_string() });
            let sure = confidence(&found, candidate.area, at)?;
            Some((candidate, found, sure))
        })
        .collect();
    if cancel.load(Ordering::Relaxed) {
        return None;
    }

    // The same program usually leaves folders in several places under one name.
    let mut groups: BTreeMap<String, Vec<(Candidate, Measure, Confidence)>> = BTreeMap::new();
    for entry in measured {
        let key = matcher::norm(&entry.0.name);
        groups.entry(if key.is_empty() { entry.0.name.to_lowercase() } else { key }).or_default().push(entry);
    }

    let mut items: Vec<Leftover> = Vec::new();
    for members in groups.into_values() {
        let confidence = members.iter().map(|m| m.2).min().unwrap_or(Confidence::Low);
        let folders: Vec<FolderReport> = members
            .iter()
            .map(|(c, m, sure)| FolderReport {
                path: c.path.display().to_string(),
                bytes: m.bytes,
                files: m.files,
                last_used: m.last_used,
                has_programs: m.has_programs,
                has_saves: m.has_saves,
                needs_admin: c.needs_admin,
                confidence: *sure,
            })
            .collect();
        let keys = if machine.registry && confidence >= Confidence::Medium { matching_keys(&members) } else { Vec::new() };
        items.push(Leftover {
            id: 0,
            name: members[0].0.name.clone(),
            kind: "folders",
            confidence,
            bytes: folders.iter().map(|f| f.bytes).sum(),
            files: folders.iter().map(|f| f.files).sum(),
            last_used: folders.iter().map(|f| f.last_used).max().unwrap_or(0),
            has_programs: folders.iter().any(|f| f.has_programs),
            has_saves: folders.iter().any(|f| f.has_saves),
            needs_admin: folders.iter().any(|f| f.needs_admin) || keys.iter().any(|k| k.needs_admin),
            folders,
            keys,
        });
    }
    for entry in &machine.broken {
        items.push(Leftover {
            id: 0,
            name: entry.name.clone(),
            kind: "entry",
            confidence: Confidence::High,
            bytes: 0,
            files: 0,
            last_used: 0,
            has_programs: false,
            has_saves: false,
            needs_admin: entry.needs_admin,
            folders: Vec::new(),
            keys: vec![KeyReport { path: entry.key.clone(), needs_admin: entry.needs_admin }],
        });
    }

    items.sort_by(|a, b| b.confidence.cmp(&a.confidence).then(b.bytes.cmp(&a.bytes)).then(a.name.cmp(&b.name)));
    for (number, item) in items.iter_mut().enumerate() {
        item.id = number as u32;
    }
    let report = ScanReport {
        scan_id: id,
        elevated,
        sandbox: dirs.sandbox.is_some(),
        duration_ms: started.elapsed().as_millis() as u64,
        installed: machine.installed.len(),
        checked,
        items: items.clone(),
    };
    Some((StoredScan { id, elevated, dirs, items }, report))
}

/// Settings keys named exactly like the leftover's folders, in the usual places.
fn matching_keys(members: &[(Candidate, Measure, Confidence)]) -> Vec<KeyReport> {
    let mut names: Vec<&str> = members.iter().map(|m| m.0.name.as_str()).collect();
    names.sort_unstable_by_key(|n| n.to_lowercase());
    names.dedup_by_key(|n| n.to_lowercase());
    let mut keys = Vec::new();
    for name in names {
        let places = [
            (false, format!(r"Software\{name}"), false, format!(r"HKCU\Software\{name}")),
            (true, format!(r"SOFTWARE\{name}"), false, format!(r"HKLM\SOFTWARE\{name}")),
            (true, format!(r"SOFTWARE\{name}"), true, format!(r"HKLM\SOFTWARE\WOW6432Node\{name}")),
        ];
        for (machine, path, view_32, shown) in places {
            if installed::key_exists(machine, &path, view_32) && !keys.iter().any(|k: &KeyReport| k.path.eq_ignore_ascii_case(&shown)) {
                keys.push(KeyReport { path: shown, needs_admin: machine });
            }
        }
    }
    keys
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HoldFailure {
    path: String,
    reason: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldReport {
    held: usize,
    held_bytes: u64,
    failed: Vec<HoldFailure>,
}

/// Re-checks, at the moment of moving, that a folder is still one the scan may touch.
fn still_movable(dirs: &Dirs, path: &Path) -> bool {
    let parent = path.parent().map(|p| p.to_string_lossy().to_lowercase());
    let under_root = roots(dirs).iter().any(|(root, ..)| Some(root.to_string_lossy().to_lowercase()) == parent);
    let name_ok = path.file_name().is_some_and(|n| !matcher::is_reserved(&n.to_string_lossy()));
    let plain = fs::symlink_metadata(path).is_ok_and(|md| md.is_dir() && !is_reparse(&md));
    under_root && name_ok && plain
}

/// Moves the chosen leftovers of a scan into quarantine.
fn hold(scan: &StoredScan, ids: &[u32], journal: &Journal) -> HoldReport {
    let store = quarantine::store_root(&scan.dirs);
    let mut report = HoldReport { held: 0, held_bytes: 0, failed: Vec::new() };
    let mut moved = Vec::new();
    for item in scan.items.iter().filter(|i| ids.contains(&i.id)) {
        if item.needs_admin && !scan.elevated {
            report.failed.push(HoldFailure { path: item.name.clone(), reason: "needs-admin" });
            continue;
        }
        for folder in &item.folders {
            let path = PathBuf::from(&folder.path);
            let result = if still_movable(&scan.dirs, &path) {
                quarantine::hold_folder(journal, &store, &item.name, &path, folder.bytes, folder.needs_admin)
            } else {
                Err("changed")
            };
            match result {
                Ok(_) => {
                    report.held += 1;
                    report.held_bytes += folder.bytes;
                    moved.push(serde_json::json!({ "path": folder.path, "bytes": folder.bytes }));
                }
                Err(reason) => report.failed.push(HoldFailure { path: folder.path.clone(), reason }),
            }
        }
        for key in &item.keys {
            match quarantine::hold_key(journal, &scan.dirs, &item.name, &key.path, key.needs_admin) {
                Ok(_) => {
                    report.held += 1;
                    moved.push(serde_json::json!({ "path": key.path, "bytes": 0 }));
                }
                Err(reason) => report.failed.push(HoldFailure { path: key.path.clone(), reason }),
            }
        }
    }
    if !moved.is_empty() || !report.failed.is_empty() {
        let details = serde_json::json!({ "items": moved, "failed": report.failed, "days": quarantine::HOLD_DAYS, "sandbox": scan.dirs.sandbox.is_some() });
        let _ = journal.add("quarantine", 0, report.held as u64, report.failed.len() as u64, &details);
    }
    report
}

#[derive(Default)]
pub struct LeftoversState {
    scan: Mutex<Option<StoredScan>>,
    cancel: Arc<AtomicBool>,
    busy: AtomicBool,
    last_id: std::sync::atomic::AtomicU64,
}

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

#[tauri::command]
pub async fn leftovers_scan(app: AppHandle, state: State<'_, LeftoversState>) -> Result<ScanReport, String> {
    let _busy = Busy::claim(&state.busy)?;
    let dirs = Dirs::detect().ok_or("environment")?;
    let id = state.last_id.fetch_add(1, Ordering::SeqCst) + 1;
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();

    let found = tauri::async_runtime::spawn_blocking(move || {
        let machine = Machine::detect(&dirs);
        let last_sent = Mutex::new(Instant::now());
        scan(dirs, &machine, system::is_elevated(), id, now(), &cancel, &|progress| {
            let Ok(mut last_sent) = last_sent.try_lock() else { return };
            if last_sent.elapsed().as_millis() >= 80 {
                *last_sent = Instant::now();
                let _ = app.emit(PROGRESS_EVENT, progress);
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    let (stored, report) = found.ok_or("cancelled")?;
    *state.scan.lock().unwrap() = Some(stored);
    Ok(report)
}

#[tauri::command]
pub fn leftovers_cancel(state: State<'_, LeftoversState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// Moves the chosen leftovers of scan `scan_id` to quarantine. A scan can be used once.
#[tauri::command]
pub async fn leftovers_quarantine(
    state: State<'_, LeftoversState>,
    journal: State<'_, Journal>,
    scan_id: u64,
    ids: Vec<u32>,
) -> Result<HoldReport, String> {
    let _busy = Busy::claim(&state.busy)?;
    let stored = {
        let mut slot = state.scan.lock().unwrap();
        match slot.take() {
            Some(scan) if scan.id == scan_id => scan,
            other => {
                *slot = other;
                return Err("stale".into());
            }
        }
    };
    Ok(hold(&stored, &ids, &journal))
}

#[tauri::command]
pub fn quarantine_list(journal: State<'_, Journal>) -> Vec<quarantine::Held> {
    quarantine::list(&journal)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineResult {
    done: usize,
    bytes: u64,
    failed: Vec<HoldFailure>,
}

/// Restores (`restore = true`) or deletes for good the given quarantine entries.
#[tauri::command]
pub async fn quarantine_act(journal: State<'_, Journal>, ids: Vec<i64>, restore: bool) -> Result<QuarantineResult, String> {
    let dirs = Dirs::detect().ok_or("environment")?;
    Ok(act(&journal, &dirs, &ids, restore, system::is_elevated()))
}

fn act(journal: &Journal, dirs: &Dirs, ids: &[i64], restore: bool, elevated: bool) -> QuarantineResult {
    let mut result = QuarantineResult { done: 0, bytes: 0, failed: Vec::new() };
    let mut touched_items = Vec::new();
    let held = quarantine::list(journal);
    for id in ids {
        let Some(entry) = held.iter().find(|h| h.id == *id) else { continue };
        if entry.admin && !elevated {
            result.failed.push(HoldFailure { path: entry.original.clone(), reason: "needs-admin" });
            continue;
        }
        let outcome = if restore { quarantine::restore(journal, dirs, *id) } else { quarantine::purge(journal, dirs, *id) };
        match outcome {
            Ok(entry) => {
                result.done += 1;
                result.bytes += entry.bytes;
                touched_items.push(serde_json::json!({ "path": entry.original, "bytes": entry.bytes }));
            }
            Err(reason) => result.failed.push(HoldFailure { path: entry.original.clone(), reason }),
        }
    }
    if !touched_items.is_empty() || !result.failed.is_empty() {
        let (kind, freed) = if restore { ("restore", 0) } else { ("purge", result.bytes) };
        let details = serde_json::json!({ "items": touched_items, "failed": result.failed, "sandbox": dirs.sandbox.is_some() });
        let _ = journal.add(kind, freed, result.done as u64, result.failed.len() as u64, &details);
    }
    result
}

/// Deletes for good whatever has been in quarantine for its full week.
pub fn purge_expired(journal: &Journal) {
    let Some(dirs) = Dirs::detect() else { return };
    let due = quarantine::expired(journal, now());
    if !due.is_empty() {
        act(journal, &dirs, &due, false, system::is_elevated());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cleanup::testing::{Sandbox, age, write};

    fn machine(installed: Vec<Installed>) -> Machine {
        Machine { installed, broken: Vec::new(), services: Vec::new(), running_paths: Vec::new(), running_names: Vec::new(), registry: false }
    }

    fn program(name: &str, path: &Path) -> Installed {
        Installed { name: name.into(), publisher: String::new(), paths: vec![path.to_path_buf()] }
    }

    /// Lays down a folder whose every file and the folder itself were last touched `days` ago.
    fn old_folder(dir: &Path, files: &[(&str, usize)], days: u32) {
        for (name, bytes) in files {
            write(&dir.join(name), *bytes);
            age(&dir.join(name), days);
        }
        fs::create_dir_all(dir).unwrap();
        for entry in walk_dirs(dir) {
            age(&entry, days);
        }
    }

    fn walk_dirs(dir: &Path) -> Vec<PathBuf> {
        let mut found = vec![dir.to_path_buf()];
        for entry in fs::read_dir(dir).unwrap().flatten() {
            if entry.path().is_dir() {
                found.extend(walk_dirs(&entry.path()));
            }
        }
        found.reverse(); // children first, so ageing them does not touch the parent again
        found
    }

    fn run(sandbox: &Sandbox, machine: &Machine, elevated: bool) -> (StoredScan, ScanReport) {
        scan(sandbox.dirs.clone(), machine, elevated, 1, now(), &AtomicBool::new(false), &|_| {}).unwrap()
    }

    fn by_name<'a>(report: &'a ScanReport, name: &str) -> Option<&'a Leftover> {
        report.items.iter().find(|i| i.name == name)
    }

    #[test]
    fn idle_and_busy_folders_get_the_right_confidence() {
        let now = 1_000 * DAY;
        let at = |days: i64, files: u64, has_programs: bool| Measure { bytes: 10, files, last_used: now - days * DAY, has_programs, has_saves: false };
        assert_eq!(confidence(&at(2, 5, false), Area::AppData, now), None, "busy");
        assert_eq!(confidence(&at(30, 0, false), Area::AppData, now), Some(Confidence::High), "empty");
        assert_eq!(confidence(&at(30, 5, false), Area::AppData, now), Some(Confidence::Low), "quiet");
        assert_eq!(confidence(&at(100, 5, false), Area::AppData, now), Some(Confidence::Medium));
        assert_eq!(confidence(&at(400, 5, false), Area::AppData, now), Some(Confidence::High), "abandoned");
        assert_eq!(confidence(&at(400, 5, true), Area::AppData, now), Some(Confidence::Medium), "still has programs");
        assert_eq!(confidence(&at(400, 5, true), Area::ProgramFiles, now), Some(Confidence::Low), "maybe installed by hand");
        let saves = Measure { has_saves: true, ..at(400, 5, false) };
        assert_eq!(confidence(&saves, Area::AppData, now), Some(Confidence::Medium), "saved games are never a sure thing");
        let saves_recent = Measure { has_saves: true, ..at(30, 5, false) };
        assert_eq!(confidence(&saves_recent, Area::AppData, now), Some(Confidence::Low));
    }

    #[test]
    fn leftovers_are_found_grouped_and_ranked() {
        let sandbox = Sandbox::new();
        let dirs = &sandbox.dirs;
        // Installed and still present: never a leftover.
        old_folder(&dirs.roaming.join("Telegram Desktop"), &[("data.bin", 500)], 400);
        old_folder(&dirs.program_files[0].join("7-Zip"), &[("7z.exe", 500)], 400);
        // Left behind in two places by one program.
        old_folder(&dirs.roaming.join("OldEditor"), &[("prefs.json", 300)], 400);
        old_folder(&dirs.local.join("OldEditor"), &[("cache.bin", 900)], 300);
        // Left in Program Files with its program still inside.
        old_folder(&dirs.program_files[0].join("Portable Tool"), &[("tool.exe", 2_000)], 400);
        // An uninstalled game's saves.
        old_folder(&dirs.local.join("OldGame"), &[("Saved/SaveGames/slot1.sav", 400)], 400);
        // Busy: written to today.
        write(&dirs.roaming.join("SomethingActive").join("log.txt"), 10);
        // Windows' own and the app's own folders.
        old_folder(&dirs.local.join("Microsoft").join("Edge"), &[("x", 10)], 400);
        old_folder(&dirs.local.join("DelphEye"), &[("x", 10)], 400);

        let installed = vec![
            program("Telegram Desktop", &dirs.roaming.join("Telegram Desktop")),
            program("7-Zip 24.08 (x64)", &dirs.program_files[0].join("7-Zip")),
        ];
        let (_, report) = run(&sandbox, &machine(installed), true);
        let names: Vec<&str> = report.items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["OldEditor", "OldGame", "Portable Tool"]);
        let game = by_name(&report, "OldGame").unwrap();
        assert_eq!((game.confidence, game.has_saves), (Confidence::Medium, true));

        let editor = by_name(&report, "OldEditor").unwrap();
        assert_eq!((editor.confidence, editor.bytes, editor.folders.len(), editor.needs_admin), (Confidence::High, 1_200, 2, false));
        let tool = by_name(&report, "Portable Tool").unwrap();
        assert_eq!((tool.confidence, tool.has_programs, tool.needs_admin), (Confidence::Low, true, true));
        assert_eq!(report.installed, 2);
    }

    #[test]
    fn quarantine_moves_only_what_was_chosen_and_allowed() {
        let sandbox = Sandbox::new();
        let dirs = &sandbox.dirs;
        old_folder(&dirs.roaming.join("OldEditor"), &[("prefs.json", 300)], 400);
        old_folder(&dirs.program_data.join("OldVendor"), &[("db.dat", 700)], 400);
        old_folder(&dirs.roaming.join("Untouched"), &[("keep.txt", 50)], 400);

        let journal = Journal::in_memory();
        let (stored, report) = run(&sandbox, &machine(Vec::new()), false);
        let id = |name: &str| by_name(&report, name).unwrap().id;
        let held = hold(&stored, &[id("OldEditor"), id("OldVendor")], &journal);

        assert_eq!((held.held, held.held_bytes), (1, 300));
        assert_eq!(held.failed.len(), 1);
        assert_eq!(held.failed[0].reason, "needs-admin", "ProgramData needs administrator rights");
        assert!(!dirs.roaming.join("OldEditor").exists());
        assert!(dirs.program_data.join("OldVendor").exists());
        assert!(dirs.roaming.join("Untouched").join("keep.txt").exists());

        let entries = quarantine::list(&journal);
        assert_eq!(entries.len(), 1);
        let result = act(&journal, dirs, &[entries[0].id], true, false);
        assert_eq!(result.done, 1);
        assert!(dirs.roaming.join("OldEditor").join("prefs.json").exists());

        let journal_kinds: Vec<String> = journal.list(10).unwrap().into_iter().map(|e| serde_json::to_value(e).unwrap()["kind"].as_str().unwrap().to_string()).collect();
        assert_eq!(journal_kinds, ["restore", "quarantine"]);
    }

    #[test]
    fn a_folder_that_changed_since_the_scan_is_not_moved() {
        let sandbox = Sandbox::new();
        let dirs = &sandbox.dirs;
        let target = dirs.roaming.join("OldEditor");
        old_folder(&target, &[("prefs.json", 300)], 400);
        let (stored, report) = run(&sandbox, &machine(Vec::new()), false);

        // Replaced by a link to somewhere precious after the scan.
        fs::remove_dir_all(&target).unwrap();
        write(&dirs.home.join("Documents").join("thesis.docx"), 10);
        crate::cleanup::testing::junction(&target, &dirs.home.join("Documents"));

        let held = hold(&stored, &[report.items[0].id], &Journal::in_memory());
        assert_eq!((held.held, held.failed[0].reason), (0, "changed"));
        assert!(dirs.home.join("Documents").join("thesis.docx").exists());
    }
}

//! The Cleanup module: find what can be removed, report it, and remove only what the user picks.
//!
//! A clean-up never accepts paths from the UI. The UI names categories and targets from the
//! last scan report, and the paths are taken from what that scan itself recorded.

mod catalog;
mod engine;
mod recycle;

#[cfg(test)]
pub use engine::testing;

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::journal::Journal;
use crate::system::{self, Dirs};
use catalog::{Category, Group, Risk, Source, Target};
use engine::{Guard, Observer, Outcome, Tally};

const PROGRESS_EVENT: &str = "cleanup:progress";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(80);

type Sink<'a> = &'a (dyn Fn(ProgressEvent) + Sync);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    phase: &'static str,
    /// Targets finished, out of `total`.
    done: usize,
    total: usize,
    /// Bytes found so far when scanning, freed so far when cleaning.
    bytes: u64,
    files: u64,
    /// The folder being worked on, when this update is about a new one.
    path: Option<String>,
}

/// Shared counters for one scan or clean-up, reported to the UI at a steady pace.
struct Progress<'a> {
    phase: &'static str,
    total: usize,
    done: AtomicUsize,
    bytes: AtomicU64,
    files: AtomicU64,
    last_sent: Mutex<Instant>,
    sink: Sink<'a>,
}

impl<'a> Progress<'a> {
    fn new(phase: &'static str, total: usize, sink: Sink<'a>) -> Self {
        Self {
            phase,
            total,
            done: AtomicUsize::new(0),
            bytes: AtomicU64::new(0),
            files: AtomicU64::new(0),
            last_sent: Mutex::new(Instant::now()),
            sink,
        }
    }

    fn send(&self, path: Option<&Path>) {
        (self.sink)(ProgressEvent {
            phase: self.phase,
            done: self.done.load(Ordering::Relaxed),
            total: self.total,
            bytes: self.bytes.load(Ordering::Relaxed),
            files: self.files.load(Ordering::Relaxed),
            path: path.map(|p| p.display().to_string()),
        });
    }

    /// Sends an update unless one went out a moment ago.
    fn send_if_due(&self, path: Option<&Path>) {
        // Another thread holding the lock is already sending; no need to queue behind it.
        let Ok(mut last_sent) = self.last_sent.try_lock() else {
            return;
        };
        if last_sent.elapsed() >= PROGRESS_INTERVAL {
            *last_sent = Instant::now();
            drop(last_sent);
            self.send(path);
        }
    }

    fn add(&self, bytes: u64, files: u64) {
        self.bytes.fetch_add(bytes, Ordering::Relaxed);
        self.files.fetch_add(files, Ordering::Relaxed);
    }

    fn target_done(&self) {
        self.done.fetch_add(1, Ordering::Relaxed);
        self.send(None);
    }
}

impl Observer for Progress<'_> {
    fn entering(&self, dir: &Path) {
        self.send_if_due(Some(dir));
    }
    fn counted(&self, bytes: u64) {
        self.add(bytes, 1);
        self.send_if_due(None);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFile {
    path: String,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetReport {
    id: String,
    label: String,
    label_key: Option<&'static str>,
    bytes: u64,
    files: u64,
    needs_admin: bool,
    /// Part of it could not be read, so the size is a lower bound.
    blocked: bool,
    paths: Vec<String>,
    largest: Vec<LargeFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryReport {
    id: String,
    title: Option<String>,
    group: Group,
    risk: Risk,
    bytes: u64,
    files: u64,
    /// The program holding these files open, if it is running right now.
    running: Option<&'static str>,
    min_age_hours: Option<u64>,
    targets: Vec<TargetReport>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    scan_id: u64,
    elevated: bool,
    sandbox: bool,
    duration_ms: u64,
    categories: Vec<CategoryReport>,
}

/// What a scan looked at, kept so a later clean-up acts on exactly those places.
struct StoredScan {
    id: u64,
    at: SystemTime,
    elevated: bool,
    dirs: Dirs,
    catalog: Vec<Category>,
}

/// The moment before which a file must have been left alone to belong to this category.
fn cutoff(category: &Category, scanned_at: SystemTime) -> Option<SystemTime> {
    // If the clock cannot go back that far, use a cutoff no file can precede: nothing qualifies.
    category
        .min_age
        .map(|age| scanned_at.checked_sub(age).unwrap_or(SystemTime::UNIX_EPOCH))
}

/// Measures everything in the catalog. Returns `None` if cancelled part-way.
fn scan(
    dirs: Dirs,
    elevated: bool,
    id: u64,
    cancel: &AtomicBool,
    sink: Sink,
) -> Option<(StoredScan, ScanReport)> {
    let started = Instant::now();
    let at = SystemTime::now();
    let catalog = catalog::build(&dirs);
    let running = system::running_processes();

    let progress = Progress::new("scan", catalog.iter().map(|c| c.targets.len()).sum(), sink);
    progress.send(None);

    let tallies: Vec<Vec<Tally>> = catalog
        .par_iter()
        .map(|category| {
            let cutoff = cutoff(category, at);
            category
                .targets
                .par_iter()
                .map(|target| {
                    let tally = scan_target(target, cutoff, cancel, &progress);
                    progress.target_done();
                    tally
                })
                .collect()
        })
        .collect();

    if cancel.load(Ordering::Relaxed) {
        return None;
    }

    let categories = catalog
        .iter()
        .zip(tallies)
        .map(|(category, tallies)| report_category(category, tallies, &running))
        .collect();
    let report = ScanReport {
        scan_id: id,
        elevated,
        sandbox: dirs.sandbox.is_some(),
        duration_ms: started.elapsed().as_millis() as u64,
        categories,
    };
    let stored = StoredScan {
        id,
        at,
        elevated,
        dirs,
        catalog,
    };
    Some((stored, report))
}

fn scan_target(
    target: &Target,
    cutoff: Option<SystemTime>,
    cancel: &AtomicBool,
    progress: &Progress,
) -> Tally {
    let mut tally = Tally::default();
    match &target.source {
        Source::Locations(locations) => {
            for location in locations {
                engine::scan_location(location, cutoff, cancel, &mut tally, progress);
            }
        }
        Source::RecycleBin => {
            if let Some((bytes, items)) = recycle::query() {
                tally.bytes = bytes;
                tally.files = items;
                progress.add(bytes, items);
            }
        }
    }
    tally
}

fn report_category(category: &Category, tallies: Vec<Tally>, running: &HashSet<String>) -> CategoryReport {
    let targets: Vec<TargetReport> = category
        .targets
        .iter()
        .zip(tallies)
        .map(|(target, tally)| TargetReport {
            id: target.id.clone(),
            label: target.label.clone(),
            label_key: target.label_key,
            bytes: tally.bytes,
            files: tally.files,
            needs_admin: target.needs_admin,
            blocked: tally.blocked,
            paths: match &target.source {
                Source::Locations(locations) => {
                    locations.iter().map(|l| l.path.display().to_string()).collect()
                }
                Source::RecycleBin => Vec::new(),
            },
            largest: tally
                .largest
                .into_iter()
                .map(|(bytes, path)| LargeFile {
                    path: path.display().to_string(),
                    bytes,
                })
                .collect(),
        })
        .collect();

    CategoryReport {
        id: category.id.clone(),
        title: category.title.clone(),
        group: category.group,
        risk: category.risk,
        bytes: targets.iter().map(|t| t.bytes).sum(),
        files: targets.iter().map(|t| t.files).sum(),
        running: category.running_exe.filter(|exe| running.contains(*exe)),
        min_age_hours: category.min_age.map(|age| age.as_secs() / 3600),
        targets,
    }
}

/// The targets of one category the user ticked.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    category: String,
    targets: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CategoryResult {
    id: String,
    title: Option<String>,
    freed_bytes: u64,
    deleted_files: u64,
    skipped_files: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanReport {
    freed_bytes: u64,
    deleted_files: u64,
    in_use: u64,
    denied: u64,
    failed: u64,
    duration_ms: u64,
    cancelled: bool,
    sandbox: bool,
    categories: Vec<CategoryResult>,
    journal_id: Option<i64>,
}

/// Deletes the selected targets of a finished scan.
///
/// Names in `selection` that the scan does not know are ignored, as are targets that need
/// administrator rights the scan did not have.
fn clean(scan: &StoredScan, selection: &[Selection], cancel: &AtomicBool, sink: Sink) -> CleanReport {
    let started = Instant::now();
    let guard = Guard::new(&scan.dirs);

    let jobs: Vec<(&Category, Vec<&Target>)> = scan
        .catalog
        .iter()
        .filter_map(|category| {
            let picked = selection.iter().find(|s| s.category == category.id)?;
            let targets: Vec<&Target> = category
                .targets
                .iter()
                .filter(|t| picked.targets.contains(&t.id))
                .filter(|t| scan.elevated || !t.needs_admin)
                .collect();
            (!targets.is_empty()).then_some((category, targets))
        })
        .collect();

    let progress = Progress::new("clean", jobs.iter().map(|job| job.1.len()).sum(), sink);
    progress.send(None);

    let mut total = Outcome::default();
    let mut categories = Vec::new();
    for (category, targets) in jobs {
        let cutoff = cutoff(category, scan.at);
        let mut outcome = Outcome::default();
        for target in targets {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            clean_target(target, cutoff, &guard, cancel, &mut outcome, &progress);
            progress.target_done();
        }
        total += outcome;
        categories.push(CategoryResult {
            id: category.id.clone(),
            title: category.title.clone(),
            freed_bytes: outcome.freed,
            deleted_files: outcome.deleted,
            skipped_files: outcome.skipped(),
        });
    }

    CleanReport {
        freed_bytes: total.freed,
        deleted_files: total.deleted,
        in_use: total.in_use,
        denied: total.denied,
        failed: total.failed,
        duration_ms: started.elapsed().as_millis() as u64,
        cancelled: cancel.load(Ordering::Relaxed),
        sandbox: scan.dirs.sandbox.is_some(),
        categories,
        journal_id: None,
    }
}

fn clean_target(
    target: &Target,
    cutoff: Option<SystemTime>,
    guard: &Guard,
    cancel: &AtomicBool,
    outcome: &mut Outcome,
    progress: &Progress,
) {
    match &target.source {
        Source::Locations(locations) => {
            for location in locations {
                if let Err(refused) =
                    engine::clean_location(location, cutoff, guard, cancel, outcome, progress)
                {
                    eprintln!("cleanup: {refused}");
                    outcome.failed += 1;
                }
            }
        }
        Source::RecycleBin => {
            let before = recycle::query().unwrap_or_default();
            if recycle::empty() {
                let after = recycle::query().unwrap_or_default();
                let (freed, items) = (before.0.saturating_sub(after.0), before.1.saturating_sub(after.1));
                outcome.freed += freed;
                outcome.deleted += items;
                progress.add(freed, items);
            } else if before.1 > 0 {
                // The shell also reports failure for a bin that was already empty.
                outcome.failed += 1;
            }
        }
    }
}

#[derive(Default)]
pub struct CleanupState {
    scan: Mutex<Option<StoredScan>>,
    cancel: Arc<AtomicBool>,
    busy: AtomicBool,
    last_id: AtomicU64,
}

/// Marks the module busy for as long as it lives, so scans and clean-ups never overlap.
struct Busy<'a>(&'a AtomicBool);

impl<'a> Busy<'a> {
    fn claim(flag: &'a AtomicBool) -> Result<Self, String> {
        if flag.swap(true, Ordering::SeqCst) {
            Err("busy".into())
        } else {
            Ok(Self(flag))
        }
    }
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn emitter(app: AppHandle) -> impl Fn(ProgressEvent) + Sync + Send + 'static {
    move |event| {
        let _ = app.emit(PROGRESS_EVENT, event);
    }
}

/// Scans every cleanup category. Changes nothing on disk.
///
/// Errors: `"busy"`, `"cancelled"`, or `"environment"` if Windows' folders cannot be located.
#[tauri::command]
pub async fn cleanup_scan(app: AppHandle, state: State<'_, CleanupState>) -> Result<ScanReport, String> {
    let _busy = Busy::claim(&state.busy)?;
    let dirs = Dirs::detect().ok_or("environment")?;
    let id = state.last_id.fetch_add(1, Ordering::SeqCst) + 1;
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();
    let sink = emitter(app);

    let found = tauri::async_runtime::spawn_blocking(move || {
        scan(dirs, system::is_elevated(), id, &cancel, &sink)
    })
    .await
    .map_err(|e| e.to_string())?;

    let (stored, report) = found.ok_or("cancelled")?;
    *state.scan.lock().unwrap() = Some(stored);
    Ok(report)
}

/// Asks the scan or clean-up in progress to stop at the next opportunity.
#[tauri::command]
pub fn cleanup_cancel(state: State<'_, CleanupState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// Deletes the selected targets of scan `scan_id` and records the result in the journal.
///
/// A scan can be cleaned once. Errors: `"busy"`, or `"stale"` if `scan_id` is not the latest scan.
#[tauri::command]
pub async fn cleanup_run(
    app: AppHandle,
    state: State<'_, CleanupState>,
    journal: State<'_, Journal>,
    scan_id: u64,
    selection: Vec<Selection>,
) -> Result<CleanReport, String> {
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
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();
    let sink = emitter(app);

    let mut report =
        tauri::async_runtime::spawn_blocking(move || clean(&stored, &selection, &cancel, &sink))
            .await
            .map_err(|e| e.to_string())?;

    let skipped = report.in_use + report.denied + report.failed;
    if report.deleted_files > 0 || skipped > 0 {
        let details = serde_json::json!({
            "categories": report.categories,
            "inUse": report.in_use,
            "denied": report.denied,
            "failed": report.failed,
            "durationMs": report.duration_ms,
            "cancelled": report.cancelled,
            "sandbox": report.sandbox,
        });
        report.journal_id = journal
            .add("cleanup", report.freed_bytes, report.deleted_files, skipped, &details)
            .inspect_err(|e| eprintln!("journal: cannot record clean-up: {e}"))
            .ok();
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::engine::testing::{Sandbox, age, write};
    use super::*;

    fn pick(category: &str, targets: &[&str]) -> Selection {
        Selection {
            category: category.into(),
            targets: targets.iter().map(|t| t.to_string()).collect(),
        }
    }

    fn run_scan(sandbox: &Sandbox, elevated: bool) -> (StoredScan, ScanReport) {
        scan(sandbox.dirs.clone(), elevated, 1, &AtomicBool::new(false), &|_| {}).unwrap()
    }

    fn run_clean(stored: &StoredScan, selection: &[Selection]) -> CleanReport {
        clean(stored, selection, &AtomicBool::new(false), &|_| {})
    }

    fn category<'a>(report: &'a ScanReport, id: &str) -> &'a CategoryReport {
        report.categories.iter().find(|c| c.id == id).unwrap_or_else(|| panic!("no {id}"))
    }

    /// A small machine: old and new temp files, a Chrome profile, an npm cache, Windows\Temp.
    fn populate(sandbox: &Sandbox) {
        let dirs = &sandbox.dirs;
        write(&dirs.temp.join("old.tmp"), 4_000);
        age(&dirs.temp.join("old.tmp"), 5);
        write(&dirs.temp.join("today.tmp"), 1_000);

        let profile = dirs.local.join("Google").join("Chrome").join("User Data").join("Default");
        write(&profile.join("Cache").join("Cache_Data").join("index"), 100);
        write(&profile.join("Cache").join("Cache_Data").join("f_000001"), 60_000);
        write(&profile.join("History"), 2_000);

        write(&dirs.local.join("npm-cache").join("_cacache").join("content").join("aa"), 9_000);

        write(&dirs.windows.join("Temp").join("old-system.tmp"), 3_000);
        age(&dirs.windows.join("Temp").join("old-system.tmp"), 5);

        write(&dirs.home.join("Documents").join("thesis.docx"), 10);
    }

    #[test]
    fn scan_reports_sizes_without_changing_anything() {
        let sandbox = Sandbox::new();
        populate(&sandbox);
        let (_, report) = run_scan(&sandbox, false);

        assert!(report.sandbox && !report.elevated);
        let temp = category(&report, "user_temp");
        assert_eq!((temp.bytes, temp.files, temp.min_age_hours), (4_000, 1, Some(24)));
        assert_eq!(temp.targets[0].largest[0].bytes, 4_000);

        let chrome = category(&report, "browser_chrome");
        assert_eq!((chrome.bytes, chrome.files), (60_100, 2));
        assert_eq!(chrome.title.as_deref(), Some("Google Chrome"));

        assert!(category(&report, "windows_temp").targets[0].needs_admin);
        assert_eq!(category(&report, "dev_cache").bytes, 9_000);

        assert!(sandbox.dirs.temp.join("old.tmp").exists(), "scanning deletes nothing");
    }

    #[test]
    fn clean_removes_only_what_was_selected() {
        let sandbox = Sandbox::new();
        populate(&sandbox);
        let dirs = &sandbox.dirs;
        let (stored, _) = run_scan(&sandbox, false);

        let done = run_clean(
            &stored,
            &[
                pick("user_temp", &["temp"]),
                pick("browser_chrome", &["Default"]),
                pick("dev_cache", &["no-such-target"]),
                pick("no_such_category", &["temp"]),
            ],
        );

        assert_eq!((done.freed_bytes, done.deleted_files), (64_100, 3));
        assert_eq!(done.in_use + done.denied + done.failed, 0);
        let cleaned: Vec<&str> = done.categories.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(cleaned, ["user_temp", "browser_chrome"]);

        let profile = dirs.local.join("Google").join("Chrome").join("User Data").join("Default");
        assert!(!dirs.temp.join("old.tmp").exists());
        assert!(dirs.temp.join("today.tmp").exists(), "under a day old");
        assert!(profile.join("Cache").is_dir(), "the cache folder itself stays");
        assert!(!profile.join("Cache").join("Cache_Data").exists());
        assert!(profile.join("History").exists(), "browsing history is not cache");
        assert!(dirs.local.join("npm-cache").join("_cacache").join("content").join("aa").exists());
        assert!(dirs.home.join("Documents").join("thesis.docx").exists());
    }

    #[test]
    fn admin_targets_wait_for_an_elevated_scan() {
        let sandbox = Sandbox::new();
        populate(&sandbox);
        let file = sandbox.dirs.windows.join("Temp").join("old-system.tmp");
        let selection = [pick("windows_temp", &["temp"])];

        let (stored, _) = run_scan(&sandbox, false);
        let done = run_clean(&stored, &selection);
        assert_eq!(done.deleted_files, 0);
        assert!(done.categories.is_empty());
        assert!(file.exists());

        let (stored, _) = run_scan(&sandbox, true);
        assert_eq!(run_clean(&stored, &selection).freed_bytes, 3_000);
        assert!(!file.exists());
    }

    #[test]
    fn a_file_that_turns_a_day_old_after_the_scan_is_still_spared() {
        let sandbox = Sandbox::new();
        populate(&sandbox);
        let (mut stored, _) = run_scan(&sandbox, false);
        // Pretend the scan happened two days ago: the cutoff must stay tied to that moment,
        // so even the file that is "old" by today's clock was not old enough back then.
        stored.at -= Duration::from_secs(2 * 24 * 3600);
        write(&sandbox.dirs.temp.join("after-scan.tmp"), 10);
        age(&sandbox.dirs.temp.join("after-scan.tmp"), 2);

        run_clean(&stored, &[pick("user_temp", &["temp"])]);
        assert!(sandbox.dirs.temp.join("after-scan.tmp").exists());
        assert!(!sandbox.dirs.temp.join("old.tmp").exists(), "five days old: before the cutoff");
    }

    #[test]
    fn progress_ends_with_every_target_done() {
        let sandbox = Sandbox::new();
        populate(&sandbox);
        let events = Mutex::new(Vec::new());
        let (stored, _) =
            scan(sandbox.dirs.clone(), true, 1, &AtomicBool::new(false), &|e| events.lock().unwrap().push(e)).unwrap();

        let events = events.into_inner().unwrap();
        let last = events.last().unwrap();
        let targets: usize = stored.catalog.iter().map(|c| c.targets.len()).sum();
        assert_eq!((last.phase, last.done, last.total), ("scan", targets, targets));
        assert_eq!(last.bytes, 4_000 + 60_100 + 9_000 + 3_000);
    }

    #[test]
    fn a_cancelled_scan_yields_no_report() {
        let sandbox = Sandbox::new();
        populate(&sandbox);
        assert!(scan(sandbox.dirs.clone(), false, 1, &AtomicBool::new(true), &|_| {}).is_none());
    }
}

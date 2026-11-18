//! Measures cleanup locations and, separately, empties them.
//!
//! Every file the app deletes is deleted in this module, so the safety rules live in one place:
//!
//! * a location is refused outright unless [`Guard`] accepts its path;
//! * reparse points (junctions, symlinks, cloud placeholders) are never followed and never
//!   removed, so a link sitting inside a cache cannot lead the walk somewhere else;
//! * only the files a location's rule selects are touched, and the location's own folder
//!   always stays.

use std::fmt;
use std::fs::{self, Metadata};
use std::io;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;

use crate::system::Dirs;

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_PATH_NOT_FOUND: i32 = 3;
const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_SHARING_VIOLATION: i32 = 32;
const ERROR_LOCK_VIOLATION: i32 = 33;

/// How many of a location's biggest files are remembered for the report.
pub const LARGEST_KEPT: usize = 6;

/// Which files inside a location belong to it.
#[derive(Clone, Debug)]
pub enum Matcher {
    /// Every file below the folder. Sub-folders left empty are removed as well.
    Contents,
    /// Files directly inside the folder whose lower-cased name starts and ends as given.
    FilesNamed {
        prefix: &'static str,
        suffix: &'static str,
    },
    /// The path is one file.
    SingleFile,
}

/// One place on disk that a cleanup target covers.
#[derive(Clone, Debug)]
pub struct Location {
    pub path: PathBuf,
    pub matcher: Matcher,
}

/// Follows a walk as it happens. `()` ignores everything.
pub trait Observer: Sync {
    /// The walk moved into `dir`.
    fn entering(&self, _dir: &Path) {}
    /// One more file of this size was counted (when scanning) or deleted (when cleaning).
    fn counted(&self, _bytes: u64) {}
}

impl Observer for () {}

/// What a scan found in one or more locations.
#[derive(Default)]
pub struct Tally {
    pub bytes: u64,
    pub files: u64,
    /// Some folder could not be read, so the numbers are a lower bound.
    pub blocked: bool,
    /// The biggest files, largest first.
    pub largest: Vec<(u64, PathBuf)>,
}

impl Tally {
    fn add(&mut self, path: &Path, bytes: u64) {
        self.bytes += bytes;
        self.files += 1;
        let smallest_kept = self.largest.last().map_or(0, |entry| entry.0);
        if self.largest.len() < LARGEST_KEPT || bytes > smallest_kept {
            let at = self.largest.partition_point(|entry| entry.0 >= bytes);
            self.largest.insert(at, (bytes, path.to_path_buf()));
            self.largest.truncate(LARGEST_KEPT);
        }
    }
}

/// What a clean-up actually did.
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub freed: u64,
    pub deleted: u64,
    /// Files another program held open.
    pub in_use: u64,
    /// Files Windows would not let this user delete.
    pub denied: u64,
    /// Anything else that went wrong, including locations the guard refused.
    pub failed: u64,
}

impl Outcome {
    pub fn skipped(&self) -> u64 {
        self.in_use + self.denied + self.failed
    }
}

impl std::ops::AddAssign for Outcome {
    fn add_assign(&mut self, other: Self) {
        self.freed += other.freed;
        self.deleted += other.deleted;
        self.in_use += other.in_use;
        self.denied += other.denied;
        self.failed += other.failed;
    }
}

/// A location the guard would not allow to be cleaned.
#[derive(Debug)]
pub struct Refused {
    pub path: PathBuf,
    pub why: &'static str,
}

impl fmt::Display for Refused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "refused to clean {}: {}", self.path.display(), self.why)
    }
}

/// The last line of defence against a wrong path reaching the delete code.
///
/// The catalog only ever produces known cache and temp folders, so in normal operation this
/// never fires. It exists for the abnormal cases: an environment variable pointing somewhere
/// odd, a cache folder replaced by a junction, or a future bug in the catalog.
pub struct Guard {
    /// Folders that hold cleanable places but must never be cleaned as a whole.
    containers: Vec<Vec<String>>,
    /// Folders nothing may be cleaned in, at any depth.
    sealed: Vec<Vec<String>>,
}

impl Guard {
    pub fn new(dirs: &Dirs) -> Self {
        let (home, win) = (&dirs.home, &dirs.windows);
        let app_data = home.join("AppData");

        let mut containers = vec![
            home.clone(),
            app_data.join("LocalLow"),
            app_data,
            dirs.local.clone(),
            dirs.roaming.clone(),
            win.clone(),
            dirs.program_data.clone(),
        ];
        containers.extend(home.parent().map(Path::to_path_buf));

        let system = [
            "System32", "SysWOW64", "WinSxS", "Installer", "Fonts", "servicing", "assembly",
            "Boot", "INF",
        ];
        let personal = [
            "Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos", "Favorites",
            "Saved Games", "OneDrive",
        ];
        let mut sealed: Vec<PathBuf> = system.iter().map(|d| win.join(d)).collect();
        sealed.extend(personal.iter().map(|d| home.join(d)));
        sealed.extend(dirs.program_files.iter().cloned());
        sealed.extend(dirs.personal.iter().cloned());

        Self {
            containers: containers.iter().filter_map(|p| parts(p)).collect(),
            sealed: sealed.iter().filter_map(|p| parts(p)).collect(),
        }
    }

    /// Decides whether `path` may be cleaned, judging both the path as written and, if it
    /// is or passes through a link, the place it really leads to.
    pub fn check(&self, path: &Path) -> Result<(), Refused> {
        self.check_written(path)?;
        match fs::canonicalize(path) {
            Ok(real) => self.check_written(&real).map_err(|e| Refused {
                path: path.to_path_buf(),
                why: e.why,
            }),
            // Nothing there means nothing to delete.
            Err(_) => Ok(()),
        }
    }

    fn check_written(&self, path: &Path) -> Result<(), Refused> {
        let refuse = |why| Refused {
            path: path.to_path_buf(),
            why,
        };
        let target = parts(path).ok_or_else(|| refuse("not a plain path on a local drive"))?;
        // `inner` lies in `outer` or is `outer` itself.
        let within =
            |inner: &[String], outer: &[String]| inner.len() >= outer.len() && inner[..outer.len()] == *outer;

        if self.containers.iter().any(|c| within(c, &target)) {
            return Err(refuse("it contains folders that must be kept"));
        }
        if self.sealed.iter().any(|s| within(s, &target) || within(&target, s)) {
            return Err(refuse("it is part of a protected folder"));
        }
        Ok(())
    }
}

/// Splits a path into lower-cased components, e.g. `["c:", "users", "name"]`.
///
/// Returns `None` for anything that is not an ordinary path below a drive letter: drive
/// roots, relative paths, network shares, and paths containing `.` or `..`.
fn parts(path: &Path) -> Option<Vec<String>> {
    let text = path.to_str()?;
    let text = text.strip_prefix(r"\\?\").unwrap_or(text);
    let parts: Vec<String> = text
        .split(['\\', '/'])
        .filter(|p| !p.is_empty())
        .map(str::to_lowercase)
        .collect();

    let drive = parts.first()?.as_bytes();
    let on_a_drive = drive.len() == 2 && drive[0].is_ascii_alphabetic() && drive[1] == b':';
    let plain = !parts.iter().any(|p| p == "." || p == "..");
    (on_a_drive && plain && parts.len() >= 2).then_some(parts)
}

pub fn is_reparse(md: &Metadata) -> bool {
    md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// When a file last arrived here: the later of its creation and modification times.
///
/// Modification time alone is not enough — an installer unpacking into Temp keeps each
/// file's original date, so a file written a minute ago can look years old.
fn last_touched(md: &Metadata) -> Option<SystemTime> {
    match (md.created().ok(), md.modified().ok()) {
        (Some(created), Some(modified)) => Some(created.max(modified)),
        (created, modified) => created.or(modified),
    }
}

/// With a cutoff, only files left alone since before it qualify; unknown dates never do.
fn old_enough(touched: Option<SystemTime>, cutoff: Option<SystemTime>) -> bool {
    match cutoff {
        None => true,
        Some(cutoff) => touched.is_some_and(|t| t < cutoff),
    }
}

trait Visitor {
    fn dir(&mut self, dir: &Path);
    fn file(&mut self, path: &Path, md: &Metadata);
    fn unreadable(&mut self) {}
}

/// A sub-folder met during a walk, with the time it was last touched before the walk.
type SeenDir = (PathBuf, Option<SystemTime>);

/// Feeds `visitor` every file the location's rule selects.
///
/// Returns the sub-folders seen, each parent before its children.
fn walk(
    loc: &Location,
    cutoff: Option<SystemTime>,
    cancel: &AtomicBool,
    visitor: &mut dyn Visitor,
) -> Vec<SeenDir> {
    let mut seen = Vec::new();
    let cancelled = || cancel.load(Ordering::Relaxed);
    // A missing folder is simply empty; any other failure means we cannot see inside.
    let list = |dir: &Path, visitor: &mut dyn Visitor| match fs::read_dir(dir) {
        Ok(entries) => Some(entries),
        Err(e) => {
            if e.kind() != io::ErrorKind::NotFound {
                visitor.unreadable();
            }
            None
        }
    };

    match &loc.matcher {
        Matcher::SingleFile => {
            if let Ok(md) = fs::symlink_metadata(&loc.path) {
                if md.is_file() && !is_reparse(&md) && old_enough(last_touched(&md), cutoff) {
                    visitor.file(&loc.path, &md);
                }
            }
        }
        Matcher::FilesNamed { prefix, suffix } => {
            visitor.dir(&loc.path);
            for entry in list(&loc.path, visitor).into_iter().flatten().flatten() {
                if cancelled() {
                    break;
                }
                let Ok(md) = entry.metadata() else { continue };
                if md.is_dir() || is_reparse(&md) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_lowercase();
                let named = name.starts_with(prefix) && name.ends_with(suffix);
                if named && old_enough(last_touched(&md), cutoff) {
                    visitor.file(&entry.path(), &md);
                }
            }
        }
        Matcher::Contents => {
            let mut pending = vec![loc.path.clone()];
            while let Some(dir) = pending.pop() {
                if cancelled() {
                    break;
                }
                visitor.dir(&dir);
                for entry in list(&dir, visitor).into_iter().flatten().flatten() {
                    // Entry metadata describes a link itself, never what it points to.
                    let Ok(md) = entry.metadata() else { continue };
                    if is_reparse(&md) {
                        continue;
                    }
                    let path = entry.path();
                    if md.is_dir() {
                        seen.push((path.clone(), last_touched(&md)));
                        pending.push(path);
                    } else if !is_folder_settings(&entry) && old_enough(last_touched(&md), cutoff) {
                        visitor.file(&path, &md);
                    }
                }
            }
        }
    }
    seen
}

/// `desktop.ini` holds a folder's own appearance settings and is not ours to remove.
fn is_folder_settings(entry: &fs::DirEntry) -> bool {
    entry.file_name().eq_ignore_ascii_case("desktop.ini")
}

struct Counting<'a> {
    tally: &'a mut Tally,
    observer: &'a dyn Observer,
}

impl Visitor for Counting<'_> {
    fn dir(&mut self, dir: &Path) {
        self.observer.entering(dir);
    }
    fn file(&mut self, path: &Path, md: &Metadata) {
        self.tally.add(path, md.len());
        self.observer.counted(md.len());
    }
    fn unreadable(&mut self) {
        self.tally.blocked = true;
    }
}

/// Adds what the location's rule selects to `tally`. Changes nothing on disk.
pub fn scan_location(
    loc: &Location,
    cutoff: Option<SystemTime>,
    cancel: &AtomicBool,
    tally: &mut Tally,
    observer: &dyn Observer,
) {
    walk(loc, cutoff, cancel, &mut Counting { tally, observer });
}

struct Deleting<'a> {
    outcome: &'a mut Outcome,
    observer: &'a dyn Observer,
}

impl Visitor for Deleting<'_> {
    fn dir(&mut self, dir: &Path) {
        self.observer.entering(dir);
    }
    fn file(&mut self, path: &Path, md: &Metadata) {
        match delete_file(path) {
            Ok(()) => {
                self.outcome.freed += md.len();
                self.outcome.deleted += 1;
                self.observer.counted(md.len());
            }
            Err(Failure::InUse) => self.outcome.in_use += 1,
            Err(Failure::Denied) => self.outcome.denied += 1,
            Err(Failure::Other) => self.outcome.failed += 1,
            // Something else removed it first; the goal is met either way.
            Err(Failure::Gone) => {}
        }
    }
}

/// Deletes what the location's rule selects, adding the result to `outcome`.
///
/// With a `cutoff`, only files left untouched since before it are removed, and a sub-folder
/// is removed only if it was itself that old and ended up empty.
pub fn clean_location(
    loc: &Location,
    cutoff: Option<SystemTime>,
    guard: &Guard,
    cancel: &AtomicBool,
    outcome: &mut Outcome,
    observer: &dyn Observer,
) -> Result<(), Refused> {
    guard.check(&loc.path)?;

    let seen = walk(loc, cutoff, cancel, &mut Deleting { outcome, observer });

    // Children were recorded after their parents, so going backwards empties the deepest
    // folders first. `remove_dir` refuses anything that still has content.
    for (dir, touched) in seen.iter().rev() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if old_enough(*touched, cutoff) {
            let _ = fs::remove_dir(dir);
        }
    }
    Ok(())
}

enum Failure {
    InUse,
    Denied,
    Gone,
    Other,
}

fn delete_file(path: &Path) -> Result<(), Failure> {
    let Err(error) = fs::remove_file(path) else {
        return Ok(());
    };
    match error.raw_os_error() {
        Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION) => Err(Failure::InUse),
        Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) => Err(Failure::Gone),
        Some(ERROR_ACCESS_DENIED) => {
            // A read-only file reports "access denied" too: clear the flag and try once more.
            let cleared = fs::symlink_metadata(path).is_ok_and(|md| {
                let mut permissions = md.permissions();
                permissions.readonly() && {
                    #[allow(clippy::permissions_set_readonly_false)]
                    permissions.set_readonly(false);
                    fs::set_permissions(path, permissions).is_ok()
                }
            });
            if cleared && fs::remove_file(path).is_ok() {
                Ok(())
            } else {
                Err(Failure::Denied)
            }
        }
        _ => Err(Failure::Other),
    }
}

#[cfg(test)]
pub mod testing {
    //! A throw-away, Windows-shaped folder tree for tests.

    use super::*;
    use std::fs::{FileTimes, OpenOptions};
    use std::os::windows::fs::{FileTimesExt, OpenOptionsExt};
    use std::process::Command;
    use std::sync::atomic::AtomicU32;
    use std::time::Duration;

    pub const DAY: Duration = Duration::from_secs(86_400);
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    static NEXT: AtomicU32 = AtomicU32::new(0);

    /// Removed from disk again when dropped.
    pub struct Sandbox {
        pub root: PathBuf,
        pub dirs: Dirs,
    }

    impl Sandbox {
        pub fn new() -> Self {
            let unique = format!(
                "delpheye-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            );
            let root = std::env::temp_dir().join(unique);
            let dirs = Dirs::under(&root);
            for dir in [&dirs.temp, &dirs.roaming, &dirs.windows, &dirs.program_data] {
                fs::create_dir_all(dir).unwrap();
            }
            fs::create_dir_all(dirs.home.join("Documents")).unwrap();
            Self { root, dirs }
        }

        pub fn guard(&self) -> Guard {
            Guard::new(&self.dirs)
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    /// Creates a file of `bytes` bytes, and any folders it needs.
    pub fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![0u8; bytes]).unwrap();
    }

    /// Makes a file or folder look as if it has been left alone for `days` days.
    pub fn age(path: &Path, days: u32) {
        let when = SystemTime::now() - DAY * days;
        let times = FileTimes::new()
            .set_created(when)
            .set_modified(when)
            .set_accessed(when);
        OpenOptions::new()
            .write(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS) // also lets a folder be opened
            .open(path)
            .unwrap()
            .set_times(times)
            .unwrap();
    }

    /// Creates a junction at `link` leading to the folder `to`.
    pub fn junction(link: &Path, to: &Path) {
        let made = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(to)
            .output()
            .unwrap();
        assert!(made.status.success(), "mklink failed: {made:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;

    fn contents(path: PathBuf) -> Location {
        Location {
            path,
            matcher: Matcher::Contents,
        }
    }

    fn scan(loc: &Location, cutoff: Option<SystemTime>) -> Tally {
        let mut tally = Tally::default();
        scan_location(loc, cutoff, &AtomicBool::new(false), &mut tally, &());
        tally
    }

    fn clean(sandbox: &Sandbox, loc: &Location, cutoff: Option<SystemTime>) -> Result<Outcome, Refused> {
        let mut outcome = Outcome::default();
        clean_location(loc, cutoff, &sandbox.guard(), &AtomicBool::new(false), &mut outcome, &())?;
        Ok(outcome)
    }

    fn yesterday() -> Option<SystemTime> {
        Some(SystemTime::now() - DAY)
    }

    #[test]
    fn age_rule_spares_everything_recent() {
        let sandbox = Sandbox::new();
        let temp = &sandbox.dirs.temp;
        write(&temp.join("old.log"), 3_000);
        write(&temp.join("fresh.log"), 500);
        write(&temp.join("old-dir").join("a.bin"), 7_000);
        write(&temp.join("new-dir").join("b.bin"), 1_000);
        for aged in ["old.log", "old-dir\\a.bin", "new-dir\\b.bin", "old-dir"] {
            age(&temp.join(aged), 3);
        }

        let location = contents(temp.clone());
        let found = scan(&location, yesterday());
        assert_eq!((found.files, found.bytes), (3, 11_000));
        assert_eq!(found.largest[0], (7_000, temp.join("old-dir").join("a.bin")));

        let done = clean(&sandbox, &location, yesterday()).unwrap();
        assert_eq!((done.deleted, done.freed, done.skipped()), (3, 11_000, 0));

        assert!(temp.is_dir(), "the location itself stays");
        assert!(temp.join("fresh.log").exists(), "a recent file stays");
        assert!(!temp.join("old.log").exists());
        assert!(!temp.join("old-dir").exists(), "an old, emptied folder goes");
        assert!(temp.join("new-dir").is_dir(), "a recent folder stays even when emptied");
    }

    #[test]
    fn a_file_unpacked_today_with_an_old_date_is_recent() {
        let sandbox = Sandbox::new();
        let file = sandbox.dirs.temp.join("setup-payload.bin");
        write(&file, 100);
        // Only the modification date is old, as after extracting an archive.
        let years_ago = SystemTime::now() - DAY * 900;
        OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(years_ago)
            .unwrap();

        let done = clean(&sandbox, &contents(sandbox.dirs.temp.clone()), yesterday()).unwrap();
        assert_eq!(done.deleted, 0);
        assert!(file.exists());
    }

    #[test]
    fn junctions_are_neither_followed_nor_removed() {
        let sandbox = Sandbox::new();
        let elsewhere = sandbox.root.join("elsewhere");
        write(&elsewhere.join("keep.txt"), 10);
        let cache = sandbox.dirs.local.join("SomeApp").join("Cache");
        write(&cache.join("junk.bin"), 10);
        junction(&cache.join("link"), &elsewhere);

        let location = contents(cache.clone());
        assert_eq!(scan(&location, None).files, 1, "the link's target is not counted");

        let done = clean(&sandbox, &location, None).unwrap();
        assert_eq!(done.deleted, 1);
        assert!(elsewhere.join("keep.txt").exists(), "nothing behind the link is touched");
        assert!(cache.join("link").exists(), "the link itself is left in place");
    }

    #[test]
    fn a_location_that_is_really_a_link_into_documents_is_refused() {
        let sandbox = Sandbox::new();
        let documents = sandbox.dirs.home.join("Documents");
        write(&documents.join("thesis.docx"), 10);
        let disguised = sandbox.dirs.local.join("SomeApp").join("Cache");
        fs::create_dir_all(disguised.parent().unwrap()).unwrap();
        junction(&disguised, &documents);

        assert!(clean(&sandbox, &contents(disguised), None).is_err());
        assert!(documents.join("thesis.docx").exists());
    }

    #[test]
    fn guard_refuses_protected_places_and_allows_caches() {
        let sandbox = Sandbox::new();
        let (dirs, guard) = (&sandbox.dirs, sandbox.guard());

        let refused = [
            sandbox.root.clone(),
            dirs.home.clone(),
            dirs.home.parent().unwrap().to_path_buf(),
            dirs.home.join("AppData"),
            dirs.local.clone(),
            dirs.roaming.clone(),
            dirs.windows.clone(),
            dirs.program_data.clone(),
            dirs.home.join("Documents"),
            dirs.home.join("Documents").join("Work"),
            dirs.home.join("Desktop").join("project"),
            dirs.windows.join("System32"),
            dirs.windows.join("system32").join("drivers"),
            dirs.program_files[0].join("SomeApp").join("Cache"),
            PathBuf::from(r"C:\"),
            PathBuf::from("C:"),
            PathBuf::from(r"Temp\cache"),
            PathBuf::from(r"\\server\share\cache"),
            dirs.temp.join("..").join("..").join("Roaming"),
        ];
        for path in &refused {
            assert!(guard.check(path).is_err(), "{} should be refused", path.display());
        }

        let allowed = [
            dirs.temp.clone(),
            dirs.windows.join("Temp"),
            dirs.windows.join("SoftwareDistribution").join("Download"),
            dirs.local.join("Google").join("Chrome").join("User Data").join("Default").join("Cache"),
            dirs.roaming.join("discord").join("Code Cache"),
            dirs.program_data.join("Microsoft").join("Windows").join("WER").join("ReportQueue"),
        ];
        for path in &allowed {
            assert!(guard.check(path).is_ok(), "{} should be allowed", path.display());
        }
    }

    #[test]
    fn a_refused_location_loses_nothing() {
        let sandbox = Sandbox::new();
        let documents = sandbox.dirs.home.join("Documents");
        write(&documents.join("thesis.docx"), 10);

        assert!(clean(&sandbox, &contents(documents.clone()), None).is_err());
        assert!(clean(&sandbox, &contents(sandbox.dirs.home.clone()), None).is_err());
        assert!(documents.join("thesis.docx").exists());
    }

    #[test]
    fn named_files_match_only_their_pattern() {
        let sandbox = Sandbox::new();
        let explorer = sandbox.dirs.local.join("Microsoft").join("Windows").join("Explorer");
        write(&explorer.join("thumbcache_256.db"), 400);
        write(&explorer.join("ThumbCache_IDX.DB"), 100);
        write(&explorer.join("iconcache_32.db"), 50);
        write(&explorer.join("thumbcache_notes.txt"), 5);
        write(&explorer.join("settings.db"), 5);
        write(&explorer.join("thumbcache_folder.db").join("inner.db"), 5);

        let location = Location {
            path: explorer.clone(),
            matcher: Matcher::FilesNamed {
                prefix: "thumbcache_",
                suffix: ".db",
            },
        };
        assert_eq!(scan(&location, None).bytes, 500);
        assert_eq!(clean(&sandbox, &location, None).unwrap().deleted, 2);

        assert!(!explorer.join("thumbcache_256.db").exists());
        assert!(!explorer.join("ThumbCache_IDX.DB").exists());
        for kept in ["iconcache_32.db", "thumbcache_notes.txt", "settings.db", "thumbcache_folder.db\\inner.db"] {
            assert!(explorer.join(kept).exists(), "{kept} should stay");
        }
    }

    #[test]
    fn single_file_obeys_the_age_rule() {
        let sandbox = Sandbox::new();
        let dump = sandbox.dirs.windows.join("MEMORY.DMP");
        write(&dump, 9_000);
        let location = Location {
            path: dump.clone(),
            matcher: Matcher::SingleFile,
        };

        assert_eq!(clean(&sandbox, &location, yesterday()).unwrap().deleted, 0);
        assert!(dump.exists());

        assert_eq!(clean(&sandbox, &location, None).unwrap().freed, 9_000);
        assert!(!dump.exists());
    }

    #[test]
    fn read_only_files_are_removed() {
        let sandbox = Sandbox::new();
        let file = sandbox.dirs.temp.join("locked-down.tmp");
        write(&file, 10);
        let mut permissions = fs::metadata(&file).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&file, permissions).unwrap();

        let done = clean(&sandbox, &contents(sandbox.dirs.temp.clone()), None).unwrap();
        assert_eq!((done.deleted, done.denied), (1, 0));
        assert!(!file.exists());
    }

    #[test]
    fn a_file_held_open_is_reported_as_in_use() {
        let sandbox = Sandbox::new();
        let busy = sandbox.dirs.temp.join("busy.tmp");
        write(&busy, 10);
        write(&sandbox.dirs.temp.join("idle.tmp"), 20);
        // Sharing mode 0: nobody else may read, write or delete while this handle is open.
        let holder = OpenOptions::new().read(true).share_mode(0).open(&busy).unwrap();

        let done = clean(&sandbox, &contents(sandbox.dirs.temp.clone()), None).unwrap();
        assert_eq!((done.deleted, done.freed, done.in_use), (1, 20, 1));
        assert!(busy.exists());
        drop(holder);
    }

    #[test]
    fn folder_settings_files_are_left_alone() {
        let sandbox = Sandbox::new();
        let cache = sandbox.dirs.local.join("Microsoft").join("Windows").join("INetCache");
        write(&cache.join("desktop.ini"), 10);
        write(&cache.join("IE").join("Desktop.ini"), 10);
        write(&cache.join("IE").join("page.htm"), 10);

        let done = clean(&sandbox, &contents(cache.clone()), None).unwrap();
        assert_eq!(done.deleted, 1);
        assert!(cache.join("desktop.ini").exists());
        assert!(cache.join("IE").join("Desktop.ini").exists());
    }

    #[test]
    fn a_missing_location_is_empty_not_an_error() {
        let sandbox = Sandbox::new();
        let location = contents(sandbox.dirs.local.join("Nope").join("Cache"));
        let found = scan(&location, None);
        assert_eq!((found.files, found.blocked), (0, false));
        assert_eq!(clean(&sandbox, &location, None).unwrap(), Outcome::default());
    }

    #[test]
    fn cancelling_stops_before_anything_is_deleted() {
        let sandbox = Sandbox::new();
        write(&sandbox.dirs.temp.join("a.tmp"), 10);
        let mut outcome = Outcome::default();
        clean_location(
            &contents(sandbox.dirs.temp.clone()),
            None,
            &sandbox.guard(),
            &AtomicBool::new(true),
            &mut outcome,
            &(),
        )
        .unwrap();
        assert_eq!(outcome.deleted, 0);
        assert!(sandbox.dirs.temp.join("a.tmp").exists());
    }

    #[test]
    fn largest_files_are_kept_in_order_and_capped() {
        let sandbox = Sandbox::new();
        for size in 1..=10usize {
            write(&sandbox.dirs.temp.join(format!("{size}.bin")), size * 100);
        }
        let found = scan(&contents(sandbox.dirs.temp.clone()), None);
        let sizes: Vec<u64> = found.largest.iter().map(|entry| entry.0).collect();
        assert_eq!(sizes, [1000, 900, 800, 700, 600, 500]);
    }
}

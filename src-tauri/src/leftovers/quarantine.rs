//! Quarantine: leftovers are moved aside for a week before anything is deleted for good.
//!
//! A folder is moved (renamed) into the app's own store on the same drive, which is instant
//! and keeps everything intact. A registry key is first saved to a `.reg` file with Windows'
//! own `reg.exe`, and only then removed. Restoring puts both back exactly where they were.

use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::journal::Journal;
use crate::system::Dirs;

/// How long things stay in quarantine before they are deleted for good.
pub const HOLD_DAYS: i64 = 7;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_PATH_NOT_FOUND: i32 = 3;
const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_NOT_SAME_DEVICE: i32 = 17;
const ERROR_SHARING_VIOLATION: i32 = 32;

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// Where quarantined things are kept.
pub fn store_root(dirs: &Dirs) -> PathBuf {
    dirs.local.join("com.delpheye.app").join("Quarantine")
}

fn reg_exe(dirs: &Dirs) -> PathBuf {
    dirs.windows.join("System32").join("reg.exe")
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Held {
    pub id: i64,
    pub at: i64,
    pub expires: i64,
    pub name: String,
    pub kind: String,
    pub original: String,
    pub stored: String,
    pub bytes: u64,
    pub admin: bool,
}

/// Why a move could not be done, as a short code the UI translates.
fn reason(error: &std::io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(ERROR_SHARING_VIOLATION | ERROR_ACCESS_DENIED) => "in-use-or-denied",
        Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) => "gone",
        Some(ERROR_NOT_SAME_DEVICE) => "other-drive",
        _ => "failed",
    }
}

/// A new, empty folder in the store for one quarantined thing.
fn new_slot(store: &Path) -> Result<PathBuf, &'static str> {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let slot = store.join(format!("{nanos:x}-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    fs::create_dir_all(&slot).map_err(|_| "store")?;
    Ok(slot)
}

fn record(journal: &Journal, name: &str, kind: &str, original: &str, stored: &Path, bytes: u64, admin: bool) -> Result<i64, &'static str> {
    let at = now();
    journal
        .with(|conn| {
            conn.execute(
                "INSERT INTO quarantine (at, expires, name, kind, original, stored, bytes, admin, state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'held')",
                params![at, at + HOLD_DAYS * 86_400, name, kind, original, stored.to_string_lossy(), bytes as i64, admin],
            )?;
            Ok(conn.last_insert_rowid())
        })
        .map_err(|_| "database")
}

/// Moves `original` into quarantine. On failure nothing has moved.
pub fn hold_folder(journal: &Journal, store: &Path, name: &str, original: &Path, bytes: u64, admin: bool) -> Result<i64, &'static str> {
    let slot = new_slot(store)?;
    let stored = slot.join(original.file_name().ok_or("failed")?);
    if let Err(error) = fs::rename(original, &stored) {
        let _ = fs::remove_dir(&slot);
        return Err(reason(&error));
    }
    record(journal, name, "folder", &original.to_string_lossy(), &stored, bytes, admin).inspect_err(|_| {
        // Without a record there would be no way back, so undo the move.
        let _ = fs::rename(&stored, original);
        let _ = fs::remove_dir(&slot);
    })
}

fn reg(dirs: &Dirs, args: &[&str]) -> bool {
    Command::new(reg_exe(dirs))
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .is_ok_and(|out| out.status.success())
}

/// Saves the registry key `key` (e.g. `HKCU\Software\Foo`) to a file, then removes it.
pub fn hold_key(journal: &Journal, dirs: &Dirs, name: &str, key: &str, admin: bool) -> Result<i64, &'static str> {
    let slot = new_slot(&store_root(dirs))?;
    let file = slot.join("key.reg");
    let file_text = file.to_string_lossy().into_owned();
    if !reg(dirs, &["export", key, &file_text, "/y"]) {
        let _ = fs::remove_dir_all(&slot);
        return Err("failed");
    }
    if !reg(dirs, &["delete", key, "/f"]) {
        let _ = fs::remove_dir_all(&slot);
        return Err("in-use-or-denied");
    }
    record(journal, name, "registry", key, &file, 0, admin).inspect_err(|_| {
        reg(dirs, &["import", &file_text]);
    })
}

fn get(journal: &Journal, id: i64) -> Option<Held> {
    journal
        .with(|conn| {
            conn.query_row(
                "SELECT id, at, expires, name, kind, original, stored, bytes, admin FROM quarantine WHERE id = ?1 AND state = 'held'",
                params![id],
                |row| {
                    Ok(Held {
                        id: row.get(0)?,
                        at: row.get(1)?,
                        expires: row.get(2)?,
                        name: row.get(3)?,
                        kind: row.get(4)?,
                        original: row.get(5)?,
                        stored: row.get(6)?,
                        bytes: row.get::<_, i64>(7)? as u64,
                        admin: row.get(8)?,
                    })
                },
            )
            .optional()
        })
        .ok()
        .flatten()
}

fn set_state(journal: &Journal, id: i64, state: &str) {
    let _ = journal.with(|conn| conn.execute("UPDATE quarantine SET state = ?2 WHERE id = ?1", params![id, state]));
}

/// Everything held right now, newest first.
pub fn list(journal: &Journal) -> Vec<Held> {
    let ids: Vec<i64> = journal
        .with(|conn| {
            let mut query = conn.prepare("SELECT id FROM quarantine WHERE state = 'held' ORDER BY id DESC")?;
            let ids = query.query_map([], |row| row.get(0))?.collect();
            ids
        })
        .unwrap_or_default();
    ids.into_iter().filter_map(|id| get(journal, id)).collect()
}

/// Ids whose week is up.
pub fn expired(journal: &Journal, at: i64) -> Vec<i64> {
    journal
        .with(|conn| {
            let mut query = conn.prepare("SELECT id FROM quarantine WHERE state = 'held' AND expires <= ?1")?;
            let ids = query.query_map(params![at], |row| row.get(0))?.collect();
            ids
        })
        .unwrap_or_default()
}

/// The slot folder holding `stored`, if it really lies directly inside the store.
fn slot_of(store: &Path, stored: &Path) -> Option<PathBuf> {
    let key = |p: &Path| p.to_string_lossy().to_lowercase().trim_end_matches('\\').to_string();
    let slot = match stored.parent() {
        Some(parent) if key(parent) == key(store) => stored.to_path_buf(),
        Some(parent) => parent.to_path_buf(),
        None => return None,
    };
    (slot.parent().map(key) == Some(key(store))).then_some(slot)
}

/// Puts a held thing back where it came from.
pub fn restore(journal: &Journal, dirs: &Dirs, id: i64) -> Result<Held, &'static str> {
    let held = get(journal, id).ok_or("gone")?;
    let stored = PathBuf::from(&held.stored);
    let slot = slot_of(&store_root(dirs), &stored).ok_or("failed")?;
    match held.kind.as_str() {
        "folder" => {
            let original = PathBuf::from(&held.original);
            if original.exists() {
                return Err("exists");
            }
            if let Some(parent) = original.parent() {
                fs::create_dir_all(parent).map_err(|e| reason(&e))?;
            }
            fs::rename(&stored, &original).map_err(|e| reason(&e))?;
        }
        _ => {
            if !reg(dirs, &["import", &held.stored]) {
                return Err("in-use-or-denied");
            }
        }
    }
    let _ = fs::remove_dir_all(slot);
    set_state(journal, id, "restored");
    Ok(held)
}

/// Deletes a held thing for good.
pub fn purge(journal: &Journal, dirs: &Dirs, id: i64) -> Result<Held, &'static str> {
    let held = get(journal, id).ok_or("gone")?;
    // Never delete anything that is not inside the store, whatever the record says.
    let slot = slot_of(&store_root(dirs), Path::new(&held.stored)).ok_or("failed")?;
    match fs::remove_dir_all(&slot) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(reason(&error)),
    }
    set_state(journal, id, "purged");
    Ok(held)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cleanup::testing::{Sandbox, write};

    fn setup() -> (Sandbox, Journal, PathBuf) {
        let sandbox = Sandbox::new();
        let store = store_root(&sandbox.dirs);
        (sandbox, Journal::in_memory(), store)
    }

    #[test]
    fn a_folder_goes_in_and_comes_back_unchanged() {
        let (sandbox, journal, store) = setup();
        let original = sandbox.dirs.roaming.join("OldApp");
        write(&original.join("settings.ini"), 30);
        write(&original.join("cache").join("blob"), 70);

        let id = hold_folder(&journal, &store, "OldApp", &original, 100, false).unwrap();
        assert!(!original.exists());
        let held = list(&journal);
        assert_eq!((held.len(), held[0].id, held[0].bytes, held[0].kind.as_str()), (1, id, 100, "folder"));
        assert_eq!(held[0].expires - held[0].at, HOLD_DAYS * 86_400);
        assert!(Path::new(&held[0].stored).join("settings.ini").exists());

        restore(&journal, &sandbox.dirs, id).unwrap();
        assert_eq!(fs::read(original.join("cache").join("blob")).unwrap().len(), 70);
        assert!(list(&journal).is_empty());
        assert_eq!(fs::read_dir(&store).unwrap().count(), 0, "the empty slot is cleaned up");
        assert_eq!(restore(&journal, &sandbox.dirs, id), Err("gone"), "a second restore does nothing");
    }

    #[test]
    fn restoring_never_overwrites_a_folder_that_came_back_meanwhile() {
        let (sandbox, journal, store) = setup();
        let original = sandbox.dirs.roaming.join("OldApp");
        write(&original.join("a"), 1);
        let id = hold_folder(&journal, &store, "OldApp", &original, 1, false).unwrap();
        write(&original.join("new-install.txt"), 1);

        assert_eq!(restore(&journal, &sandbox.dirs, id), Err("exists"));
        assert!(original.join("new-install.txt").exists());
        assert_eq!(list(&journal).len(), 1, "it stays in quarantine");
    }

    #[test]
    fn purging_deletes_only_inside_the_store() {
        let (sandbox, journal, store) = setup();
        let original = sandbox.dirs.roaming.join("OldApp");
        write(&original.join("a"), 1);
        let id = hold_folder(&journal, &store, "OldApp", &original, 1, false).unwrap();
        let stored = PathBuf::from(&list(&journal)[0].stored);

        purge(&journal, &sandbox.dirs, id).unwrap();
        assert!(!stored.exists());
        assert!(list(&journal).is_empty());

        // A record that somehow points outside the store is refused, and nothing is removed.
        let precious = sandbox.dirs.home.join("Documents");
        write(&precious.join("thesis.docx"), 1);
        let forged = record(&journal, "x", "folder", "x", &precious.join("thesis.docx"), 1, false).unwrap();
        assert_eq!(purge(&journal, &sandbox.dirs, forged), Err("failed"));
        assert!(precious.join("thesis.docx").exists());
    }

    #[test]
    fn a_missing_folder_is_reported_and_leaves_no_trace() {
        let (sandbox, journal, store) = setup();
        let result = hold_folder(&journal, &store, "Ghost", &sandbox.dirs.roaming.join("Ghost"), 0, false);
        assert_eq!(result, Err("gone"));
        assert!(list(&journal).is_empty());
        assert_eq!(fs::read_dir(&store).map(|d| d.count()).unwrap_or(0), 0);
    }

    #[test]
    fn expiry_picks_only_what_is_due() {
        let (sandbox, journal, store) = setup();
        for name in ["A", "B"] {
            write(&sandbox.dirs.roaming.join(name).join("f"), 1);
            hold_folder(&journal, &store, name, &sandbox.dirs.roaming.join(name), 1, false).unwrap();
        }
        assert!(expired(&journal, now()).is_empty());
        assert_eq!(expired(&journal, now() + HOLD_DAYS * 86_400).len(), 2);
    }

    /// Writes to the real registry (a throw-away key under HKCU), so it only runs when asked
    /// for: `cargo test -- --ignored registry`.
    #[test]
    #[ignore]
    fn registry_key_goes_in_and_comes_back() {
        let (sandbox, journal, _) = setup();
        let dirs = Dirs { windows: Dirs::real().unwrap().windows, ..sandbox.dirs.clone() };
        let key = r"HKCU\Software\DelphEyeQuarantineTest";
        assert!(reg(&dirs, &["add", key, "/v", "Probe", "/d", "42", "/f"]));

        let id = hold_key(&journal, &dirs, "Test", key, false).unwrap();
        assert!(!reg(&dirs, &["query", key]));
        restore(&journal, &dirs, id).unwrap();
        assert!(reg(&dirs, &["query", key, "/v", "Probe"]));
        assert!(reg(&dirs, &["delete", key, "/f"]));
    }
}

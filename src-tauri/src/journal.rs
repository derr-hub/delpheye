//! A permanent record of everything the app has changed on the machine.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::system::Dirs;

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS journal (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        at      INTEGER NOT NULL,   -- unix seconds
        kind    TEXT    NOT NULL,   -- which module acted, e.g. 'cleanup'
        bytes   INTEGER NOT NULL,   -- space freed
        files   INTEGER NOT NULL,   -- files removed
        skipped INTEGER NOT NULL,   -- files that could not be removed
        details TEXT    NOT NULL    -- JSON, shaped by `kind`
    );
    CREATE TABLE IF NOT EXISTS quarantine (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       INTEGER NOT NULL,   -- unix seconds
        expires  INTEGER NOT NULL,   -- when it may be deleted for good
        name     TEXT    NOT NULL,   -- the leftover it belonged to
        kind     TEXT    NOT NULL,   -- 'folder' or 'registry'
        original TEXT    NOT NULL,   -- where it came from
        stored   TEXT    NOT NULL,   -- where it is kept now
        bytes    INTEGER NOT NULL,
        admin    INTEGER NOT NULL,   -- 1 if restoring or deleting it needs administrator rights
        state    TEXT    NOT NULL    -- 'held', 'restored' or 'purged'
    );
    CREATE TABLE IF NOT EXISTS cooling_runs (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        at   INTEGER NOT NULL,   -- unix seconds
        data TEXT    NOT NULL    -- JSON cooling profile
    );
    CREATE TABLE IF NOT EXISTS sensor_uses (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        kind    TEXT    NOT NULL,   -- 'webcam' or 'microphone'
        name    TEXT    NOT NULL,
        path    TEXT,
        started INTEGER NOT NULL,   -- unix ms
        stopped INTEGER             -- unix ms; NULL while in use (or if DelphEye closed meanwhile)
    );
    CREATE TABLE IF NOT EXISTS startup_changes (
        id       TEXT    PRIMARY KEY, -- the autostart entry
        original TEXT    NOT NULL,    -- its state before DelphEye first changed it
        data     TEXT    NOT NULL,    -- JSON needed to undo, e.g. a removed registry value
        name     TEXT    NOT NULL,
        at       INTEGER NOT NULL
    );
";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: i64,
    at: i64,
    kind: String,
    bytes: u64,
    files: u64,
    skipped: u64,
    details: serde_json::Value,
}

pub struct Journal(Mutex<Connection>);

impl Journal {
    /// Opens the journal next to the app's other data, or next to the fake tree in the sandbox.
    ///
    /// If the file cannot be opened the journal lives in memory for this run: losing the
    /// record is better than refusing to start.
    pub fn open_for(app: &AppHandle) -> Self {
        let folder = match Dirs::detect().and_then(|dirs| dirs.sandbox) {
            Some(sandbox) => Some(sandbox),
            None => app.path().app_data_dir().ok(),
        };
        let on_disk = folder.and_then(|folder| {
            std::fs::create_dir_all(&folder).ok()?;
            Self::open(&folder.join("journal.db"))
                .inspect_err(|e| eprintln!("journal: cannot open database: {e}"))
                .ok()
        });
        on_disk.unwrap_or_else(|| {
            let conn = Connection::open_in_memory().expect("in-memory database");
            conn.execute_batch(SCHEMA).expect("journal schema");
            Self(Mutex::new(conn))
        })
    }

    /// Runs `ask` with the database, for modules that keep their own tables here.
    pub fn with<T>(&self, ask: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        ask(&self.0.lock().unwrap())
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        Self(Mutex::new(conn))
    }

    fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self(Mutex::new(conn)))
    }

    pub fn add(
        &self,
        kind: &str,
        bytes: u64,
        files: u64,
        skipped: u64,
        details: &serde_json::Value,
    ) -> rusqlite::Result<i64> {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64);
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO journal (at, kind, bytes, files, skipped, details) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![at, kind, bytes as i64, files as i64, skipped as i64, details.to_string()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// The most recent entries, newest first.
    pub fn list(&self, limit: u32) -> rusqlite::Result<Vec<Entry>> {
        let conn = self.0.lock().unwrap();
        let mut query = conn.prepare(
            "SELECT id, at, kind, bytes, files, skipped, details FROM journal ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = query.query_map(params![limit], |row| {
            let details: String = row.get(6)?;
            Ok(Entry {
                id: row.get(0)?,
                at: row.get(1)?,
                kind: row.get(2)?,
                bytes: row.get::<_, i64>(3)? as u64,
                files: row.get::<_, i64>(4)? as u64,
                skipped: row.get::<_, i64>(5)? as u64,
                details: serde_json::from_str(&details).unwrap_or(serde_json::Value::Null),
            })
        })?;
        rows.collect()
    }
}

#[tauri::command]
pub fn journal_list(journal: State<'_, Journal>, limit: u32) -> Result<Vec<Entry>, String> {
    journal.list(limit).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_come_back_newest_first_with_their_details() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let journal = Journal(Mutex::new(conn));

        let first = journal.add("cleanup", 100, 2, 0, &serde_json::json!({ "n": 1 })).unwrap();
        let second = journal.add("cleanup", 5_000_000_000, 7, 3, &serde_json::json!({ "n": 2 })).unwrap();
        assert!(second > first);

        let entries = journal.list(10).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!((entries[0].id, entries[0].bytes, entries[0].skipped), (second, 5_000_000_000, 3));
        assert_eq!(entries[0].details["n"], 2);
        assert_eq!(journal.list(1).unwrap().len(), 1);
    }
}

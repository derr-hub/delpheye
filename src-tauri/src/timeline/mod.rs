//! The computer's memory: what it was like minute by minute, and what changed on it.
//!
//! Everything stays in one local file (`timeline.db`). Readings are kept by the minute for two weeks
//! and by the quarter of an hour for a year and a bit; changes are kept for two years. Readings are
//! gathered in memory and written every few minutes, and the slow looks (programs, startup, event
//! log) run rarely, at background priority, and never over a full-screen game.

mod alarms;
mod changes;
mod code;
mod deep;
mod parts;
mod past;
mod programs;
mod snapshots;

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

const MINUTE_DAYS: i64 = 14;
const QUARTER_DAYS: i64 = 400;
const EVENT_DAYS: i64 = 730;
const DAY: i64 = 86_400;
const FLUSH: Duration = Duration::from_secs(300);
const LOOK_EVERY: Duration = Duration::from_secs(1800);
/// How long the kernel's counters are kept by the minute.
const DEEP_DAYS: i64 = 30;
/// Ticks of the metrics sampler (seconds) between looks at which programs work.
pub const PROGRAMS_EVERY: u32 = programs::EVERY as u32;

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS minutes (
        t INTEGER PRIMARY KEY,       -- unix seconds, start of the minute (or of the quarter once folded)
        n INTEGER NOT NULL,          -- minutes this row stands for
        cpu REAL, ram REAL, cpu_temp REAL, cpu_temp_max REAL, gpu REAL, gpu_temp REAL,
        rx INTEGER, tx INTEGER, free_mb INTEGER,
        hot INTEGER NOT NULL DEFAULT 0,  -- minutes spent throttling
        top TEXT                     -- the program that used the processor most
    );
    CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        t INTEGER NOT NULL,
        kind TEXT NOT NULL,          -- program, driver, update, service, startup, port, appcrash, crash, alert, recorder
        action TEXT NOT NULL,        -- added, removed, changed, happened, dated (installed or updated that day)
        name TEXT NOT NULL,
        was TEXT, now TEXT,          -- the value before and after, when there is one
        source TEXT NOT NULL,        -- 'seen' by DelphEye as it happened, 'windows' from Windows' own records
        day_only INTEGER NOT NULL DEFAULT 0,  -- the time of day is not known
        uniq TEXT NOT NULL UNIQUE,
        detail TEXT                  -- JSON with more, for those kinds that have more to tell
    );
    CREATE INDEX IF NOT EXISTS events_t ON events (t);
    CREATE TABLE IF NOT EXISTS present (
        kind TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, value TEXT,
        PRIMARY KEY (kind, id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS runs (
        start INTEGER NOT NULL, end INTEGER NOT NULL, name TEXT NOT NULL, exe TEXT NOT NULL,
        title TEXT, company TEXT, front INTEGER NOT NULL, cpu REAL NOT NULL, mem INTEGER NOT NULL,
        disk INTEGER NOT NULL, game INTEGER NOT NULL, PRIMARY KEY (exe, start)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS runs_end ON runs (end);
    CREATE TABLE IF NOT EXISTS deep (
        t INTEGER PRIMARY KEY, kernel REAL, user REAL, switches INTEGER, calls INTEGER, hard INTEGER, soft INTEGER,
        read INTEGER, write INTEGER, processes INTEGER, threads INTEGER, handles INTEGER, commit_pct REAL, mains INTEGER, battery INTEGER
    );
    CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY, t INTEGER NOT NULL, name TEXT NOT NULL, auto INTEGER NOT NULL,
        data TEXT NOT NULL           -- JSON: [[kind, id, name, value], …]
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
";

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub t: i64,
    pub kind: String,
    pub action: String,
    pub name: String,
    pub was: Option<String>,
    pub now: Option<String>,
    pub source: String,
    pub day_only: bool,
    pub detail: Option<String>,
    #[serde(skip)]
    pub uniq: String,
}

impl Event {
    fn seen(kind: &str, action: &str, name: &str, was: Option<String>, value: Option<String>) -> Self {
        let t = now();
        let uniq = format!("seen|{t}|{kind}|{action}|{name}|{}", value.as_deref().unwrap_or_default());
        Event { t, kind: kind.into(), action: action.into(), name: name.into(), was, now: value, source: "seen".into(), day_only: false, detail: None, uniq }
    }

    /// From Windows' records. `key` says when two records tell of the same thing.
    fn windows(t: i64, kind: &str, action: &str, name: &str, value: Option<String>, key: &str) -> Self {
        let uniq = format!("windows|{kind}|{action}|{name}|{key}");
        Event { t, kind: kind.into(), action: action.into(), name: name.into(), was: None, now: value, source: "windows".into(), day_only: false, detail: None, uniq }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub t: i64,
    pub n: i64,
    pub cpu: Option<f64>,
    pub ram: Option<f64>,
    pub cpu_temp: Option<f64>,
    pub cpu_temp_max: Option<f64>,
    pub gpu: Option<f64>,
    pub gpu_temp: Option<f64>,
    pub rx: Option<i64>,
    pub tx: Option<i64>,
    pub free_mb: Option<i64>,
    pub hot: i64,
    pub top: Option<String>,
}

// ───────────────────────── storage ─────────────────────────

pub struct Timeline {
    db: Mutex<Connection>,
    pending: Mutex<Vec<Reading>>,
    deep: Mutex<Vec<deep::Deep>>,
    runs: Mutex<Vec<programs::Run>>,
    paused: AtomicBool,
}

impl Timeline {
    pub fn open_for(app: &AppHandle) -> Self {
        let folder = match crate::system::Dirs::detect().and_then(|d| d.sandbox) {
            Some(s) => Some(s),
            None => app.path().app_data_dir().ok(),
        };
        let db = folder
            .and_then(|f| {
                std::fs::create_dir_all(&f).ok()?;
                Connection::open(f.join("timeline.db")).and_then(prepare).inspect_err(|e| crate::errlog::write("timeline", &format!("open: {e}"))).ok()
            })
            .unwrap_or_else(|| prepare(Connection::open_in_memory().expect("in-memory database")).expect("timeline schema"));
        Self::from(db)
    }

    fn from(db: Connection) -> Self {
        let t = Timeline { db: Mutex::new(db), pending: Mutex::new(Vec::new()), deep: Mutex::new(Vec::new()), runs: Mutex::new(Vec::new()), paused: AtomicBool::new(false) };
        let paused = t.kv("paused").as_deref() == Some("1");
        t.paused.store(paused, Ordering::SeqCst);
        t
    }

    fn with<T>(&self, ask: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        ask(&self.db.lock().unwrap())
    }

    fn kv(&self, key: &str) -> Option<String> {
        self.with(|db| db.query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0)).optional()).ok().flatten()
    }

    fn set_kv(&self, key: &str, value: &str) {
        let _ = self.with(|db| db.execute("INSERT INTO kv VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]));
    }

    fn off(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Adds events; those already known are left alone. Returns how many were new.
    fn add(&self, events: &[Event]) -> usize {
        self.with(|db| {
            let tx = db.unchecked_transaction()?;
            let mut n = 0;
            for e in events {
                n += tx.execute(
                    "INSERT OR IGNORE INTO events (t, kind, action, name, was, now, source, day_only, uniq, detail) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    params![e.t, e.kind, e.action, e.name, e.was, e.now, e.source, e.day_only, e.uniq, e.detail],
                )?;
            }
            tx.commit()?;
            Ok(n)
        })
        .inspect_err(|e| crate::errlog::write("timeline", &format!("events: {e}")))
        .unwrap_or(0)
    }

    fn flush(&self) {
        let below = std::mem::take(&mut *self.deep.lock().unwrap());
        let mut runs = std::mem::take(&mut *self.runs.lock().unwrap());
        runs.extend(programs::with(|t| t.going()));
        let done = self.with(|db| {
            deep::save(db, &below)?;
            programs::save(db, &runs)
        });
        if let Err(e) = done {
            crate::errlog::write("timeline", &format!("flush runs: {e}"));
        }
        let rows = std::mem::take(&mut *self.pending.lock().unwrap());
        if rows.is_empty() {
            return;
        }
        let done = self.with(|db| {
            let tx = db.unchecked_transaction()?;
            for r in &rows {
                insert(&tx, r)?;
            }
            tx.commit()
        });
        if let Err(e) = done {
            crate::errlog::write("timeline", &format!("flush: {e}"));
        }
    }

    /// Folds old minutes into quarters of an hour and drops what is past its time.
    fn tidy(&self, at: i64) {
        let done = self.with(|db| {
            let fold = (at - MINUTE_DAYS * DAY).div_euclid(900) * 900;
            let tx = db.unchecked_transaction()?;
            let folded: Vec<Reading> = {
                let mut q = tx.prepare(
                    "SELECT (t / 900) * 900, SUM(n),
                        SUM(cpu * n) / SUM(CASE WHEN cpu IS NOT NULL THEN n END),
                        SUM(ram * n) / SUM(CASE WHEN ram IS NOT NULL THEN n END),
                        SUM(cpu_temp * n) / SUM(CASE WHEN cpu_temp IS NOT NULL THEN n END),
                        MAX(cpu_temp_max),
                        SUM(gpu * n) / SUM(CASE WHEN gpu IS NOT NULL THEN n END),
                        MAX(gpu_temp), CAST(AVG(rx) AS INTEGER), CAST(AVG(tx) AS INTEGER), MIN(free_mb), SUM(hot),
                        (SELECT b.top FROM minutes b WHERE b.t >= (minutes.t / 900) * 900 AND b.t < (minutes.t / 900) * 900 + 900 AND b.top IS NOT NULL
                         GROUP BY b.top ORDER BY COUNT(*) DESC LIMIT 1)
                     FROM minutes WHERE t < ?1 GROUP BY t / 900 HAVING COUNT(*) > 1",
                )?;
                q.query_map([fold], reading)?.collect::<rusqlite::Result<_>>()?
            };
            for r in &folded {
                tx.execute("DELETE FROM minutes WHERE t >= ?1 AND t < ?1 + 900", [r.t])?;
                insert(&tx, r)?;
            }
            tx.execute("DELETE FROM minutes WHERE t < ?1", [at - QUARTER_DAYS * DAY])?;
            tx.execute("DELETE FROM events WHERE t < ?1", [at - EVENT_DAYS * DAY])?;
            tx.execute("DELETE FROM runs WHERE end < ?1", [at - QUARTER_DAYS * DAY])?;
            tx.execute("DELETE FROM deep WHERE t < ?1", [at - DEEP_DAYS * DAY])?;
            tx.commit()?;
            db.execute_batch("PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);")
        });
        if let Err(e) = done {
            crate::errlog::write("timeline", &format!("tidy: {e}"));
        }
    }

    /// Readings averaged over `step` seconds (as stored when it is a minute).
    fn thinned(&self, from: i64, to: i64, step: i64) -> Vec<Reading> {
        let rows = self.readings(from, to);
        if step <= 60 {
            return rows;
        }
        let mut out: Vec<Reading> = Vec::new();
        let mut group: Vec<Reading> = Vec::new();
        for r in rows {
            if group.first().is_some_and(|g| g.t.div_euclid(step) != r.t.div_euclid(step)) {
                out.extend(merge(&group, step));
                group.clear();
            }
            group.push(r);
        }
        out.extend(merge(&group, step));
        out
    }

    fn readings(&self, from: i64, to: i64) -> Vec<Reading> {
        let mut v: Vec<Reading> = self
            .with(|db| {
                let mut q = db.prepare("SELECT t, n, cpu, ram, cpu_temp, cpu_temp_max, gpu, gpu_temp, rx, tx, free_mb, hot, top FROM minutes WHERE t >= ?1 AND t < ?2 ORDER BY t")?;
                q.query_map([from, to], reading)?.collect()
            })
            .unwrap_or_default();
        v.extend(self.pending.lock().unwrap().iter().filter(|r| r.t >= from && r.t < to).cloned());
        v
    }

    fn events(&self, from: i64, to: i64) -> Vec<Event> {
        self.with(|db| {
            let mut q = db.prepare("SELECT t, kind, action, name, was, now, source, day_only, detail FROM events WHERE t >= ?1 AND t < ?2 ORDER BY t")?;
            q.query_map([from, to], |r| {
                Ok(Event { t: r.get(0)?, kind: r.get(1)?, action: r.get(2)?, name: r.get(3)?, was: r.get(4)?, now: r.get(5)?, source: r.get(6)?, day_only: r.get(7)?, detail: r.get(8)?, uniq: String::new() })
            })?
            .collect()
        })
        .unwrap_or_default()
    }
}

/// Several readings as one: averages by time, the hottest moment, the program busiest most often.
fn merge(group: &[Reading], step: i64) -> Option<Reading> {
    let first = group.first()?;
    let mean = |get: fn(&Reading) -> Option<f64>| {
        let (sum, n) = group.iter().filter_map(|r| Some((get(r)? * r.n as f64, r.n))).fold((0.0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
        (n > 0).then(|| tenth(sum / n as f64))
    };
    let max = |get: fn(&Reading) -> Option<f64>| group.iter().filter_map(get).fold(None, |a: Option<f64>, b| Some(a.map_or(b, |a| a.max(b))));
    let mut tops: HashMap<&str, i64> = HashMap::new();
    for r in group {
        if let Some(t) = &r.top {
            *tops.entry(t).or_default() += r.n;
        }
    }
    Some(Reading {
        t: first.t.div_euclid(step) * step,
        n: group.iter().map(|r| r.n).sum(),
        cpu: mean(|r| r.cpu),
        ram: mean(|r| r.ram),
        cpu_temp: mean(|r| r.cpu_temp),
        cpu_temp_max: max(|r| r.cpu_temp_max),
        gpu: mean(|r| r.gpu),
        gpu_temp: max(|r| r.gpu_temp),
        rx: mean(|r| r.rx.map(|v| v as f64)).map(|v| v as i64),
        tx: mean(|r| r.tx.map(|v| v as f64)).map(|v| v as i64),
        free_mb: group.iter().filter_map(|r| r.free_mb).min(),
        hot: group.iter().map(|r| r.hot).sum(),
        top: tops.into_iter().max_by_key(|(_, n)| *n).map(|(t, _)| t.to_string()),
    })
}

fn prepare(db: Connection) -> rusqlite::Result<Connection> {
    db.execute_batch("PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON;")?;
    db.execute_batch(SCHEMA)?;
    Ok(db)
}

fn insert(db: &Connection, r: &Reading) -> rusqlite::Result<usize> {
    db.execute(
        "INSERT OR REPLACE INTO minutes (t, n, cpu, ram, cpu_temp, cpu_temp_max, gpu, gpu_temp, rx, tx, free_mb, hot, top) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![r.t, r.n, r.cpu, r.ram, r.cpu_temp, r.cpu_temp_max, r.gpu, r.gpu_temp, r.rx, r.tx, r.free_mb, r.hot, r.top],
    )
}

fn reading(r: &rusqlite::Row) -> rusqlite::Result<Reading> {
    Ok(Reading {
        t: r.get(0)?,
        n: r.get(1)?,
        cpu: r.get(2)?,
        ram: r.get(3)?,
        cpu_temp: r.get(4)?,
        cpu_temp_max: r.get(5)?,
        gpu: r.get(6)?,
        gpu_temp: r.get(7)?,
        rx: r.get(8)?,
        tx: r.get(9)?,
        free_mb: r.get(10)?,
        hot: r.get(11)?,
        top: r.get(12)?,
    })
}

// ───────────────────────── readings ─────────────────────────

#[derive(Default)]
struct Minute {
    n: u32,
    cpu: f64,
    ram: f64,
    rx: f64,
    tx: f64,
    busiest: HashMap<String, f32>,
}

static MINUTE: Mutex<Option<Minute>> = Mutex::new(None);

/// One second from the metrics sampler.
pub fn note(cpu: f32, ram: f64, rx: u64, tx: u64, busiest: Option<(String, f32)>) {
    let mut slot = MINUTE.lock().unwrap();
    let m = slot.get_or_insert_with(Minute::default);
    m.n += 1;
    m.cpu += cpu as f64;
    m.ram += ram;
    m.rx += rx as f64;
    m.tx += tx as f64;
    if let Some((name, load)) = busiest {
        *m.busiest.entry(name).or_default() += load;
    }
}

fn tenth(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// Closes the minute, adding what the once-a-minute sampler knows.
pub fn minute(app: &AppHandle, cpu_temp: Option<f64>, gpu_temp: Option<f64>, gpu: Option<f64>, hot: bool, free: Option<u64>) {
    let Some(m) = MINUTE.lock().unwrap().take() else { return };
    let line = app.state::<Timeline>();
    if line.off() || m.n == 0 {
        return;
    }
    let n = m.n as f64;
    // A program counts as "busiest" only if it used a noticeable share.
    let top = m.busiest.into_iter().max_by(|a, b| a.1.total_cmp(&b.1)).filter(|(_, sum)| *sum as f64 / n >= 1.0).map(|(name, _)| name);
    let reading = Reading {
        t: now() / 60 * 60,
        n: 1,
        cpu: Some(tenth(m.cpu / n)),
        ram: Some(tenth(m.ram / n)),
        cpu_temp: cpu_temp.map(tenth),
        cpu_temp_max: cpu_temp.map(tenth),
        gpu: gpu.map(tenth),
        gpu_temp: gpu_temp.map(tenth),
        rx: Some((m.rx / n) as i64),
        tx: Some((m.tx / n) as i64),
        free_mb: free.map(|b| (b / 1_048_576) as i64),
        hot: hot as i64,
        top,
    };
    if let Some(d) = deep::sample(now()) {
        line.deep.lock().unwrap().push(d);
    }
    let raised = alarms::check(&reading, now());
    if !raised.is_empty() {
        line.add(&raised);
    }
    line.pending.lock().unwrap().push(reading);
}

// ───────────────────────── the recorder ─────────────────────────

/// Which programs work now; called every few seconds.
pub fn programs_look(app: &AppHandle) {
    let Some(line) = app.try_state::<Timeline>() else { return };
    if line.off() {
        return;
    }
    let (front, full) = (programs::front(), full_screen());
    let ended = crate::processes::peek(|s| programs::with(|t| t.look(s, front, full, now())));
    if !ended.is_empty() {
        line.runs.lock().unwrap().extend(ended);
    }
}

/// A game or a presentation fills the screen: nothing slow runs now.
fn full_screen() -> bool {
    use windows::Win32::UI::Shell::{QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState};
    // SAFETY: no arguments; only returns a value.
    unsafe { SHQueryUserNotificationState() }.is_ok_and(|s| s == QUNS_RUNNING_D3D_FULL_SCREEN || s == QUNS_BUSY || s == QUNS_PRESENTATION_MODE)
}

/// One slow look: what is installed now, and what Windows noted since the last look.
fn look(line: &Timeline) {
    let Some(dirs) = crate::system::Dirs::real() else { return };
    changes::look(line, &dirs.windows);
    past::look(line, &dirs.windows);
    snapshots::keep(line, now());
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN};
        // SAFETY: lowers the priority (processor, disk, memory) of this thread only.
        unsafe {
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
        }
        std::thread::sleep(Duration::from_secs(90));
        let line = app.state::<Timeline>();
        let (mut flushed, mut looked, mut tidied) = (Instant::now(), None::<Instant>, None::<Instant>);
        loop {
            if !line.off() {
                if flushed.elapsed() >= FLUSH {
                    line.flush();
                    flushed = Instant::now();
                }
                if looked.is_none_or(|t| t.elapsed() >= LOOK_EVERY) && !full_screen() {
                    look(&line);
                    looked = Some(Instant::now());
                }
                if tidied.is_none_or(|t| t.elapsed() >= Duration::from_secs(DAY as u64)) {
                    line.tidy(now());
                    tidied = Some(Instant::now());
                }
            }
            std::thread::sleep(Duration::from_secs(20));
        }
    });
}

/// Writes what is still in memory; called when the app closes.
pub fn close(app: &AppHandle) {
    app.state::<Timeline>().flush();
}

// ───────────────────────── commands ─────────────────────────

#[tauri::command]
pub async fn timeline_readings(app: AppHandle, from: i64, to: i64, step: i64) -> Vec<Reading> {
    app.state::<Timeline>().thinned(from, to, step)
}

#[tauri::command]
pub async fn timeline_events(app: AppHandle, from: i64, to: i64) -> Vec<Event> {
    app.state::<Timeline>().events(from, to)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    paused: bool,
    bytes: i64,
    readings: i64,
    events: i64,
    /// The first minute DelphEye saw itself, and the oldest event of any source.
    first_reading: Option<i64>,
    first_event: Option<i64>,
    by_kind: Vec<(String, String, i64)>,
    /// Since when each kind (program, startup, port) is watched directly.
    looked: Vec<(String, i64)>,
    snapshots: i64,
}

fn stats(line: &Timeline) -> Option<Stats> {
    line.with(|db| {
        let one = |sql: &str| db.query_row(sql, [], |r| r.get::<_, Option<i64>>(0));
        let mut q = db.prepare("SELECT kind, source, COUNT(*) FROM events GROUP BY kind, source ORDER BY 3 DESC")?;
        Ok(Stats {
            paused: line.off(),
            bytes: one("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()")?.unwrap_or(0),
            readings: one("SELECT COUNT(*) FROM minutes")?.unwrap_or(0),
            events: one("SELECT COUNT(*) FROM events")?.unwrap_or(0),
            first_reading: one("SELECT MIN(t) FROM minutes")?,
            first_event: one("SELECT MIN(t) FROM events")?,
            by_kind: q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?,
            looked: db.prepare("SELECT substr(key, 8), CAST(value AS INTEGER) FROM kv WHERE key LIKE 'looked:%'")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?,
            snapshots: one("SELECT COUNT(*) FROM snapshots")?.unwrap_or(0),
        })
    })
    .ok()
}

#[tauri::command]
pub async fn timeline_stats(app: AppHandle) -> Option<Stats> {
    stats(&app.state::<Timeline>())
}

/// Programs that worked between two moments, those still working included.
#[tauri::command]
pub async fn timeline_runs(app: AppHandle, from: i64, to: i64) -> Vec<programs::Run> {
    let line = app.state::<Timeline>();
    let mut out = line.with(|db| programs::load(db, from, to)).unwrap_or_default();
    let fresh: Vec<programs::Run> = line.runs.lock().unwrap().iter().cloned().chain(programs::with(|t| t.going())).collect();
    for r in fresh.into_iter().filter(|r| r.end >= from && r.start < to) {
        match out.iter_mut().find(|o| o.exe == r.exe && o.start == r.start) {
            Some(o) => *o = programs::Run { title: o.title.take(), company: o.company.take(), ..r },
            None => out.push(r),
        }
    }
    out.sort_by_key(|r| r.start);
    out
}

#[tauri::command]
pub async fn timeline_deep(app: AppHandle, from: i64, to: i64) -> Vec<deep::Deep> {
    let line = app.state::<Timeline>();
    let mut out = line.with(|db| deep::load(db, from, to)).unwrap_or_default();
    out.extend(line.deep.lock().unwrap().iter().filter(|d| d.t >= from && d.t < to).cloned());
    out
}

/// The files behind an event.
#[tauri::command]
pub async fn timeline_parts(kind: String, name: String, now: Option<String>) -> Vec<parts::Part> {
    tauri::async_runtime::spawn_blocking(move || crate::system::Dirs::real().map(|d| parts::find(&kind, &name, now.as_deref(), &d.windows)).unwrap_or_default()).await.unwrap_or_default()
}

/// The interface names Windows' own files by `%SystemRoot%`: Windows is not always on C:.
fn own(path: String) -> String {
    if path.starts_with("%SystemRoot%") { crate::startup::expand(&path) } else { path }
}

/// A local file as the machine sees it; for a crash, the instructions at its address.
#[tauri::command]
pub async fn timeline_code(path: String, offset: Option<String>, stamp: Option<String>, symbol: Option<String>) -> Option<code::Code> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = own(path);
        let file = std::path::PathBuf::from(&path);
        if !file.is_absolute() || path.starts_with(r"\\") {
            return None;
        }
        let hex = |s: Option<String>| s.and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok());
        code::read(&file, hex(offset), hex(stamp).map(|s| s as u32), symbol.as_deref())
    })
    .await
    .ok()
    .flatten()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Maker {
    exists: bool,
    company: Option<String>,
    description: Option<String>,
    signed: Option<bool>,
    /// Part of Windows: inside its folder and made by Microsoft.
    windows: bool,
}

/// Whose file a crashed module is. Only reads it.
#[tauri::command]
pub async fn timeline_module(path: String) -> Option<Maker> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = own(path);
        let file = std::path::PathBuf::from(&path);
        // A local file only: a network path would reach out to another computer.
        if !file.is_absolute() || path.starts_with(r"\\") {
            return None;
        }
        let f = crate::startup::fileinfo::inspect(&file, true);
        let inside = crate::system::Dirs::real().is_some_and(|d| path.to_lowercase().starts_with(&d.windows.to_string_lossy().to_lowercase()));
        let windows = inside && f.company.as_deref().is_some_and(|c| c.contains("Microsoft"));
        // Windows' own files are signed through its catalogue, which a look at the file alone does not see.
        let signed = if inside { f.signed.filter(|s| *s) } else { f.signed };
        Some(Maker { exists: f.exists, company: f.company, description: f.description, signed, windows })
    })
    .await
    .ok()
    .flatten()
}

/// What is on the computer now, as of the last look.
#[tauri::command]
pub async fn timeline_present(app: AppHandle) -> Vec<snapshots::Row> {
    snapshots::present(&app.state::<Timeline>())
}

#[tauri::command]
pub async fn timeline_snapshots(app: AppHandle) -> Vec<snapshots::Snapshot> {
    snapshots::list(&app.state::<Timeline>())
}

#[tauri::command]
pub async fn timeline_snapshot_make(app: AppHandle, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let line = app.state::<Timeline>();
        if let Some(dirs) = crate::system::Dirs::real() {
            changes::look(&line, &dirs.windows);
        }
        snapshots::make(&line, now(), name.trim(), false).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn timeline_snapshot_get(app: AppHandle, id: i64) -> Option<Vec<snapshots::Row>> {
    snapshots::get(&app.state::<Timeline>(), id)
}

#[tauri::command]
pub async fn timeline_snapshot_delete(app: AppHandle, id: i64) -> Result<(), String> {
    snapshots::delete(&app.state::<Timeline>(), id).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn timeline_pause(line: State<'_, Timeline>, on: bool) {
    if on {
        line.flush();
    }
    line.paused.store(on, Ordering::SeqCst);
    line.set_kv("paused", if on { "1" } else { "0" });
    line.add(&[Event::seen("recorder", if on { "removed" } else { "added" }, "pause", None, None)]);
}

/// Forgets everything. Deleted pages are overwritten, not just unlinked.
#[tauri::command]
pub async fn timeline_erase(app: AppHandle) -> Result<(), String> {
    let line = app.state::<Timeline>();
    line.pending.lock().unwrap().clear();
    line.deep.lock().unwrap().clear();
    line.runs.lock().unwrap().clear();
    programs::with(|t| *t = Default::default());
    // Windows' own records are older than this moment: they are not read back in afterwards.
    let at = now().to_string();
    line.with(|db| {
        db.execute_batch("DELETE FROM minutes; DELETE FROM events; DELETE FROM present; DELETE FROM snapshots; DELETE FROM runs; DELETE FROM deep; DELETE FROM kv WHERE key <> 'paused';")?;
        db.execute("INSERT INTO kv VALUES ('past', ?1), ('from', ?1)", [&at])?;
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn memory() -> Timeline {
        Timeline::from(prepare(Connection::open_in_memory().unwrap()).unwrap())
    }

    #[test]
    fn old_minutes_fold_into_quarters() {
        let line = memory();
        let at = 2_000_000_000 / 900 * 900;
        let old = at - 20 * DAY;
        for i in 0..15 {
            line.pending.lock().unwrap().push(Reading {
                t: old + i * 60,
                n: 1,
                cpu: Some(if i < 5 { 100.0 } else { 10.0 }),
                cpu_temp: (i == 0).then_some(80.0),
                cpu_temp_max: (i == 0).then_some(80.0),
                hot: (i < 2) as i64,
                top: Some(if i < 5 { "game" } else { "idle" }.into()),
                ..Default::default()
            });
        }
        line.pending.lock().unwrap().push(Reading { t: at - 60, n: 1, cpu: Some(5.0), ..Default::default() });
        line.flush();
        line.tidy(at);
        line.tidy(at);
        let r = line.readings(0, at);
        assert_eq!(r.len(), 2);
        assert_eq!((r[0].n, r[0].cpu, r[0].cpu_temp, r[0].cpu_temp_max, r[0].hot, r[0].top.as_deref()), (15, Some(40.0), Some(80.0), Some(80.0), 2, Some("idle")));
        assert_eq!(r[1].n, 1);
        line.tidy(at + 500 * DAY);
        assert!(line.readings(0, at).is_empty());
    }

    #[test]
    fn a_wide_view_is_thinned() {
        let line = memory();
        for i in 0..10 {
            line.pending.lock().unwrap().push(Reading { t: i * 60, n: 1, cpu: Some(i as f64 * 10.0), cpu_temp_max: Some(50.0 + i as f64), hot: (i == 9) as i64, top: Some(if i < 4 { "a" } else { "b" }.into()), ..Default::default() });
        }
        assert_eq!(line.thinned(0, 600, 60).len(), 10);
        let r = line.thinned(0, 600, 300);
        assert_eq!(r.iter().map(|r| (r.t, r.n, r.cpu, r.cpu_temp_max, r.hot)).collect::<Vec<_>>(), vec![(0, 5, Some(20.0), Some(54.0), 0), (300, 5, Some(70.0), Some(59.0), 1)]);
        assert_eq!(r[0].top.as_deref(), Some("a"));
        assert!(line.thinned(5000, 6000, 300).is_empty());
    }

    #[test]
    fn the_same_record_is_kept_once() {
        let line = memory();
        let e = Event::windows(10, "driver", "added", "NVIDIA", Some("1".into()), "1");
        assert_eq!(line.add(&[e.clone(), e.clone()]), 1);
        assert_eq!(line.add(&[e]), 0);
        assert_eq!(line.events(0, 100).len(), 1);
    }

    #[test]
    fn a_full_year_stays_small() {
        let file = std::env::temp_dir().join(format!("delpheye-timeline-{}.db", std::process::id()));
        let line = Timeline::from(prepare(Connection::open(&file).unwrap()).unwrap());
        let full = |t: i64, n: i64| Reading {
            t,
            n,
            cpu: Some(12.3),
            ram: Some(64.1),
            cpu_temp: Some(71.5),
            cpu_temp_max: Some(93.2),
            gpu: Some(17.1),
            gpu_temp: Some(55.1),
            rx: Some(1_234_567),
            tx: Some(234_567),
            free_mb: Some(36_123),
            hot: 0,
            top: Some("chrome.exe".into()),
        };
        {
            let mut p = line.pending.lock().unwrap();
            (0..386 * 96).for_each(|i| p.push(full(i * 900, 15)));
            (0..14 * 1440).for_each(|i| p.push(full(400 * DAY + i * 60, 1)));
        }
        line.flush();
        let bytes = stats(&line).unwrap().bytes;
        drop(line);
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", file.display()));
        }
        eprintln!("a full year of readings takes {:.1} MB", bytes as f64 / 1e6);
        assert!(bytes < 12_000_000, "{bytes}");
    }

    /// Reads this very computer; run by hand: cargo test --lib timeline::tests::live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live() {
        let line = memory();
        for round in 0..2 {
            let t = Instant::now();
            look(&line);
            eprintln!("look {round}: {:?}, {} events", t.elapsed(), line.events(0, i64::MAX).len());
        }
        eprintln!("{:#?}", stats(&line).map(|s| (s.by_kind, s.first_event)));
        for kind in ["driver", "update", "service", "program", "appcrash", "crash"] {
            let all: Vec<Event> = line.events(0, i64::MAX).into_iter().filter(|e| e.kind == kind).collect();
            eprintln!("── {kind}: {}", all.len());
            for e in all.iter().rev().take(9) {
                let value: String = e.now.clone().unwrap_or_default().replace(char::is_control, "; ").chars().take(70).collect();
                eprintln!("{} {} {} | {value}", e.t, e.action, e.name);
            }
        }
    }
}

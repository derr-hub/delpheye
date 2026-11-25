//! Startup & services: everything that starts with Windows, what it costs, and a safe way to
//! switch it off.
//!
//! Beyond what Task Manager shows, each entry carries its publisher and signature, what it
//! uses right now, how much it slowed down recent boots (from Windows' own boot diagnostics,
//! when running as administrator), and plain advice. Every change is remembered, so any of
//! them — or all of them at once — can be undone.

pub(crate) mod advice;
pub(crate) mod fileinfo;
mod sources;

pub use sources::{decode, expand};
pub(crate) use sources::resolve_text;
pub(crate) use sources::service_states;

use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::State;

use crate::journal::Journal;
use crate::system::{self, Dirs};
use advice::{Advice, Category};
use sources::{Kind, Raw, StartType, Switch};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MB: u64 = 1024 * 1024;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Impact {
    None,
    Low,
    Medium,
    High,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Footprint {
    processes: u32,
    memory: u64,
    cpu_seconds: u64,
    read_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Changed {
    original: String,
    at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: String,
    kind: Kind,
    name: String,
    command: String,
    program: Option<String>,
    location: String,
    /// Applies to every user of this computer.
    machine: bool,
    enabled: bool,
    /// Services only.
    start: Option<StartType>,
    running: bool,
    publisher: Option<String>,
    description: Option<String>,
    signed: Option<bool>,
    exists: bool,
    category: Category,
    advice: Advice,
    reasons: Vec<&'static str>,
    /// Changing it needs administrator rights.
    needs_admin: bool,
    /// Part of Windows or of Microsoft's own system software.
    windows: bool,
    /// Windows' own components are shown but not changed from here.
    editable: bool,
    /// A dead `Run` value can be removed (and put back from the change list).
    removable: bool,
    footprint: Footprint,
    impact: Impact,
    /// How much this program slowed recent boots, per Windows' boot diagnostics.
    boot_delay_ms: Option<u64>,
    changed: Option<Changed>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Boot {
    /// ISO time of the boot.
    at: String,
    total_ms: u64,
    /// Until the desktop appeared.
    main_ms: u64,
    /// After the desktop appeared, until the system settled.
    post_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    elevated: bool,
    entries: Vec<Entry>,
    boots: Vec<Boot>,
    /// Dead entries DelphEye removed; each can be put back.
    removed: Vec<Removed>,
    duration_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    id: String,
    name: String,
    at: i64,
}

fn removed(journal: &Journal) -> Vec<Removed> {
    journal
        .with(|conn| {
            let mut query = conn.prepare("SELECT id, name, at FROM startup_changes WHERE original = 'present' ORDER BY at DESC")?;
            let rows = query.query_map([], |r| Ok(Removed { id: r.get(0)?, name: r.get(1)?, at: r.get(2)? }))?;
            rows.collect()
        })
        .unwrap_or_default()
}

/// Recent boots and per-program slow-downs, from the boot diagnostics log (administrators only).
#[derive(Default, Debug, PartialEq)]
struct Diagnostics {
    boots: Vec<Boot>,
    /// Lower-cased program file or service name → worst slow-down seen, in ms.
    delays: HashMap<String, u64>,
}

fn parse_diagnostics(xml: &str) -> Diagnostics {
    let wrapped = format!("<Events>{xml}</Events>");
    let Ok(doc) = roxmltree::Document::parse(&wrapped) else { return Diagnostics::default() };
    let mut found = Diagnostics::default();
    for event in doc.root_element().children().filter(|n| n.has_tag_name("Event")) {
        let system = event.children().find(|n| n.has_tag_name("System"));
        let id: u32 = system
            .and_then(|s| s.children().find(|n| n.has_tag_name("EventID")))
            .and_then(|n| n.text())
            .and_then(|t| t.trim().parse().ok())
            .unwrap_or(0);
        let at = system
            .and_then(|s| s.children().find(|n| n.has_tag_name("TimeCreated")))
            .and_then(|n| n.attribute("SystemTime"))
            .unwrap_or_default()
            .to_string();
        let data: HashMap<&str, &str> = event
            .descendants()
            .filter(|n| n.has_tag_name("Data"))
            .filter_map(|n| Some((n.attribute("Name")?, n.text().unwrap_or("").trim())))
            .collect();
        let number = |key: &str| data.get(key).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        match id {
            100 => found.boots.push(Boot { at, total_ms: number("BootTime"), main_ms: number("MainPathBootTime"), post_ms: number("BootPostBootTime") }),
            101 | 103 => {
                if let Some(name) = data.get("Name").filter(|n| !n.is_empty()) {
                    let delay = number("DegradationTime");
                    let worst = found.delays.entry(name.to_lowercase()).or_insert(0);
                    *worst = (*worst).max(delay);
                }
            }
            _ => {}
        }
    }
    found.boots.truncate(5);
    found
}

fn read_diagnostics(windows: &Path) -> Diagnostics {
    let output = Command::new(windows.join("System32").join("wevtutil.exe"))
        .args([
            "qe",
            "Microsoft-Windows-Diagnostics-Performance/Operational",
            "/q:*[System[(EventID=100 or EventID=101 or EventID=103)]]",
            "/c:300",
            "/rd:true",
            "/f:xml",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(out) if out.status.success() => parse_diagnostics(&String::from_utf8_lossy(&out.stdout)),
        _ => Diagnostics::default(),
    }
}

/// What every running program uses: lower-cased exe path → (pid, memory, cpu ms, bytes read).
fn processes() -> Vec<(String, u32, u64, u64, u64)> {
    let Ok(mut sys) = System::new() else { return Vec::new() };
    let kind = ProcessRefreshKind::nothing().with_exe(UpdateKind::Always).with_memory().with_cpu().with_disk_usage();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    sys.processes()
        .values()
        // Without administrator rights Windows hides where system processes run from; keep them
        // anyway, since services are matched by process id.
        .map(|p| {
            let exe = p.exe().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            (exe, p.pid().as_u32(), p.memory(), p.accumulated_cpu_time(), p.disk_usage().total_read_bytes)
        })
        .collect()
}

fn lower(path: &Path) -> String {
    path.to_string_lossy().to_lowercase().trim_end_matches('\\').to_string()
}

/// The processes an entry accounts for: its own program, plus helpers living in the same
/// folder (Steam, Discord and most launchers spawn several). Shared system folders only
/// count an exact match.
fn footprint(raw: &Raw, running: &[(String, u32, u64, u64, u64)], dirs: &Dirs) -> Footprint {
    let mut total = Footprint::default();
    let mut add = |(_, _, memory, cpu, read): &(String, u32, u64, u64, u64)| {
        total.processes += 1;
        total.memory += memory;
        total.cpu_seconds += cpu / 1000;
        total.read_bytes += read;
    };
    if let Some(service) = raw.service.as_ref().filter(|s| s.pid != 0 && !s.shared) {
        running.iter().filter(|p| p.1 == service.pid).for_each(&mut add);
        return total;
    }
    let Some(program) = &raw.program else { return total };
    let exact = lower(program);
    let folder = program.parent().map(lower).unwrap_or_default();
    let shared_folder = folder.is_empty()
        || folder.starts_with(&lower(&dirs.windows))
        || dirs.program_files.iter().any(|pf| lower(pf) == folder)
        || folder.matches('\\').count() < 2;
    for process in running.iter().filter(|p| !p.0.is_empty()) {
        let in_folder = !shared_folder && process.0.starts_with(&folder) && process.0.as_bytes().get(folder.len()) == Some(&b'\\');
        if process.0 == exact || in_folder {
            add(process);
        }
    }
    total
}

fn impact(footprint: &Footprint, boot_delay_ms: Option<u64>) -> Impact {
    let delay = boot_delay_ms.unwrap_or(0);
    let (cpu, memory, read) = (footprint.cpu_seconds, footprint.memory, footprint.read_bytes);
    if cpu > 300 || memory > 500 * MB || read > 1024 * MB || delay > 5_000 {
        Impact::High
    } else if cpu > 30 || memory > 150 * MB || read > 200 * MB || delay > 1_500 {
        Impact::Medium
    } else if footprint.processes > 0 || delay > 0 {
        Impact::Low
    } else {
        Impact::None
    }
}

/// The program behind a startup entry, by the name it is listed under.
pub fn program_of(windows: &Path, name: &str) -> Option<std::path::PathBuf> {
    sources::collect(windows).into_iter().find(|r| r.name == name).and_then(|r| r.program)
}

/// What starts with Windows, for the background watcher: (id, name). Windows' own scheduled
/// tasks and services inside the Windows folder are left out — updates add and remove those.
pub fn watch_list(windows: &Path) -> Vec<(String, String)> {
    sources::collect(windows)
        .into_iter()
        .filter(|r| match &r.switch {
            Switch::Task { path } => !path.to_lowercase().starts_with("\\microsoft\\"),
            Switch::Service { .. } => {
                let auto = r.service.as_ref().is_some_and(|s| matches!(s.start, sources::StartType::Auto | sources::StartType::Delayed));
                let in_windows = r.program.as_ref().is_some_and(|p| p.starts_with(windows));
                auto && !in_windows
            }
            Switch::Approved { .. } => true,
        })
        .map(|r| (entry_id(&r), r.name.clone()))
        .collect()
}

fn entry_id(raw: &Raw) -> String {
    match &raw.switch {
        Switch::Approved { machine, list, value } => {
            let kind = if raw.kind == Kind::Folder { "folder" } else { "run" };
            format!("{kind}:{}:{list}:{value}", if *machine { "machine" } else { "user" })
        }
        Switch::Task { path } => format!("task:{path}"),
        Switch::Service { name } => format!("service:{}", name.to_lowercase()),
    }
}

/// The state an entry is in, as stored in the change list.
fn state_code(raw: &Raw) -> String {
    match &raw.service {
        Some(service) => service.start.code().to_string(),
        None if raw.enabled => "on".into(),
        None => "off".into(),
    }
}

fn build(raw: &Raw, dirs: &Dirs, running: &[(String, u32, u64, u64, u64)], diagnostics: &Diagnostics, changed: Option<Changed>) -> Entry {
    let windows = lower(&dirs.windows);
    let in_windows = raw.program.as_ref().is_some_and(|p| lower(p).starts_with(&windows));
    // Store apps start through a zero-byte alias in WindowsApps; the real file is out of reach.
    let store_app = raw.program.as_ref().is_some_and(|p| lower(p).contains(r"\windowsapps\"));
    let facts = match &raw.program {
        Some(_) if store_app => fileinfo::FileFacts { exists: true, ..Default::default() },
        Some(program) => fileinfo::inspect(program, !in_windows),
        None => fileinfo::FileFacts::default(),
    };
    let publisher = facts
        .company
        .clone()
        .or_else(|| store_app.then(|| "Microsoft Store".to_string()))
        .or_else(|| raw.task_author.clone().filter(|a| !a.starts_with('$') && !a.starts_with('@')));
    let task_by_windows = matches!(&raw.switch, Switch::Task { path } if path.to_lowercase().starts_with(r"\microsoft\"));
    // Publishers are sometimes written in the system language, e.g. "Корпорація Майкрософт".
    let microsoft = task_by_windows
        || publisher.as_deref().is_some_and(|p| {
            let p = p.to_lowercase();
            p.contains("microsoft") || p.contains("майкрософт")
        });
    // A run value with nothing in it starts nothing.
    let exists = if raw.command.trim().is_empty() { false } else { raw.program.is_none() || facts.exists };
    // What makes an entry part of Windows depends on its kind: a task by who registered it
    // (plenty of third-party tasks run rundll32 or powershell from System32), a service by
    // whose program it runs.
    let task_author_ms = raw.task_author.as_deref().is_some_and(|a| a.starts_with("$(@") || a.to_lowercase().contains("microsoft"));
    let system = match raw.kind {
        Kind::Task => task_by_windows || task_author_ms,
        Kind::Service => microsoft || (in_windows && publisher.is_none()),
        Kind::Run | Kind::Folder => in_windows,
    };
    let (category, advice, reasons) = advice::advise(&advice::Facts {
        name: &raw.name,
        command: &raw.command,
        publisher: publisher.as_deref(),
        description: facts.description.as_deref().or(raw.description.as_deref()),
        exists,
        signed: facts.signed,
        microsoft,
        in_windows: in_windows || task_by_windows,
    });
    let footprint = footprint(raw, running, dirs);
    let delay_key = match &raw.service {
        Some(service) => Some(service.name.to_lowercase()),
        None => raw.program.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_lowercase()),
    };
    let boot_delay_ms = delay_key.and_then(|key| diagnostics.delays.get(&key).copied());
    Entry {
        id: entry_id(raw),
        kind: raw.kind,
        name: display_name(&raw.name),
        command: raw.command.clone(),
        program: raw.program.as_ref().map(|p| p.display().to_string()),
        location: raw.location.clone(),
        machine: raw.machine,
        enabled: raw.enabled,
        start: raw.service.as_ref().map(|s| s.start),
        running: footprint.processes > 0 || raw.service.as_ref().is_some_and(|s| s.running),
        publisher,
        description: facts.description.clone().or_else(|| raw.description.clone()),
        signed: facts.signed,
        exists,
        category,
        advice,
        reasons,
        needs_admin: raw.machine,
        windows: system,
        // Run entries are the user's business even when Microsoft made them (OneDrive, Teams…);
        // Windows' services and tasks are not changed from here.
        editable: !(system && raw.kind != Kind::Run && raw.kind != Kind::Folder),
        removable: advice == Advice::Broken && raw.run_value.is_some(),
        impact: impact(&footprint, boot_delay_ms),
        footprint,
        boot_delay_ms,
        changed,
    }
}

/// Browsers register values like `GoogleChromeAutoLaunch_D456F15C8F04F42E7999B076C65AD430`;
/// the hex tail means nothing to a person.
fn display_name(name: &str) -> String {
    match name.rsplit_once('_') {
        Some((head, tail)) if tail.len() >= 16 && tail.chars().all(|c| c.is_ascii_hexdigit()) => head.to_string(),
        _ => name.to_string(),
    }
}

fn changes(journal: &Journal) -> HashMap<String, Changed> {
    journal
        .with(|conn| {
            let mut query = conn.prepare("SELECT id, original, at FROM startup_changes")?;
            let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?, Changed { original: row.get(1)?, at: row.get(2)? })))?;
            rows.collect()
        })
        .unwrap_or_default()
}

#[derive(Default)]
pub struct StartupState {
    /// The last listing, by entry id, so changes act on exactly what the user saw.
    raws: Mutex<HashMap<String, Raw>>,
    entries: Mutex<HashMap<String, Entry>>,
}

#[tauri::command]
pub async fn startup_list(state: State<'_, StartupState>, journal: State<'_, Journal>) -> Result<Report, String> {
    let dirs = Dirs::real().ok_or("environment")?;
    let elevated = system::is_elevated();
    let started = std::time::Instant::now();
    let windows = dirs.windows.clone();
    let (raws, running, diagnostics) = tauri::async_runtime::spawn_blocking(move || {
        let diagnostics = if elevated { read_diagnostics(&windows) } else { Diagnostics::default() };
        (sources::collect(&windows), processes(), diagnostics)
    })
    .await
    .map_err(|e| e.to_string())?;

    let changed = changes(&journal);
    // Checking each program's signature is the slow part; it runs on every core.
    let mut entries: Vec<Entry> = {
        use rayon::prelude::*;
        raws.par_iter().map(|raw| build(raw, &dirs, &running, &diagnostics, changed.get(&entry_id(raw)).cloned())).collect()
    };
    entries.sort_by(|a, b| b.impact.cmp(&a.impact).then(b.footprint.memory.cmp(&a.footprint.memory)).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));

    *state.raws.lock().unwrap() = raws.into_iter().map(|raw| (entry_id(&raw), raw)).collect();
    *state.entries.lock().unwrap() = entries.iter().map(|e| (e.id.clone(), e.clone())).collect();
    Ok(Report { elevated, entries, boots: diagnostics.boots, removed: removed(&journal), duration_ms: started.elapsed().as_millis() as u64 })
}

/// Puts the entry into `target`: "on"/"off" for programs and tasks, a start type for services.
fn apply(raw: &Raw, target: &str, windows: &Path) -> Result<(), &'static str> {
    match &raw.switch {
        Switch::Approved { machine, list, value } => {
            let on = match target {
                "on" => true,
                "off" => false,
                _ => return Err("bad-state"),
            };
            sources::set_approved(*machine, list, value, on).map_err(|_| "denied")
        }
        Switch::Task { path } => {
            let on = match target {
                "on" => true,
                "off" => false,
                _ => return Err("bad-state"),
            };
            sources::set_task(windows, path, on).then_some(()).ok_or("denied")
        }
        Switch::Service { name } => {
            let start = StartType::parse(target).ok_or("bad-state")?;
            sources::set_service(windows, name, start).then_some(()).ok_or("denied")
        }
    }
}

fn with_state(raw: &mut Raw, target: &str) {
    match &mut raw.service {
        Some(service) => {
            if let Some(start) = StartType::parse(target) {
                service.start = start;
                raw.enabled = matches!(start, StartType::Auto | StartType::Delayed);
            }
        }
        None => raw.enabled = target == "on",
    }
}

/// Remembers the state before the first change, and forgets it once the entry is back there.
fn remember(journal: &Journal, id: &str, name: &str, before: &str, after: &str, data: &serde_json::Value) {
    let _ = journal.with(|conn| {
        let original: Option<String> = conn.query_row("SELECT original FROM startup_changes WHERE id = ?1", params![id], |r| r.get(0)).optional()?;
        match original {
            Some(original) if original == after => conn.execute("DELETE FROM startup_changes WHERE id = ?1", params![id]).map(|_| ()),
            Some(_) => Ok(()),
            None => conn
                .execute(
                    "INSERT INTO startup_changes (id, original, data, name, at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![id, before, data.to_string(), name, crate::leftovers::quarantine::now()],
                )
                .map(|_| ()),
        }
    });
    let details = serde_json::json!({ "name": name, "from": before, "to": after });
    let _ = journal.add("startup", 0, 1, 0, &details);
}

fn change(state: &StartupState, journal: &Journal, id: &str, target: &str) -> Result<Entry, String> {
    let dirs = Dirs::real().ok_or("environment")?;
    let mut raws = state.raws.lock().unwrap();
    let raw = raws.get_mut(id).ok_or("stale")?;
    let mut entries = state.entries.lock().unwrap();
    let entry = entries.get_mut(id).ok_or("stale")?;
    if !entry.editable {
        return Err("read-only".into());
    }
    if entry.needs_admin && !system::is_elevated() {
        return Err("needs-admin".into());
    }
    let before = state_code(raw);
    if before == target {
        return Ok(entry.clone());
    }
    apply(raw, target, &dirs.windows)?;
    with_state(raw, target);
    remember(journal, id, &raw.name, &before, target, &serde_json::Value::Null);

    entry.enabled = raw.enabled;
    entry.start = raw.service.as_ref().map(|s| s.start);
    entry.changed = changes(journal).remove(id);
    Ok(entry.clone())
}

#[tauri::command]
pub fn startup_set(state: State<'_, StartupState>, journal: State<'_, Journal>, id: String, target: String) -> Result<Entry, String> {
    change(&state, &journal, &id, &target)
}

/// Removes a `Run` value whose program no longer exists. It can be put back with `startup_revert`.
#[tauri::command]
pub fn startup_remove(state: State<'_, StartupState>, journal: State<'_, Journal>, id: String) -> Result<(), String> {
    let mut raws = state.raws.lock().unwrap();
    let raw = raws.get(&id).ok_or("stale")?;
    let removable = state.entries.lock().unwrap().get(&id).is_some_and(|e| e.removable);
    let Some((machine, wow32, value, command)) = raw.run_value.clone().filter(|_| removable) else {
        return Err("not-removable".into());
    };
    if machine && !system::is_elevated() {
        return Err("needs-admin".into());
    }
    if !sources::remove_run_value(machine, wow32, &value) {
        return Err("denied".into());
    }
    let data = serde_json::json!({ "machine": machine, "wow32": wow32, "value": value, "command": command });
    let name = raw.name.clone();
    remember(&journal, &id, &name, "present", "removed", &data);
    raws.remove(&id);
    state.entries.lock().unwrap().remove(&id);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertReport {
    reverted: usize,
    failed: Vec<String>,
}

/// Undoes DelphEye's changes: to the given entries, or to all of them when `ids` is empty.
#[tauri::command]
pub fn startup_revert(state: State<'_, StartupState>, journal: State<'_, Journal>, ids: Vec<String>) -> Result<RevertReport, String> {
    let rows: Vec<(String, String, String, String)> = journal
        .with(|conn| {
            let mut query = conn.prepare("SELECT id, original, data, name FROM startup_changes")?;
            let rows = query.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            rows.collect()
        })
        .map_err(|e| e.to_string())?;
    let mut report = RevertReport { reverted: 0, failed: Vec::new() };
    for (id, original, data, name) in rows.into_iter().filter(|row| ids.is_empty() || ids.contains(&row.0)) {
        let result = if original == "present" {
            // A removed value: write it back exactly as it was.
            let data: serde_json::Value = serde_json::from_str(&data).unwrap_or_default();
            let machine = data["machine"].as_bool().unwrap_or(false);
            if machine && !system::is_elevated() {
                Err("needs-admin".to_string())
            } else if sources::restore_run_value(machine, data["wow32"].as_bool().unwrap_or(false), data["value"].as_str().unwrap_or_default(), data["command"].as_str().unwrap_or_default()) {
                let _ = journal.with(|conn| conn.execute("DELETE FROM startup_changes WHERE id = ?1", params![id]));
                let _ = journal.add("startup", 0, 1, 0, &serde_json::json!({ "name": name, "from": "removed", "to": "present" }));
                Ok(())
            } else {
                Err("denied".to_string())
            }
        } else {
            change(&state, &journal, &id, &original).map(|_| ())
        };
        match result {
            Ok(()) => report.reverted += 1,
            Err(_) => report.failed.push(name),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;

    #[test]
    fn boot_diagnostics_give_boot_times_and_the_worst_slow_down_per_program() {
        let xml = r#"
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><EventID>100</EventID><TimeCreated SystemTime='2026-11-10T08:00:00.0Z'/></System>
  <EventData><Data Name='BootTime'>42000</Data><Data Name='MainPathBootTime'>18000</Data><Data Name='BootPostBootTime'>24000</Data></EventData></Event>
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><EventID>101</EventID><TimeCreated SystemTime='2026-11-10T08:01:00.0Z'/></System>
  <EventData><Data Name='Name'>Steam.exe</Data><Data Name='DegradationTime'>2300</Data></EventData></Event>
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><EventID>101</EventID><TimeCreated SystemTime='2026-11-01T08:01:00.0Z'/></System>
  <EventData><Data Name='Name'>steam.exe</Data><Data Name='DegradationTime'>4100</Data></EventData></Event>
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><EventID>103</EventID><TimeCreated SystemTime='2026-11-01T08:01:00.0Z'/></System>
  <EventData><Data Name='Name'>EABackgroundService</Data><Data Name='DegradationTime'>900</Data></EventData></Event>"#;
        let found = parse_diagnostics(xml);
        assert_eq!(found.boots, [Boot { at: "2026-11-10T08:00:00.0Z".into(), total_ms: 42_000, main_ms: 18_000, post_ms: 24_000 }]);
        assert_eq!(found.delays.get("steam.exe"), Some(&4_100));
        assert_eq!(found.delays.get("eabackgroundservice"), Some(&900));
        assert_eq!(parse_diagnostics(""), Diagnostics::default());
    }

    #[test]
    fn hex_suffixes_are_dropped_from_names() {
        assert_eq!(display_name("GoogleChromeAutoLaunch_D456F15C8F04F42E7999B076C65AD430"), "GoogleChromeAutoLaunch");
        assert_eq!(display_name("Steam"), "Steam");
        assert_eq!(display_name("My_Tool"), "My_Tool");
    }

    #[test]
    fn impact_grows_with_what_a_program_uses_and_how_it_slows_boots() {
        let fp = |processes, memory, cpu_seconds| Footprint { processes, memory, cpu_seconds, read_bytes: 0 };
        assert_eq!(impact(&fp(0, 0, 0), None), Impact::None);
        assert_eq!(impact(&fp(1, 40 * MB, 2), None), Impact::Low);
        assert_eq!(impact(&fp(3, 200 * MB, 5), None), Impact::Medium);
        assert_eq!(impact(&fp(9, 900 * MB, 50), None), Impact::High);
        assert_eq!(impact(&fp(0, 0, 0), Some(6_000)), Impact::High, "a big boot slow-down counts even when not running now");
    }

    fn raw(program: &str) -> Raw {
        Raw {
            kind: Kind::Run,
            name: "x".into(),
            command: program.into(),
            program: Some(PathBuf::from(program)),
            location: String::new(),
            machine: false,
            enabled: true,
            switch: Switch::Approved { machine: false, list: "Run", value: "x".into() },
            description: None,
            run_value: None,
            service: None,
            task_author: None,
        }
    }

    #[test]
    fn helpers_in_the_programs_own_folder_are_counted_but_shared_folders_are_not() {
        let dirs = Dirs::real().unwrap();
        let running = vec![
            (r"c:\games\steam\steam.exe".to_string(), 1, 100 * MB, 5_000, 0),
            (r"c:\games\steam\bin\cef\steamwebhelper.exe".to_string(), 2, 300 * MB, 20_000, 0),
            (r"c:\games\steamextra\other.exe".to_string(), 3, 999 * MB, 0, 0),
            (format!(r"{}\system32\rundll32.exe", lower(&dirs.windows)), 4, 10 * MB, 0, 0),
            (format!(r"{}\system32\svchost.exe", lower(&dirs.windows)), 5, 50 * MB, 0, 0),
        ];
        let steam = footprint(&raw(r"C:\Games\Steam\steam.exe"), &running, &dirs);
        assert_eq!((steam.processes, steam.memory, steam.cpu_seconds), (2, 400 * MB, 25));

        let rundll = footprint(&raw(&format!(r"{}\System32\rundll32.exe", dirs.windows.display())), &running, &dirs);
        assert_eq!(rundll.processes, 1, "only the exact program in a shared folder");
    }
}

//! Every running process — as a tree, with what each one is and what ending it would do.
//!
//! The live numbers come from the metrics sampler, which already walks all processes once a
//! second; this module adds what Task Manager does not tell: who started whom, what a process
//! is for, which services and connections it holds, and how risky it is to end.

mod known;
mod native;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::System;
use tauri::State;

use crate::journal::Journal;
use crate::startup::{advice, fileinfo};
use crate::system::Dirs;
pub use known::Level;
pub use native::Connection;

/// One process as last sampled.
#[derive(Clone, Debug, Default)]
pub struct Sample {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub exe: Option<PathBuf>,
    pub cmd: String,
    /// Unix seconds.
    pub start: u64,
    /// Share of the whole CPU, in percent.
    pub cpu: f32,
    pub memory: u64,
    /// Bytes read and written per second.
    pub disk: u64,
    pub session: Option<u32>,
}

static TABLE: Mutex<Vec<Sample>> = Mutex::new(Vec::new());

/// Called by the metrics sampler after each refresh.
pub fn publish(sys: &System, cores: f32, elapsed: f64) {
    let table = sys
        .processes()
        .values()
        .filter(|p| p.pid().as_u32() != 0)
        .map(|p| {
            let disk = p.disk_usage();
            Sample {
                pid: p.pid().as_u32(),
                parent: p.parent().map(|x| x.as_u32()),
                name: p.name().to_string_lossy().into_owned(),
                exe: p.exe().map(Path::to_path_buf),
                cmd: p.cmd().iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" "),
                start: p.start_time(),
                cpu: p.cpu_usage() / cores.max(1.0),
                memory: p.memory(),
                disk: ((disk.read_bytes + disk.written_bytes) as f64 / elapsed.max(0.001)) as u64,
                session: p.session_id().map(|s| s.as_u32()),
            }
        })
        .collect();
    *TABLE.lock().unwrap() = table;
}

fn table() -> Vec<Sample> {
    TABLE.lock().unwrap().clone()
}

/// A look at the latest samples without copying them.
pub fn peek<T>(f: impl FnOnce(&[Sample]) -> T) -> T {
    f(&TABLE.lock().unwrap())
}

/// The latest process samples, for other modules.
pub fn samples() -> Vec<Sample> {
    table()
}

/// The explanation id DelphEye has for a process name, if any.
pub fn known_id(name: &str) -> Option<&'static str> {
    known::lookup(name).map(|k| k.id)
}

/// The parent only counts if it started before the child: Windows reuses process ids, so a
/// "parent" that started later is an unrelated process that inherited the number.
fn real_parents(samples: &[Sample]) -> HashMap<u32, u32> {
    let starts: HashMap<u32, u64> = samples.iter().map(|s| (s.pid, s.start)).collect();
    samples
        .iter()
        .filter_map(|s| {
            let parent = s.parent.filter(|p| *p != s.pid)?;
            starts.get(&parent).is_some_and(|ps| *ps <= s.start).then_some((s.pid, parent))
        })
        .collect()
}

/// `root` and everything it started, children before parents.
fn descendants(samples: &[Sample], root: u32) -> Vec<u32> {
    let parents = real_parents(samples);
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (child, parent) in &parents {
        children.entry(*parent).or_default().push(*child);
    }
    fn walk(pid: u32, children: &HashMap<u32, Vec<u32>>, out: &mut Vec<u32>, seen: &mut HashSet<u32>) {
        if !seen.insert(pid) {
            return;
        }
        for child in children.get(&pid).into_iter().flatten() {
            walk(*child, children, out, seen);
        }
        out.push(pid);
    }
    let mut out = Vec::new();
    walk(root, &children, &mut out, &mut HashSet::new());
    out
}

static SERVICES: Mutex<Option<(Instant, HashMap<u32, Vec<String>>)>> = Mutex::new(None);

/// Display names of the running services, by the process that hosts them. Cached briefly.
fn services() -> HashMap<u32, Vec<String>> {
    let mut cache = SERVICES.lock().unwrap();
    if let Some((at, map)) = cache.as_ref().filter(|(at, _)| at.elapsed() < Duration::from_secs(5)) {
        let _ = at;
        return map.clone();
    }
    let mut map: HashMap<u32, Vec<String>> = HashMap::new();
    for (_, (running, pid, display)) in crate::startup::service_states() {
        if running && pid != 0 {
            map.entry(pid).or_default().push(display);
        }
    }
    for names in map.values_mut() {
        names.sort();
    }
    *cache = Some((Instant::now(), map.clone()));
    map
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub pid: u32,
    pub parent: Option<u32>,
    pub start: u64,
    pub name: String,
    pub exe: Option<String>,
    pub description: Option<String>,
    pub company: Option<String>,
    pub cpu: f32,
    pub memory: u64,
    pub disk: u64,
    /// The title of its main window, if it has one.
    pub window: Option<String>,
    /// "app" (has a window), "service" (runs services or in the system session) or "background".
    pub kind: &'static str,
    pub level: Level,
    /// Id of the explanation the UI has for it.
    pub known: Option<&'static str>,
    pub category: advice::Category,
    /// Carries a Windows process name but does not live where that process lives.
    pub impostor: bool,
    pub services: Vec<String>,
    pub connections: u32,
    pub listening: u32,
}

/// What everything around a process is, gathered once per listing.
struct Context<'a> {
    windows: &'a Path,
    own: &'a HashSet<u32>,
    titles: &'a HashMap<u32, String>,
    services: &'a HashMap<u32, Vec<String>>,
    connections: &'a HashMap<u32, Vec<Connection>>,
}

fn under(path: &Path, folder: &Path) -> bool {
    path.to_string_lossy().to_lowercase().starts_with(&format!("{}\\", folder.to_string_lossy().to_lowercase().trim_end_matches('\\')))
}

fn describe(s: &Sample, parent: Option<u32>, facts: &fileinfo::FileFacts, ctx: &Context) -> Row {
    let in_windows = s.exe.as_deref().is_some_and(|e| under(e, ctx.windows));
    let found = known::lookup(&s.name);
    let impostor = found.as_ref().is_some_and(|k| k.in_windows) && s.exe.is_some() && !in_windows;
    let found = if impostor { None } else { found };
    let microsoft = facts.company.as_deref().is_some_and(|c| c.to_lowercase().contains("microsoft"));
    let level = if ctx.own.contains(&s.pid) {
        Level::Own
    } else if let Some(k) = &found {
        if k.level == Level::Own { Level::App } else { k.level }
    } else if in_windows && (microsoft || facts.company.is_none()) {
        Level::Windows
    } else {
        Level::App
    };
    let exe = s.exe.as_ref().map(|e| e.to_string_lossy().into_owned());
    let category = advice::advise(&advice::Facts {
        name: &s.name,
        command: exe.as_deref().unwrap_or(&s.name),
        publisher: facts.company.as_deref(),
        description: facts.description.as_deref(),
        exists: true,
        signed: None,
        microsoft,
        in_windows,
    })
    .0;
    let services = ctx.services.get(&s.pid).cloned().unwrap_or_default();
    let window = ctx.titles.get(&s.pid).cloned();
    let kind = if window.is_some() {
        "app"
    } else if !services.is_empty() || s.session == Some(0) {
        "service"
    } else {
        "background"
    };
    let conns = ctx.connections.get(&s.pid);
    Row {
        pid: s.pid,
        parent,
        start: s.start,
        name: s.name.clone(),
        exe,
        description: facts.description.clone(),
        company: facts.company.clone(),
        cpu: (s.cpu * 10.0).round() / 10.0,
        memory: s.memory,
        disk: s.disk,
        window,
        kind,
        level,
        known: found.map(|k| k.id),
        category,
        impostor,
        services,
        connections: conns.map_or(0, |c| c.iter().filter(|c| c.state == "established").count() as u32),
        listening: conns.map_or(0, |c| c.iter().filter(|c| c.state == "listen").count() as u32),
    }
}

/// DelphEye and everything it started (its window's WebView2, the sensor helper).
fn own_tree(samples: &[Sample]) -> HashSet<u32> {
    descendants(samples, std::process::id()).into_iter().collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    rows: Vec<Row>,
    own_pid: u32,
    elevated: bool,
}

fn listing() -> Listing {
    let samples = table();
    let parents = real_parents(&samples);
    let windows = Dirs::real().map(|d| d.windows).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let own = own_tree(&samples);
    let titles = native::window_titles();
    let services = services();
    let connections = native::connections();
    let ctx = Context { windows: &windows, own: &own, titles: &titles, services: &services, connections: &connections };
    let rows = samples
        .iter()
        .map(|s| {
            let facts = s.exe.as_deref().map(|e| fileinfo::inspect(e, false)).unwrap_or_default();
            describe(s, parents.get(&s.pid).copied(), &facts, &ctx)
        })
        .collect();
    Listing { rows, own_pid: std::process::id(), elevated: crate::system::is_elevated() }
}

/// Every process as the Processes page describes it.
pub fn rows() -> Vec<Row> {
    listing().rows
}

/// Whether a program file carries a valid signature; `None` for files in the Windows folder
/// (signed through catalogs) and missing ones. Remembered per file.
pub fn signed(exe: &Path) -> Option<bool> {
    let windows = Dirs::real().map(|d| d.windows).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    if under(exe, &windows) || !exe.is_file() {
        return None;
    }
    if let Some(known) = SIGNED.lock().unwrap().get_or_insert_with(HashMap::new).get(exe) {
        return Some(*known);
    }
    let signed = fileinfo::is_signed(exe);
    SIGNED.lock().unwrap().get_or_insert_with(HashMap::new).insert(exe.to_path_buf(), signed);
    Some(signed)
}

#[tauri::command]
pub async fn processes_list() -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(listing).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    cmd: String,
    /// `None` for files in the Windows folder (signed through catalogs) or unreadable ones.
    signed: Option<bool>,
    connections: Vec<Connection>,
}

static SIGNED: Mutex<Option<HashMap<PathBuf, bool>>> = Mutex::new(None);

#[tauri::command]
pub async fn process_details(pid: u32, start: u64) -> Result<Details, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sample = table().into_iter().find(|s| s.pid == pid && s.start == start).ok_or("gone")?;
        let signed = sample.exe.as_deref().and_then(signed);
        let mut connections = native::connections().remove(&pid).unwrap_or_default();
        connections.sort_by_key(|c| (c.state != "established", c.state != "listen", c.remote.clone()));
        Ok(Details { cmd: sample.cmd, signed, connections })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e: &str| e.to_string())
}

static ICONS: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// Icons of the given program files, as PNG data URLs (`None` where a file has none).
#[tauri::command]
pub async fn process_icons(paths: Vec<String>) -> Result<HashMap<String, Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = HashMap::new();
        for path in paths.into_iter().take(300) {
            let cached = ICONS.lock().unwrap().get_or_insert_with(HashMap::new).get(&path).cloned();
            let icon = cached.unwrap_or_else(|| {
                let icon = native::icon(Path::new(&path));
                ICONS.lock().unwrap().get_or_insert_with(HashMap::new).insert(path.clone(), icon.clone());
                icon
            });
            out.insert(path, icon);
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    name: String,
    reason: &'static str,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Ended {
    ended: u32,
    failed: Vec<Failure>,
}

/// What may be ended, judged the same way the listing judges it.
fn refusal(sample: &Sample, own: &HashSet<u32>, windows: &Path) -> Option<&'static str> {
    if own.contains(&sample.pid) {
        return Some("own");
    }
    let in_windows = sample.exe.as_deref().is_none_or(|e| under(e, windows));
    match known::lookup(&sample.name) {
        Some(k) if k.level == Level::Critical && (in_windows || !k.in_windows) => Some("critical"),
        _ => None,
    }
}

/// Ends a process, and with `tree` everything it started. The process must still be the one
/// the user saw: same id *and* same start time. Errors: "gone", "critical", "own".
#[tauri::command]
pub async fn process_end(journal: State<'_, Journal>, pid: u32, start: u64, tree: bool) -> Result<Ended, String> {
    let (result, mut names) = tauri::async_runtime::spawn_blocking(move || {
        let samples = table();
        let root = samples.iter().find(|s| s.pid == pid && s.start == start).ok_or("gone")?.clone();
        let windows = Dirs::real().map(|d| d.windows).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let own = own_tree(&samples);
        if let Some(reason) = refusal(&root, &own, &windows) {
            return Err(reason);
        }
        let targets = if tree { descendants(&samples, pid) } else { vec![pid] };
        let by_pid: HashMap<u32, &Sample> = samples.iter().map(|s| (s.pid, s)).collect();
        let (mut ended, mut failed, mut names) = (0u32, Vec::new(), Vec::new());
        for target in targets {
            let Some(sample) = by_pid.get(&target) else { continue };
            if let Some(reason) = refusal(sample, &own, &windows) {
                failed.push(Failure { name: sample.name.clone(), reason });
                continue;
            }
            match native::terminate(target) {
                Ok(()) => {
                    ended += 1;
                    names.push(sample.name.clone());
                }
                Err("gone") => {}
                Err(reason) => failed.push(Failure { name: sample.name.clone(), reason }),
            }
        }
        Ok((Ended { ended, failed }, names))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e: &str| e.to_string())?;
    if result.ended > 0 {
        names.sort();
        names.dedup();
        let _ = journal.add("process", 0, result.ended as u64, result.failed.len() as u64, &serde_json::json!({ "pid": pid, "tree": tree, "ended": result.ended, "names": names }));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(pid: u32, parent: Option<u32>, name: &str, exe: Option<&str>, start: u64) -> Sample {
        Sample { pid, parent, name: name.into(), exe: exe.map(PathBuf::from), start, ..Default::default() }
    }

    #[test]
    fn a_parent_that_started_later_is_not_the_parent() {
        let samples = vec![
            sample(10, None, "explorer.exe", None, 100),
            sample(20, Some(10), "chrome.exe", None, 200),
            // pid 30's real parent died; pid 10 was not reused here, but 40 was:
            sample(40, None, "late.exe", None, 500),
            sample(30, Some(40), "orphan.exe", None, 300),
        ];
        let parents = real_parents(&samples);
        assert_eq!(parents.get(&20), Some(&10));
        assert_eq!(parents.get(&30), None);
    }

    #[test]
    fn descendants_come_children_first() {
        let samples = vec![
            sample(1, None, "a", None, 1),
            sample(2, Some(1), "b", None, 2),
            sample(3, Some(2), "c", None, 3),
            sample(4, Some(1), "d", None, 4),
            sample(5, None, "other", None, 5),
        ];
        let order = descendants(&samples, 1);
        assert_eq!(order.len(), 4);
        assert_eq!(*order.last().unwrap(), 1);
        let pos = |p: u32| order.iter().position(|x| *x == p).unwrap();
        assert!(pos(3) < pos(2));
    }

    fn ctx_parts() -> (PathBuf, HashSet<u32>, HashMap<u32, String>, HashMap<u32, Vec<String>>, HashMap<u32, Vec<Connection>>) {
        let mut titles = HashMap::new();
        titles.insert(20, "Inbox — Mail".to_string());
        let mut services = HashMap::new();
        services.insert(30, vec!["Windows Audio".to_string()]);
        let mut conns = HashMap::new();
        conns.insert(20, vec![
            Connection { local: "1".into(), remote: "2".into(), state: "established" },
            Connection { local: "1".into(), remote: "3".into(), state: "listen" },
        ]);
        (PathBuf::from(r"C:\Windows"), HashSet::from([99]), titles, services, conns)
    }

    #[test]
    fn rows_say_what_a_process_is() {
        let (windows, own, titles, services, conns) = ctx_parts();
        let ctx = Context { windows: &windows, own: &own, titles: &titles, services: &services, connections: &conns };
        let ms = fileinfo::FileFacts { exists: true, company: Some("Microsoft Corporation".into()), description: None, signed: None };

        let lsass = describe(&sample(5, None, "lsass.exe", Some(r"C:\Windows\System32\lsass.exe"), 1), None, &ms, &ctx);
        assert_eq!((lsass.level, lsass.known, lsass.impostor), (Level::Critical, Some("lsass"), false));

        let fake = describe(&sample(6, None, "lsass.exe", Some(r"C:\Users\x\AppData\lsass.exe"), 1), None, &ms, &ctx);
        assert_eq!((fake.level, fake.known, fake.impostor), (Level::App, None, true));

        let app = describe(&sample(20, None, "olk.exe", Some(r"C:\Program Files\WindowsApps\olk.exe"), 1), None, &ms, &ctx);
        assert_eq!((app.kind, app.window.as_deref(), app.connections, app.listening), ("app", Some("Inbox — Mail"), 1, 1));

        let svc = describe(&sample(30, None, "svchost.exe", Some(r"C:\Windows\System32\svchost.exe"), 1), None, &ms, &ctx);
        assert_eq!((svc.kind, svc.level, svc.services.len()), ("service", Level::Windows, 1));

        let me = describe(&sample(99, None, "msedgewebview2.exe", None, 1), None, &ms, &ctx);
        assert_eq!(me.level, Level::Own);
    }

    #[test]
    fn critical_and_own_processes_are_refused() {
        let windows = PathBuf::from(r"C:\Windows");
        let own = HashSet::from([7]);
        assert_eq!(refusal(&sample(5, None, "csrss.exe", Some(r"C:\Windows\System32\csrss.exe"), 1), &own, &windows), Some("critical"));
        assert_eq!(refusal(&sample(4, None, "System", None, 1), &own, &windows), Some("critical"));
        assert_eq!(refusal(&sample(7, None, "delpheye.exe", None, 1), &own, &windows), Some("own"));
        assert_eq!(refusal(&sample(8, None, "csrss.exe", Some(r"C:\Temp\csrss.exe"), 1), &own, &windows), None, "an impostor may be ended");
        assert_eq!(refusal(&sample(9, None, "chrome.exe", Some(r"C:\Program Files\Google\chrome.exe"), 1), &own, &windows), None);
    }
}

//! The background watcher: DelphEye keeps an eye on the computer and the home network while it
//! sits in the tray, and says so in a Windows notification when something needs the user —
//! a new device on the network, a copy of the Wi-Fi network, overheating, a nearly full disk,
//! a new program starting with Windows, an unexpected shutdown. Once a week, a short summary.
//!
//! Every kind can be switched off. Each alert is also kept in the journal database, so the
//! Watcher page lists what happened while the window was closed.

mod text;

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::journal::Journal;

#[cfg(test)]
pub const KINDS: [&str; 6] = ["device", "twin", "heat", "disk", "autostart", "crash"];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    /// Kinds switched off by the user.
    pub off: Vec<String>,
    pub weekly: bool,
    /// Closing the window keeps DelphEye in the tray.
    pub tray_on_close: bool,
    pub lang: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self { enabled: true, off: Vec::new(), weekly: true, tray_on_close: true, lang: "uk".into() }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub id: i64,
    /// Unix seconds.
    pub at: i64,
    pub kind: String,
    /// "info", "warn", "risk".
    pub level: String,
    pub values: Value,
    pub read: bool,
}

#[derive(Default)]
pub struct WatcherState {
    pub settings: Mutex<Settings>,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ───────────────────────── storage ─────────────────────────

pub const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS watcher_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS watcher_alerts (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        at     INTEGER NOT NULL,
        kind   TEXT    NOT NULL,
        level  TEXT    NOT NULL,
        values_json TEXT NOT NULL,
        read   INTEGER NOT NULL DEFAULT 0
    );
";

fn kv_get(j: &Journal, key: &str) -> Option<String> {
    j.with(|db| {
        db.execute_batch(SCHEMA)?;
        db.query_row("SELECT value FROM watcher_kv WHERE key = ?1", params![key], |r| r.get(0)).optional()
    })
    .ok()
    .flatten()
}

fn kv_set(j: &Journal, key: &str, value: &str) {
    let _ = j.with(|db| {
        db.execute_batch(SCHEMA)?;
        db.execute("INSERT INTO watcher_kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value])
    });
}

fn set_of(j: &Journal, key: &str) -> Option<HashSet<String>> {
    kv_get(j, key).and_then(|v| serde_json::from_str(&v).ok())
}

fn save_set(j: &Journal, key: &str, set: &HashSet<String>) {
    kv_set(j, key, &serde_json::to_string(set).unwrap_or_default());
}

pub fn load_settings(j: &Journal) -> Settings {
    kv_get(j, "settings").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

// ───────────────────────── raising an alert ─────────────────────────

fn raise(app: &AppHandle, kind: &str, level: &str, values: Value) {
    let journal = app.state::<Journal>();
    let settings = app.state::<WatcherState>().settings.lock().unwrap().clone();
    if !settings.enabled || settings.off.iter().any(|k| k == kind) {
        return;
    }
    let id = journal
        .with(|db| {
            db.execute_batch(SCHEMA)?;
            db.execute("INSERT INTO watcher_alerts (at, kind, level, values_json) VALUES (?1, ?2, ?3, ?4)", params![now(), kind, level, values.to_string()])?;
            db.execute("DELETE FROM watcher_alerts WHERE at < ?1", params![now() - 180 * 86_400])?;
            Ok(db.last_insert_rowid())
        })
        .unwrap_or(-1);
    let (title, body) = text::render(&settings.lang, kind, &values);
    let _ = app.notification().builder().title(&title).body(&body).show();
    crate::errlog::write("watcher", &format!("alert {kind}"));
    let _ = app.emit("watcher:alert", id);
}

/// Each kind at most once in `gap`, so a hot laptop does not notify every minute.
fn cooled(app: &AppHandle, key: &str, gap: Duration) -> bool {
    let j = app.state::<Journal>();
    let last: i64 = kv_get(&j, &format!("last:{key}")).and_then(|v| v.parse().ok()).unwrap_or(0);
    if now() - last < gap.as_secs() as i64 {
        return false;
    }
    kv_set(&j, &format!("last:{key}"), &now().to_string());
    true
}

// ───────────────────────── the checks ─────────────────────────

struct Loop {
    hot_minutes: u32,
    router: Option<(String, String)>,
    router_off: bool,
    next: [Instant; 6],
}

fn heat(app: &AppHandle, l: &mut Loop) {
    let frame = app.state::<crate::monitor::MonitorState>().sensors.latest();
    let Some(frame) = frame else { return };
    let temp = frame.cpu_temp();
    let thermal = frame.throttle.as_ref().is_some_and(|t| matches!(t.state, crate::monitor::throttle::State::Thermal));
    if temp.is_some_and(|t| t >= 92.0) || thermal {
        l.hot_minutes += 1;
    } else {
        l.hot_minutes = 0;
    }
    if l.hot_minutes >= 3 && cooled(app, "heat", Duration::from_secs(6 * 3600)) {
        raise(app, "heat", "warn", json!({ "temp": temp.map(|t| t.round() as i64), "thermal": thermal }));
    }
}

fn disk(app: &AppHandle) {
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    let Some((free, total)) = crate::monitor::slowdown::drive_free(&drive) else { return };
    let pct = free as f64 * 100.0 / total.max(1) as f64;
    if (pct < 5.0 || free < 8 * 1024 * 1024 * 1024) && cooled(app, "disk", Duration::from_secs(24 * 3600)) {
        raise(app, "disk", if pct < 2.0 { "risk" } else { "warn" }, json!({ "drive": drive, "free_gb": (free as f64 / 1e9 * 10.0).round() / 10.0, "pct": pct.round() as i64 }));
    }
}

fn autostart(app: &AppHandle) {
    let Some(dirs) = crate::system::Dirs::real() else { return };
    let list = crate::startup::watch_list(&dirs.windows);
    let j = app.state::<Journal>();
    let ids: HashSet<String> = list.iter().map(|(id, _)| id.clone()).collect();
    match set_of(&j, "autostart") {
        // The first look only remembers what is there.
        None => save_set(&j, "autostart", &ids),
        Some(before) => {
            for (id, name) in list.iter().filter(|(id, _)| !before.contains(id)) {
                raise(app, "autostart", "warn", json!({ "name": name, "id": id }));
            }
            save_set(&j, "autostart", &ids);
        }
    }
}

fn crashes(app: &AppHandle) {
    let Some(dirs) = crate::system::Dirs::real() else { return };
    let Some(log) = crate::monitor::health::read_crash_log(&dirs.windows) else { return };
    let j = app.state::<Journal>();
    let newest = log.incidents.first().map(|i| i.at.clone());
    match kv_get(&j, "crash:last") {
        None => {}
        Some(last) => {
            for i in log.incidents.iter().take_while(|i| i.at > last) {
                raise(app, "crash", "risk", json!({ "kind": i.kind, "cause": i.cause, "code": i.code, "at": i.at }));
            }
        }
    }
    if let Some(n) = newest {
        kv_set(&j, "crash:last", &n);
    } else if kv_get(&j, "crash:last").is_none() {
        kv_set(&j, "crash:last", "");
    }
}

fn twins(app: &AppHandle) {
    let snap = crate::wifi::snapshot(false);
    let Some(a) = snap.analysis else { return };
    let j = app.state::<Journal>();
    let mut seen = set_of(&j, "twins").unwrap_or_default();
    for adv in a.advice.iter().filter(|x| x.id == "evil-twin" || x.id == "same-name") {
        let bssid = adv.values["bssid"].as_str().unwrap_or_default().to_string();
        if seen.insert(bssid) {
            raise(app, "twin", if adv.id == "evil-twin" { "risk" } else { "warn" }, adv.values.clone());
        }
    }
    save_set(&j, "twins", &seen);
}

fn devices(app: &AppHandle, l: &mut Loop) {
    if l.router_off || !crate::router::has_saved_login() {
        return;
    }
    let clients = match crate::router::watch_clients(&mut l.router) {
        Ok(c) => c,
        Err(e) if e == "wrong" || e == "captcha" || e == "locked" => {
            // Never try a failing password again by itself: the router locks after a few.
            l.router_off = true;
            raise(app, "device", "warn", json!({ "loginFailed": e }));
            return;
        }
        Err(_) => return,
    };
    let j = app.state::<Journal>();
    let macs: HashSet<String> = clients.iter().map(|c| c.mac.clone()).collect();
    match set_of(&j, "devices") {
        None => save_set(&j, "devices", &macs),
        Some(mut before) => {
            for c in clients.iter().filter(|c| !before.contains(&c.mac)) {
                raise(app, "device", "warn", json!({ "name": c.name, "vendor": c.vendor, "mac": c.mac, "ip": c.ip, "link": c.link }));
            }
            before.extend(macs);
            save_set(&j, "devices", &before);
        }
    }
}

fn weekly(app: &AppHandle) {
    let j = app.state::<Journal>();
    let settings = app.state::<WatcherState>().settings.lock().unwrap().clone();
    let last: i64 = kv_get(&j, "weekly").and_then(|v| v.parse().ok()).unwrap_or(0);
    if last == 0 {
        kv_set(&j, "weekly", &now().to_string());
        return;
    }
    if !settings.weekly || now() - last < 7 * 86_400 {
        return;
    }
    kv_set(&j, "weekly", &now().to_string());
    let counts: Vec<(String, i64)> = j
        .with(|db| {
            let mut s = db.prepare("SELECT kind, COUNT(*) FROM watcher_alerts WHERE at >= ?1 GROUP BY kind")?;
            let v = s.query_map(params![last], |r| Ok((r.get(0)?, r.get(1)?)))?.filter_map(|x| x.ok()).collect();
            Ok(v)
        })
        .unwrap_or_default();
    let (title, body) = text::weekly(&settings.lang, &counts);
    let _ = app.notification().builder().title(&title).body(&body).show();
}

/// The tray icon: click to show the window; a menu to open it or quit for real.
pub fn tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let uk = app.state::<WatcherState>().settings.lock().unwrap().lang != "en";
    let open = MenuItem::with_id(app, "open", if uk { "Відкрити DelphEye" } else { "Open DelphEye" }, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", if uk { "Вийти" } else { "Quit" }, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(if uk { "DelphEye — наглядач працює" } else { "DelphEye — watcher on" })
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Starts the watcher thread for the life of the app.
pub fn start(app: AppHandle) {
    {
        let s = load_settings(&app.state::<Journal>());
        *app.state::<WatcherState>().settings.lock().unwrap() = s;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(45));
        let t = Instant::now();
        let mut l = Loop { hot_minutes: 0, router: None, router_off: false, next: [t; 6] };
        // How often each check runs: device, twin, heat, disk, autostart, crash.
        let every = [300, 900, 60, 600, 600, 1800].map(Duration::from_secs);
        loop {
            let enabled = app.state::<WatcherState>().settings.lock().unwrap().enabled;
            if enabled {
                for (k, gap) in every.iter().enumerate() {
                    if Instant::now() < l.next[k] {
                        continue;
                    }
                    l.next[k] = Instant::now() + *gap;
                    match k {
                        0 => devices(&app, &mut l),
                        1 => twins(&app),
                        2 => heat(&app, &mut l),
                        3 => disk(&app),
                        4 => autostart(&app),
                        _ => crashes(&app),
                    }
                }
                weekly(&app);
            }
            std::thread::sleep(Duration::from_secs(20));
        }
    });
}

// ───────────────────────── commands ─────────────────────────

#[tauri::command]
pub fn watcher_settings(state: State<'_, WatcherState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn watcher_save(state: State<'_, WatcherState>, journal: State<'_, Journal>, settings: Settings) {
    kv_set(&journal, "settings", &serde_json::to_string(&settings).unwrap_or_default());
    *state.settings.lock().unwrap() = settings;
}

#[tauri::command]
pub async fn watcher_alerts(app: AppHandle, limit: u32) -> Result<Vec<Alert>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Journal>()
            .with(|db| {
                db.execute_batch(SCHEMA)?;
                let mut s = db.prepare("SELECT id, at, kind, level, values_json, read FROM watcher_alerts ORDER BY id DESC LIMIT ?1")?;
                let v = s
                    .query_map(params![limit], |r| {
                        Ok(Alert {
                            id: r.get(0)?,
                            at: r.get(1)?,
                            kind: r.get(2)?,
                            level: r.get(3)?,
                            values: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(Value::Null),
                            read: r.get::<_, i64>(5)? != 0,
                        })
                    })?
                    .filter_map(|x| x.ok())
                    .collect();
                Ok(v)
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn watcher_read_all(journal: State<'_, Journal>) {
    let _ = journal.with(|db| db.execute("UPDATE watcher_alerts SET read = 1 WHERE read = 0", []));
}

/// A sample notification, so the user sees what one looks like (and whether Windows lets it through).
#[tauri::command]
pub fn watcher_test(app: AppHandle, state: State<'_, WatcherState>) {
    let lang = state.settings.lock().unwrap().lang.clone();
    let (title, body) = text::test(&lang);
    let _ = app.notification().builder().title(&title).body(&body).show();
}

/// Starting with Windows, into the tray: a value under HKCU\...\Run with `--background`.
#[tauri::command]
pub fn watcher_autostart(enable: Option<bool>) -> Result<bool, String> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    let run = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", KEY_READ | KEY_SET_VALUE)
        .map_err(|e| e.to_string())?;
    if let Some(on) = enable {
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            run.set_value("DelphEye", &format!("\"{}\" --background", exe.display())).map_err(|e| e.to_string())?;
        } else {
            let _ = run.delete_value("DelphEye");
        }
    }
    Ok(run.get_value::<String, _>("DelphEye").is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip() {
        let j = Journal::in_memory();
        assert!(load_settings(&j).enabled);
        let s = Settings { enabled: true, off: vec!["heat".into()], weekly: false, tray_on_close: true, lang: "en".into() };
        kv_set(&j, "settings", &serde_json::to_string(&s).unwrap());
        let back = load_settings(&j);
        assert_eq!((back.off, back.weekly, back.lang.as_str()), (vec!["heat".to_string()], false, "en"));
    }

    #[test]
    fn every_kind_has_text_in_both_languages() {
        for lang in ["uk", "en"] {
            for kind in KINDS {
                let (title, body) = text::render(lang, kind, &json!({ "name": "X", "temp": 95, "drive": "C:", "free_gb": 3.2, "pct": 2, "ssid": "Home", "bssid": "AA", "kind": "shutdown", "mac": "AA", "link": "5" }));
                assert!(!title.is_empty() && !body.is_empty(), "{lang} {kind}");
            }
        }
    }
}

//! The overlay: a small "island" at the top of the screen, above every window and game, with how
//! the computer is doing — CPU, GPU, memory, temperatures, FPS of the game in front, ping and
//! Wi-Fi — and the watcher's alerts, which unfold from it instead of a Windows notification.
//!
//! It never takes clicks (they pass through to the game) except while opened with its hotkey.
//! Ctrl+Shift+F12 shows or hides it; Ctrl+Shift+F11 opens it into a panel; Ctrl+Shift+F10 takes
//! the Bluetooth headphones to this computer or lets them go.

pub mod fps;

use std::collections::VecDeque;
use std::net::Ipv4Addr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::journal::Journal;

pub const LABEL: &str = "overlay";
/// The window is larger than the island so the island can unfold inside it; the rest is
/// transparent and lets clicks through.
const WIDTH: f64 = 480.0;
const HEIGHT: f64 = 600.0;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    /// What the island shows.
    pub pc: bool,
    pub fps: bool,
    pub net: bool,
    /// The watcher's alerts unfold from the island instead of a Windows notification.
    pub alerts: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { enabled: false, pc: true, fps: true, net: true, alerts: true }
    }
}

#[derive(Default)]
pub struct OverlayState {
    pub settings: Mutex<Settings>,
    interactive: AtomicBool,
    net: Mutex<Net>,
}

#[derive(Default, Clone)]
struct Net {
    router_ms: Option<u32>,
    internet_ms: Option<u32>,
    /// Windows sees a way to the internet, whatever the pings say.
    online: bool,
    /// The last internet pings: answered or not.
    answers: VecDeque<bool>,
}

fn toggle_key() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F12)
}

fn open_key() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F11)
}

fn headphones_key() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F10)
}

fn load(j: &Journal) -> Settings {
    crate::watcher::kv_get(j, "overlay").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

fn save(j: &Journal, s: &Settings) {
    crate::watcher::kv_set(j, "overlay", &serde_json::to_string(s).unwrap_or_default());
}

/// The overlay window, created hidden the first time it is needed.
fn window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("DelphEye overlay")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| crate::errlog::write("overlay", &format!("window: {e}")))
        .ok()?;
    place(&w);
    let _ = w.set_ignore_cursor_events(true);
    Some(w)
}

/// Top centre of the main screen.
fn place(w: &WebviewWindow) {
    let Ok(Some(m)) = w.primary_monitor() else { return };
    let scale = m.scale_factor();
    let x = m.position().x + ((m.size().width as f64 - WIDTH * scale) / 2.0) as i32;
    let y = m.position().y + (4.0 * scale) as i32;
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

fn visible(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).and_then(|w| w.is_visible().ok()).unwrap_or(false)
}

fn show(app: &AppHandle, on: bool) {
    if on {
        if let Some(w) = window(app) {
            place(&w);
            let _ = w.show();
            let _ = w.set_always_on_top(true);
            if app.state::<OverlayState>().settings.lock().unwrap().fps {
                fps::start();
            }
        }
    } else if let Some(w) = app.get_webview_window(LABEL) {
        set_interactive(app, false);
        let _ = w.hide();
    }
}

fn set_interactive(app: &AppHandle, on: bool) {
    let state = app.state::<OverlayState>();
    state.interactive.store(on, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.set_ignore_cursor_events(!on);
        if on {
            let _ = w.set_focus();
        }
    }
    let _ = app.emit_to(LABEL, "overlay:interactive", on);
}

fn set_enabled(app: &AppHandle, on: bool) {
    let state = app.state::<OverlayState>();
    let mut s = state.settings.lock().unwrap().clone();
    s.enabled = on;
    save(&app.state::<Journal>(), &s);
    *state.settings.lock().unwrap() = s.clone();
    show(app, on);
    let _ = app.emit("overlay:settings", &s);
}

/// What the global hotkeys do. Off the event loop: a window must not be built on it.
pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    let (app, shortcut) = (app.clone(), *shortcut);
    std::thread::spawn(move || hotkey(&app, &shortcut));
}

fn hotkey(app: &AppHandle, shortcut: &Shortcut) {
    if *shortcut == headphones_key() {
        crate::headphones::switch(app, None);
    } else if *shortcut == toggle_key() {
        set_enabled(app, !visible(app));
    } else if *shortcut == open_key() {
        if !visible(app) {
            set_enabled(app, true);
        }
        let on = !app.state::<OverlayState>().interactive.load(Ordering::SeqCst);
        set_interactive(app, on);
    }
}

/// An alert from the watcher. True when the island showed it (so no Windows notification).
pub fn alert(app: &AppHandle, kind: &str, level: &str, title: &str, body: &str) -> bool {
    let on = app.state::<OverlayState>().settings.lock().unwrap().alerts;
    if !on || !visible(app) {
        return false;
    }
    app.emit_to(LABEL, "overlay:alert", json!({ "kind": kind, "level": level, "title": title, "body": body })).is_ok()
}

/// The way router pings go: over Wi-Fi when connected, else over the cable.
fn route() -> Option<(Ipv4Addr, Ipv4Addr)> {
    crate::network::wifi_route().or_else(|| Some((*crate::network::lan_ipv4().first()?, crate::network::gateway()?)))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Tick {
    cpu_temp: Option<f64>,
    gpu_temp: Option<f64>,
    gpu_load: Option<f64>,
    fps: Option<fps::Fps>,
    /// "listening", "off" (needs administrator) or "failed".
    fps_status: &'static str,
    router_ms: Option<u32>,
    internet_ms: Option<u32>,
    online: bool,
    /// Lost internet pings of the last 20, in percent.
    loss: Option<u32>,
    wifi: Option<serde_json::Value>,
    elevated: bool,
}

fn tick(app: &AppHandle) -> Tick {
    let frame = app.state::<crate::monitor::MonitorState>().sensors.latest();
    let gpu_load = frame.as_ref().and_then(|f| {
        f.sensors()
            .filter(|(h, s)| h.kind.starts_with("Gpu") && s.kind == "Load" && (s.name == "GPU Core" || s.name == "D3D 3D"))
            .map(|(_, s)| s.value)
            .max_by(f64::total_cmp)
    });
    let net = app.state::<OverlayState>().net.lock().unwrap().clone();
    let loss = (net.answers.len() >= 5).then(|| (net.answers.iter().filter(|a| !**a).count() * 100 / net.answers.len()) as u32);
    let wifi = crate::wifi::link_now().map(|l| json!({ "ssid": l.ssid, "rssi": l.rssi, "quality": l.quality }));
    Tick {
        cpu_temp: frame.as_ref().and_then(|f| f.cpu_temp()).map(|t| t.round()),
        gpu_temp: frame.as_ref().and_then(|f| f.gpu_temp()).map(|t| t.round()),
        gpu_load: gpu_load.map(|l| l.round()),
        fps: fps::current(),
        fps_status: fps::status(),
        router_ms: net.router_ms,
        internet_ms: net.internet_ms,
        online: net.online,
        loss,
        wifi,
        elevated: crate::system::is_elevated(),
    }
}

/// Starts the overlay: its hotkeys, and (when switched on) the window with its feed.
pub fn start(app: &tauri::App) {
    let handle = app.handle().clone();
    let settings = load(&app.state::<Journal>());
    *app.state::<OverlayState>().settings.lock().unwrap() = settings.clone();
    for key in [toggle_key(), open_key(), headphones_key()] {
        if let Err(e) = app.global_shortcut().register(key) {
            crate::errlog::write("overlay", &format!("hotkey taken: {e}"));
        }
    }
    if settings.enabled {
        show(&handle, true);
    }
    // Once a second while it is on screen: everything the island shows that DelphEye does not
    // already send (CPU and memory come with the `metrics` event).
    let feed = handle.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if visible(&feed) {
                let _ = feed.emit_to(LABEL, "overlay:tick", tick(&feed));
            }
        }
    });
    // Pings every two seconds, apart, so a lost one never holds up the rest.
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let on = visible(&handle) && handle.state::<OverlayState>().settings.lock().unwrap().net;
            if !on {
                continue;
            }
            let router_ms = route().and_then(|(from, gateway)| crate::network::ping_from(from, gateway, 800));
            // The way the game's own traffic goes — through a VPN too. Forced over Wi-Fi it would
            // be blocked by the VPN and look like no network at all.
            let internet_ms = crate::network::ping(Ipv4Addr::new(1, 1, 1, 1), 1200);
            let online = internet_ms.is_some() || crate::network::windows_online().unwrap_or(false);
            let state = handle.state::<OverlayState>();
            let mut net = state.net.lock().unwrap();
            net.router_ms = router_ms;
            net.internet_ms = internet_ms;
            net.online = online;
            net.answers.push_back(internet_ms.is_some());
            while net.answers.len() > 20 {
                net.answers.pop_front();
            }
        }
    });
}

// ───────────────────────── commands ─────────────────────────

#[tauri::command]
pub fn overlay_settings(state: State<'_, OverlayState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

// The commands that may build the window are async: on Windows a window built inside a
// synchronous command (on the event loop) hangs the app.
#[tauri::command]
pub async fn overlay_save(app: AppHandle, settings: Settings) {
    save(&app.state::<Journal>(), &settings);
    *app.state::<OverlayState>().settings.lock().unwrap() = settings.clone();
    show(&app, settings.enabled);
    let _ = app.emit("overlay:settings", &settings);
}

/// The island closes its panel (Escape, a click outside it): clicks pass through again.
#[tauri::command]
pub async fn overlay_interactive(app: AppHandle, on: bool) {
    set_interactive(&app, on);
}

/// A sample alert, so the user sees how one unfolds.
#[tauri::command]
pub async fn overlay_test(app: AppHandle) -> bool {
    let uk = app.state::<crate::watcher::WatcherState>().settings.lock().unwrap().lang != "en";
    let (title, body) = if uk {
        ("Так виглядає сповіщення", "Наглядач показуватиме тут перегрів, повний диск, нові пристрої та програми в автозапуску.")
    } else {
        ("This is what an alert looks like", "The watcher will show overheating, a full disk, new devices and new startup programs here.")
    };
    if !visible(&app) {
        set_enabled(&app, true);
        tokio_sleep().await;
    }
    app.emit_to(LABEL, "overlay:alert", json!({ "kind": "test", "level": "info", "title": title, "body": body })).is_ok()
}

/// Opens DelphEye's main window from the island.
#[tauri::command]
pub async fn overlay_open_main(app: AppHandle, page: Option<String>) {
    set_interactive(&app, false);
    crate::watcher::show_main(&app);
    if let Some(p) = page {
        let _ = app.emit_to("main", "navigate", p);
    }
}

/// Gives a just-shown island a moment to load before an alert is sent to it.
async fn tokio_sleep() {
    let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(900))).await;
}

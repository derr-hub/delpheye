//! Professional mode: a connection to the home router itself, to see the network from its side —
//! every device on it and how loud each one is at the router, the router's own settings, and
//! what in them weakens the network's protection.
//!
//! Only ASUS routers so far. The user types the router's password; it can be kept in Windows
//! Credential Manager. Everything here only reads.

pub mod asus;
mod vault;

use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

pub use asus::{LoginInfo, Overview};

#[derive(Default)]
pub struct RouterState {
    /// (host, token, user, password) of the current session; the password stays in memory only
    /// for this run, to renew an expired session with the login that already worked.
    session: Mutex<Option<(String, String, String, String)>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub host: Option<String>,
    /// "asus", or "unknown" when the router answers but is not one DelphEye can read yet.
    pub vendor: &'static str,
    /// The model the router reports before login, e.g. "RT-AX52".
    pub model: Option<String>,
    pub login: Option<LoginInfo>,
    /// A saved login exists for this router.
    pub saved: bool,
    pub connected: bool,
}

fn host() -> Option<String> {
    crate::network::gateway().map(|g| g.to_string())
}

/// Finds the router and what its login page says. Never logs in.
#[tauri::command]
pub async fn router_find(state: State<'_, RouterState>) -> Result<Found, String> {
    let connected = state.session.lock().unwrap().is_some();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(host) = host() else { return Found { host: None, vendor: "unknown", model: None, login: None, saved: false, connected: false } };
        let model = asus::detect(&host);
        Found {
            vendor: if model.is_some() { "asus" } else { "unknown" },
            login: if model.is_some() { asus::login_page(&host).ok() } else { None },
            model: model.filter(|m| !m.is_empty()),
            saved: vault::exists(&host),
            host: Some(host),
            connected,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// One login attempt — never repeated on its own: the router locks after a few wrong passwords.
/// With no `password`, the saved login is used. Errors: "wrong", "captcha", "locked:<secs>",
/// "unreachable", "no-saved", "not-asus".
#[tauri::command]
pub async fn router_connect(state: State<'_, RouterState>, user: Option<String>, password: Option<String>, remember: bool) -> Result<Overview, String> {
    let (host, user, password) = tauri::async_runtime::spawn_blocking(move || -> Result<(String, String, String), String> {
        let host = host().ok_or("unreachable")?;
        if asus::detect(&host).is_none() {
            return Err("not-asus".into());
        }
        match (user, password) {
            (Some(u), Some(p)) if !p.is_empty() => Ok((host, u, p)),
            _ => vault::load(&host).map(|(u, p)| (host, u, p)).ok_or_else(|| "no-saved".to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    let (h, u, p) = (host.clone(), user.clone(), password.clone());
    let token = tauri::async_runtime::spawn_blocking(move || asus::login(&h, &u, &p)).await.map_err(|e| e.to_string())?.map_err(|e| match e {
        asus::LoginError::Wrong => "wrong".to_string(),
        asus::LoginError::Captcha => "captcha".to_string(),
        asus::LoginError::Locked(secs) => format!("locked:{}", secs.unwrap_or(0)),
        asus::LoginError::Unreachable(_) => "unreachable".to_string(),
        asus::LoginError::Other(m) => {
            crate::errlog::write("router", &format!("login failed: {m}"));
            "failed".to_string()
        }
    })?;
    if remember {
        vault::save(&host, &user, &password)?;
    }
    crate::errlog::write("router", &format!("connected to the router at {host}"));
    *state.session.lock().unwrap() = Some((host, token, user, password));
    router_read(state).await
}

fn read(host: &str, token: &str) -> Result<Overview, String> {
    // In batches, to keep each address short.
    let mut nv = serde_json::Map::new();
    for chunk in asus::NVRAM.chunks(16) {
        let hooks = chunk.iter().map(|k| format!("nvram_get({k})")).collect::<Vec<_>>().join(";");
        match asus::hook(host, token, &hooks)? {
            serde_json::Value::Object(m) => nv.extend(m),
            _ => {}
        }
    }
    if nv.is_empty() {
        crate::errlog::write("router", "the router returned no settings");
    }
    let nv = serde_json::Value::Object(nv);
    let clients = asus::hook(host, token, "get_clientlist()")?;
    let uptime = asus::hook(host, token, "uptime()").unwrap_or_default();
    Ok(asus::overview(host, &nv, &clients, &uptime))
}

/// A fresh look at the router, renewing the session once if it expired.
#[tauri::command]
pub async fn router_read(state: State<'_, RouterState>) -> Result<Overview, String> {
    let session = state.session.lock().unwrap().clone().ok_or("not-connected")?;
    let (host, token, user, password) = session;
    let result = tauri::async_runtime::spawn_blocking(move || match read(&host, &token) {
        Err(e) if e == "expired" => {
            // The login that just worked, once more — not a guess.
            let token = asus::login(&host, &user, &password).map_err(|_| "expired".to_string())?;
            read(&host, &token).map(|o| (o, Some(token)))
        }
        other => other.map(|o| (o, None)),
    })
    .await
    .map_err(|e| e.to_string())?;
    match result {
        Ok((overview, renewed)) => {
            if let Some(token) = renewed {
                if let Some(s) = state.session.lock().unwrap().as_mut() {
                    s.1 = token;
                }
            }
            Ok(overview)
        }
        Err(e) => {
            if e == "expired" {
                *state.session.lock().unwrap() = None;
            }
            Err(e)
        }
    }
}

/// One of the few changes DelphEye offers (see `asus::change`), after the user confirmed it.
/// Reads the router again afterwards, so the answer shows whether the change took.
#[tauri::command]
pub async fn router_apply(state: State<'_, RouterState>, action: String, guest: Option<String>) -> Result<Overview, String> {
    let (values, service) = asus::change(&action, guest.as_deref()).ok_or("unknown-action")?;
    let (host, token, ..) = state.session.lock().unwrap().clone().ok_or("not-connected")?;
    let log = format!("{action}{}", guest.as_deref().map(|g| format!(" {g}")).unwrap_or_default());
    let slow = service == "restart_wireless";
    tauri::async_runtime::spawn_blocking(move || asus::apply(&host, &token, &values, service)).await.map_err(|e| e.to_string())??;
    crate::errlog::write("router", &format!("applied {log}"));
    // The router restarts the service in the background; give it a moment before reading.
    tokio_sleep(if slow { 4000 } else { 1500 }).await;
    router_read(state).await
}

async fn tokio_sleep(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
}

/// For the background watcher: the devices on the router, read with the saved login. Keeps its own
/// session; a wrong saved password is reported as Err("wrong") and never retried by the caller.
pub fn watch_clients(session: &mut Option<(String, String)>) -> Result<Vec<asus::Client>, String> {
    let host = host().ok_or("unreachable")?;
    let read = |token: &str| asus::hook(&host, token, "get_clientlist()").map(|v| asus::clients(&v));
    if let Some((h, token)) = session.as_ref() {
        if *h == host {
            match read(token) {
                Err(e) if e == "expired" => {}
                other => return other,
            }
        }
    }
    let (user, password) = vault::load(&host).ok_or("no-saved")?;
    let token = asus::login(&host, &user, &password).map_err(|e| match e {
        asus::LoginError::Wrong => "wrong".to_string(),
        asus::LoginError::Captcha => "captcha".to_string(),
        asus::LoginError::Locked(_) => "locked".to_string(),
        _ => "unreachable".to_string(),
    })?;
    let clients = read(&token)?;
    *session = Some((host, token));
    Ok(clients)
}

pub fn has_saved_login() -> bool {
    host().is_some_and(|h| vault::exists(&h))
}

/// Logs out of the router; `forget` also removes the saved login.
#[tauri::command]
pub async fn router_disconnect(state: State<'_, RouterState>, forget: bool) -> Result<(), String> {
    let session = state.session.lock().unwrap().take();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some((host, token, ..)) = &session {
            asus::logout(host, token);
        }
        if forget {
            if let Some(h) = session.map(|s| s.0).or_else(host) {
                vault::forget(&h);
            }
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Development only: the router's raw answer to one appGet hook, to see what a firmware sends.
/// Release builds refuse it.
#[tauri::command]
pub async fn router_debug_hook(state: State<'_, RouterState>, hooks: String) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        let (host, token, ..) = state.session.lock().unwrap().clone().ok_or("not-connected")?;
        tauri::async_runtime::spawn_blocking(move || asus::raw(&host, &token, &hooks)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (state, hooks);
        Err("unavailable".into())
    }
}

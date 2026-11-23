//! Windows restore points: one made by hand, or by itself before a big change (a cleanup,
//! installing updates). Windows allows it only to administrators, only when System Protection
//! is on for the system drive, and by default at most once a day.

use std::os::windows::process::CommandExt;
use std::process::Command;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::journal::Journal;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub seq: i64,
    pub description: String,
    /// "2026-11-23T10:15:00".
    pub created: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub elevated: bool,
    /// System Protection is on (None when Windows would not say).
    pub protection: Option<bool>,
    /// Newest first; empty without administrator rights (Windows shows them only to admins).
    pub points: Vec<Point>,
    /// Make one by itself before big changes.
    pub auto: bool,
}

fn powershell(script: &str) -> Result<String, String> {
    let windows = crate::system::Dirs::real().map(|d| d.windows).ok_or("no-windows")?;
    let out = Command::new(windows.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Whether System Protection is on: Windows keeps RPSessionInterval at 1 while it is.
fn protection() -> Option<bool> {
    use winreg::RegKey;
    use winreg::enums::HKEY_LOCAL_MACHINE;
    let key = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore").ok()?;
    if key.get_value::<u32, _>("DisableSR").unwrap_or(0) == 1 {
        return Some(false);
    }
    key.get_value::<u32, _>("RPSessionInterval").ok().map(|v| v != 0)
}

/// Windows' restore points, newest first (needs administrator rights).
fn points() -> Vec<Point> {
    let script = "$ErrorActionPreference='Stop'; try { @(Get-ComputerRestorePoint | ForEach-Object { [pscustomobject]@{ seq = [int64]$_.SequenceNumber; description = [string]$_.Description; created = ([Management.ManagementDateTimeConverter]::ToDateTime($_.CreationTime)).ToString('s') } }) | ConvertTo-Json -Compress } catch { '[]' }";
    let text = powershell(script).unwrap_or_default();
    let v: Value = serde_json::from_str(text.trim()).unwrap_or(Value::Null);
    let list = match v {
        Value::Array(a) => a,
        Value::Object(_) => vec![v],
        _ => vec![],
    };
    let mut out: Vec<Point> = list
        .iter()
        .map(|p| Point { seq: p["seq"].as_i64().unwrap_or(0), description: p["description"].as_str().unwrap_or_default().into(), created: p["created"].as_str().unwrap_or_default().into() })
        .collect();
    out.sort_by(|a, b| b.seq.cmp(&a.seq));
    out
}

fn auto(j: &Journal) -> bool {
    crate::watcher::kv_get(j, "restore.auto").map(|v| v == "1").unwrap_or(true)
}

#[tauri::command]
pub async fn restore_status(app: AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let elevated = crate::system::is_elevated();
        Status { elevated, protection: protection(), points: if elevated { points() } else { Vec::new() }, auto: auto(&app.state::<Journal>()) }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_auto(journal: tauri::State<'_, Journal>, on: bool) {
    crate::watcher::kv_set(&journal, "restore.auto", if on { "1" } else { "0" });
}

/// "created", "skipped" (Windows made one less than a day ago and would not make another),
/// "need-admin", "protection-off".
fn create(description: &str) -> Result<&'static str, String> {
    if !crate::system::is_elevated() {
        return Err("need-admin".into());
    }
    if protection() == Some(false) {
        return Err("protection-off".into());
    }
    let before = points().first().map(|p| p.seq).unwrap_or(0);
    let safe: String = description.chars().filter(|c| c.is_alphanumeric() || " .,:-()".contains(*c)).take(60).collect();
    let script = format!("$ErrorActionPreference='Stop'; try {{ Checkpoint-Computer -Description '{safe}' -RestorePointType MODIFY_SETTINGS -WarningAction SilentlyContinue; 'ok' }} catch {{ 'error: ' + $_.Exception.Message }}");
    let out = powershell(&script)?;
    let out = out.trim();
    if out.starts_with("error") {
        crate::errlog::write("restore", out);
        return Err(out.trim_start_matches("error: ").to_string());
    }
    let after = points().first().map(|p| p.seq).unwrap_or(0);
    let result = if after > before { "created" } else { "skipped" };
    crate::errlog::write("restore", result);
    Ok(result)
}

#[tauri::command]
pub async fn restore_create(description: String) -> Result<&'static str, String> {
    tauri::async_runtime::spawn_blocking(move || create(&description)).await.map_err(|e| e.to_string())?
}

/// Before a big change: makes a point when the user wants it and Windows allows it.
/// Never fails the change itself: answers what happened ("off", "created", "skipped", "need-admin"…).
#[tauri::command]
pub async fn restore_before(app: AppHandle, what: String) -> String {
    tauri::async_runtime::spawn_blocking(move || {
        if !auto(&app.state::<Journal>()) {
            return "off".to_string();
        }
        if !crate::system::is_elevated() {
            return "need-admin".to_string();
        }
        match create(&format!("DelphEye: {what}")) {
            Ok(r) => r.to_string(),
            Err(e) => e,
        }
    })
    .await
    .unwrap_or_else(|e| e.to_string())
}

/// Opens Windows' System Protection settings, where the user can switch protection on.
#[tauri::command]
pub fn restore_open_settings() -> Result<(), String> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{HSTRING, w};
    let windows = crate::system::Dirs::real().map(|d| d.windows).ok_or("no-windows")?;
    // It asks for administrator rights itself (UAC), so it is started through the shell.
    let exe = HSTRING::from(windows.join(r"System32\SystemPropertiesProtection.exe").as_os_str());
    let r = unsafe { ShellExecuteW(None, w!("open"), &exe, None, None, SW_SHOWNORMAL) };
    if r.0 as isize > 32 { Ok(()) } else { Err("declined".into()) }
}

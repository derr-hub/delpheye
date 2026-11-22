//! Which programs used the camera, the microphone and the location, and which use them right now.
//!
//! Windows records every use itself, under CapabilityAccessManager\ConsentStore: one key per app
//! with the time the last use started and stopped (FILETIME). Store apps are keyed by package
//! family name; desktop programs sit under `NonPackaged`, keyed by their path with `#` for `\`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};

const STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";
const PACKAGES: &str = r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages";
pub const KINDS: [&str; 3] = ["webcam", "microphone", "location"];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Use {
    /// The registry key name: a package family name or a `#`-path.
    pub key: String,
    pub name: String,
    /// The program file, for desktop programs (and the icon).
    pub path: Option<String>,
    pub packaged: bool,
    /// Recorded machine-wide: a Windows service rather than a program the user started.
    pub system: bool,
    /// Unix milliseconds.
    pub started: Option<i64>,
    pub stopped: Option<i64>,
    /// Using it at this moment.
    pub active: bool,
    /// Windows says it is still in use, but the program is no longer running (it crashed or
    /// was killed before it could say it stopped).
    pub stale: bool,
    /// The user's answer for this app: "allow", "deny", or none yet.
    pub permission: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub kind: &'static str,
    /// Apps may use it at all (Settings → Privacy).
    pub allowed: bool,
    /// Desktop programs may use it ("Let desktop apps access…").
    pub desktop_allowed: bool,
    pub uses: Vec<Use>,
}

/// FILETIME (100 ns since 1601) to Unix milliseconds; 0 means "never".
pub fn unix_ms(filetime: u64) -> Option<i64> {
    (filetime > 0).then(|| (filetime / 10_000) as i64 - 11_644_473_600_000)
}

/// `C:#Program Files#App#app.exe` → `C:\Program Files\App\app.exe`.
pub fn unhash(key: &str) -> String {
    key.replace('#', "\\")
}

/// `Microsoft.WindowsCamera_8wekyb3d8bbwe` → "Windows Camera", when Windows has no better name.
pub fn pretty(family: &str) -> String {
    let name = family.split('_').next().unwrap_or(family);
    // Drop the publisher part: "Microsoft.", "5319275A." and the like.
    let name = name.rsplit('.').next().unwrap_or(name);
    let mut out = String::new();
    let chars: Vec<char> = name.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 && c.is_uppercase() && (chars[i - 1].is_lowercase() || chars.get(i + 1).is_some_and(|n| n.is_lowercase()) && chars[i - 1].is_uppercase()) {
            out.push(' ');
        }
        out.push(c);
    }
    out
}

/// The installed package of a Store app family: its display name and install folder.
fn package(family: &str) -> Option<(Option<String>, Option<PathBuf>)> {
    let (name, publisher) = family.split_once('_')?;
    let root = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(PACKAGES, KEY_READ).ok()?;
    // Full name: Name_Version_Arch_ResourceId_PublisherId. The newest version sorts last.
    let mut fulls: Vec<String> = root
        .enum_keys()
        .flatten()
        .filter(|full| full.starts_with(&format!("{name}_")) && full.ends_with(&format!("_{publisher}")) && full.split('_').count() >= 5)
        .collect();
    fulls.sort();
    let full = fulls.pop()?;
    let key = root.open_subkey(&full).ok()?;
    let display: Option<String> = key.get_value("DisplayName").ok();
    let folder: Option<String> = key.get_value("PackageRootFolder").ok();
    let display = display.and_then(|d| match d.strip_prefix("ms-resource:") {
        Some(rest) => {
            let rest = rest.trim_start_matches('/');
            [format!("@{{{full}?ms-resource://{name}/{rest}}}"), format!("@{{{full}?ms-resource://{name}/Resources/{rest}}}")]
                .iter()
                .find_map(|s| crate::startup::resolve_text(s).filter(|t| !t.starts_with('@')))
                .or_else(|| known(name).map(str::to_string))
        }
        None if d.starts_with('@') => crate::startup::resolve_text(&d).filter(|t| !t.starts_with('@')).or_else(|| known(name).map(str::to_string)),
        None => Some(d),
    });
    Some((display, folder.map(PathBuf::from)))
}

/// Windows' own apps whose names Windows will not resolve outside their package.
fn known(name: &str) -> Option<&'static str> {
    Some(match name.to_ascii_lowercase().as_str() {
        "windows.immersivecontrolpanel" => "Windows Settings",
        "microsoft.bioenrollment" => "Windows Hello",
        "microsoft.windows.cortana" => "Cortana",
        "microsoftwindows.client.webexperience" => "Windows Widgets",
        "microsoft.windows.shellexperiencehost" => "Windows Shell",
        _ => return None,
    })
}

/// One program can sit under several keys (each update installs into a new versioned folder):
/// keep one row per program, with its latest use.
fn merge(uses: Vec<Use>) -> Vec<Use> {
    let mut out: Vec<Use> = Vec::new();
    for u in uses {
        match out.iter_mut().find(|o| o.system == u.system && o.name.eq_ignore_ascii_case(&u.name)) {
            Some(o) => {
                let (active, stale) = (o.active || u.active, (o.stale || u.stale) && !(o.active || u.active));
                let permission = o.permission.clone().or(u.permission.clone());
                if u.started > o.started {
                    *o = u;
                }
                o.active = active;
                o.stale = stale;
                o.permission = permission;
            }
            None => out.push(u),
        }
    }
    out
}

static NAMES: Mutex<Option<HashMap<String, (String, Option<PathBuf>)>>> = Mutex::new(None);

/// A friendly name (and, for Store apps, the install folder), looked up once per key.
fn identify(key: &str, packaged: bool) -> (String, Option<PathBuf>) {
    if let Some(hit) = NAMES.lock().unwrap().get_or_insert_with(HashMap::new).get(key).cloned() {
        return hit;
    }
    let found = if packaged {
        match package(key) {
            Some((name, folder)) => (name.unwrap_or_else(|| pretty(key)), folder),
            None => (pretty(key), None),
        }
    } else {
        let path = PathBuf::from(unhash(key));
        let facts = crate::startup::fileinfo::inspect(&path, false);
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| key.to_string());
        // Games often carry no description, only an engine-made file name.
        let stem = stem.trim_end_matches("-Win64-Shipping").to_string();
        (facts.description.filter(|d| !d.trim().is_empty() && !d.ends_with("-Win64-Shipping")).unwrap_or(stem), None)
    };
    NAMES.lock().unwrap().get_or_insert_with(HashMap::new).insert(key.to_string(), found.clone());
    found
}

fn read_uses(store: &RegKey, system: bool, running: &[PathBuf], out: &mut Vec<Use>) {
    let mut entry = |key: &RegKey, name: &str, packaged: bool| {
        let start: u64 = key.get_value("LastUsedTimeStart").unwrap_or(0);
        let stop: u64 = key.get_value("LastUsedTimeStop").unwrap_or(0);
        let permission: Option<String> = key.get_value::<String, _>("Value").ok().and_then(|v| match v.as_str() {
            "Allow" => Some("allow".into()),
            "Deny" => Some("deny".into()),
            _ => None,
        });
        if start == 0 {
            return; // Never used: only an answer to a prompt, not interesting here.
        }
        let (display, folder) = identify(name, packaged);
        let path = (!packaged).then(|| unhash(name));
        let is_running = match (&path, &folder) {
            (Some(p), _) => running.iter().any(|r| r.as_os_str().eq_ignore_ascii_case(p)),
            (None, Some(f)) => running.iter().any(|r| r.starts_with(f)),
            (None, None) => true, // Cannot tell: trust Windows.
        };
        let open = stop == 0 || stop < start;
        out.push(Use {
            key: name.to_string(),
            name: display,
            path,
            packaged,
            system,
            started: unix_ms(start),
            stopped: if open { None } else { unix_ms(stop) },
            active: open && is_running,
            stale: open && !is_running,
            permission,
        });
    };
    for name in store.enum_keys().flatten() {
        let Ok(key) = store.open_subkey(&name) else { continue };
        if name == "NonPackaged" {
            for path in key.enum_keys().flatten() {
                if let Ok(sub) = key.open_subkey(&path) {
                    entry(&sub, &path, false);
                }
            }
        } else {
            entry(&key, &name, true);
        }
    }
}

fn allowed(hive: &RegKey, path: &str) -> bool {
    hive.open_subkey(path).and_then(|k| k.get_value::<String, _>("Value")).map(|v| v != "Deny").unwrap_or(true)
}

pub fn snapshot() -> Vec<Capability> {
    let user = RegKey::predef(HKEY_CURRENT_USER);
    let machine = RegKey::predef(HKEY_LOCAL_MACHINE);
    let running: Vec<PathBuf> = crate::processes::samples().into_iter().filter_map(|s| s.exe).collect();
    KINDS
        .iter()
        .map(|&kind| {
            let path = format!(r"{STORE}\{kind}");
            let mut uses = Vec::new();
            if let Ok(store) = user.open_subkey(&path) {
                read_uses(&store, false, &running, &mut uses);
            }
            if let Ok(store) = machine.open_subkey(&path) {
                read_uses(&store, true, &running, &mut uses);
            }
            let mut uses = merge(uses);
            uses.sort_by_key(|u| (!u.active, std::cmp::Reverse(u.started)));
            Capability {
                kind,
                allowed: allowed(&machine, &path) && allowed(&user, &path),
                desktop_allowed: allowed(&user, &format!(r"{path}\NonPackaged")),
                uses,
            }
        })
        .collect()
}

#[tauri::command]
pub async fn privacy_usage() -> Result<Vec<Capability>, String> {
    tauri::async_runtime::spawn_blocking(snapshot).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filetimes_become_unix_ms() {
        assert_eq!(unix_ms(0), None);
        // 2026-01-01T00:00:00Z
        assert_eq!(unix_ms(134_116_992_000_000_000), Some(1_767_225_600_000));
    }

    #[test]
    fn names_read_well() {
        assert_eq!(unhash(r"C:#Program Files#Google#Chrome#Application#chrome.exe"), r"C:\Program Files\Google\Chrome\Application\chrome.exe");
        assert_eq!(pretty("Microsoft.WindowsCamera_8wekyb3d8bbwe"), "Windows Camera");
        assert_eq!(pretty("5319275A.WhatsAppDesktop_cv1g1gvanyjgm"), "Whats App Desktop");
        assert_eq!(pretty("MSTeams_8wekyb3d8bbwe"), "MS Teams");
    }

    #[test]
    fn reads_this_machine() {
        let t = std::time::Instant::now();
        let all = snapshot();
        let first = t.elapsed();
        let t = std::time::Instant::now();
        snapshot();
        let again = t.elapsed();
        assert_eq!(all.len(), 3);
        for c in &all {
            for u in &c.uses {
                println!("{} | {} | active={} stale={} perm={:?}", c.kind, u.name, u.active, u.stale, u.permission);
                assert!(!u.name.is_empty(), "{u:?}");
                assert!(!(u.active && u.stale));
            }
        }
        println!("first {first:?}, again {again:?}");
        assert!(again.as_millis() < 100, "{again:?}");
    }
}

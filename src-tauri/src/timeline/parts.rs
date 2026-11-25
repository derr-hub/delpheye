//! Which file on this computer stands behind an event: the program, the driver, the service. Only looked
//! up, never run.

use std::path::{Path, PathBuf};

use serde::Serialize;
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};

use crate::leftovers::command_path;
use crate::startup::expand;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub path: String,
    /// "program", "service", "driver", "startup" or "listener".
    pub role: &'static str,
}

/// A service's or driver's command as a file: `\SystemRoot\…`, `system32\…`, `\??\C:\…`, quotes, arguments.
pub fn image(command: &str, windows: &Path) -> Option<PathBuf> {
    let c = expand(command.trim());
    let lower = c.to_lowercase();
    let c = if lower.starts_with(r"\systemroot\") {
        format!("{}\\{}", windows.display(), &c[12..])
    } else if lower.starts_with("system32\\") {
        format!("{}\\{c}", windows.display())
    } else {
        c.trim_start_matches(r"\??\").to_string()
    };
    if c.to_lowercase().ends_with(".sys") && !c.starts_with('"') {
        return Some(PathBuf::from(c));
    }
    command_path(&c)
}

/// The likeliest program of a folder (alike by name, then the largest), not deeper than two levels: what a person would call the program.
fn biggest_exe(dir: &Path, wanted: &str) -> Option<PathBuf> {
    let wanted: Vec<String> = wanted.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 2).map(str::to_string).collect();
    let mut found: Vec<(bool, u64, PathBuf)> = Vec::new();
    let mut look = vec![(dir.to_path_buf(), 0)];
    let mut seen = 0;
    while let Some((d, depth)) = look.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            seen += 1;
            if seen > 3000 {
                break;
            }
            let p = e.path();
            let Ok(kind) = e.file_type() else { continue };
            if kind.is_dir() && depth < 2 {
                look.push((p, depth + 1));
            } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")) {
                let name = p.file_stem().unwrap_or_default().to_string_lossy().to_lowercase();
                if ["unins", "setup", "crash", "update", "helper"].iter().any(|w| name.contains(w)) {
                    continue;
                }
                let alike = wanted.iter().any(|w| name.contains(w.as_str()) || w.contains(&name));
                found.push((alike, e.metadata().map(|m| m.len()).unwrap_or(0), p));
            }
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    found.into_iter().next().map(|f| f.2)
}

fn program(name: &str) -> Option<PathBuf> {
    const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    for (hive, view) in [(HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY), (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY), (HKEY_CURRENT_USER, 0)] {
        let Ok(list) = RegKey::predef(hive).open_subkey_with_flags(UNINSTALL, KEY_READ | view) else { continue };
        for id in list.enum_keys().flatten() {
            let Ok(k) = list.open_subkey_with_flags(&id, KEY_READ | view) else { continue };
            let text = |n: &str| k.get_value::<String, _>(n).unwrap_or_default();
            if text("DisplayName").trim() != name {
                continue;
            }
            let icon = command_path(&expand(&text("DisplayIcon"))).filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) && p.is_file());
            if icon.as_ref().is_some_and(|p| !p.to_string_lossy().to_lowercase().contains("unins")) {
                return icon;
            }
            let place = text("InstallLocation");
            let place = PathBuf::from(place.trim().trim_matches('"'));
            if place.is_absolute() && place.components().count() > 2 && let Some(p) = biggest_exe(&place, name) {
                return Some(p);
            }
            if let Some(dir) = command_path(&text("UninstallString")).and_then(|p| p.parent().map(Path::to_path_buf))
                && !dir.to_string_lossy().to_lowercase().contains("\\windows\\")
                && dir.components().count() > 2
                && let Some(p) = biggest_exe(&dir, name)
            {
                return Some(p);
            }
        }
    }
    None
}

/// The driver's own file, from the store Windows keeps every installed package in.
fn driver(family: &str, windows: &Path) -> Vec<PathBuf> {
    let store = windows.join("System32").join("DriverStore").join("FileRepository");
    let prefix = format!("{}.inf_", family.to_lowercase());
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(store)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().to_lowercase().starts_with(&prefix))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    dirs.sort_by(|a, b| b.0.cmp(&a.0));
    let Some((_, dir)) = dirs.into_iter().next() else { return Vec::new() };
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    for d in [dir.clone(), dir.join("x64"), dir.join("amd64")] {
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
            if e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("sys")) {
                files.push((e.metadata().map(|m| m.len()).unwrap_or(0), e.path()));
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().take(2).map(|f| f.1).collect()
}

fn service(name: &str, windows: &Path) -> Option<PathBuf> {
    let list = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Services", KEY_READ).ok()?;
    let found = list.open_subkey_with_flags(name, KEY_READ).ok().or_else(|| {
        list.enum_keys().flatten().find_map(|id| {
            let k = list.open_subkey_with_flags(&id, KEY_READ).ok()?;
            (k.get_value::<String, _>("DisplayName").ok()?.trim() == name).then_some(k)
        })
    })?;
    // A service living in svchost is its own library, not svchost.
    let dll = found.open_subkey_with_flags("Parameters", KEY_READ).ok().and_then(|p| p.get_value::<String, _>("ServiceDll").ok());
    if let Some(d) = dll {
        return image(&d, windows).or_else(|| Some(PathBuf::from(expand(&d))));
    }
    image(&found.get_value::<String, _>("ImagePath").ok()?, windows)
}

pub fn find(kind: &str, name: &str, now: Option<&str>, windows: &Path) -> Vec<Part> {
    let found: Vec<(PathBuf, &'static str)> = match kind {
        "program" => program(name).into_iter().map(|p| (p, "program")).collect(),
        "driver" => name.split('|').nth(2).filter(|f| !f.is_empty()).map(|f| driver(f, windows)).unwrap_or_default().into_iter().map(|p| (p, "driver")).collect(),
        "service" => now.and_then(|c| image(c, windows)).filter(|p| p.is_file()).or_else(|| service(name, windows)).into_iter().map(|p| (p, "service")).collect(),
        "svccrash" => service(name, windows).into_iter().map(|p| (p, "service")).collect(),
        "startup" => crate::startup::program_of(windows, name).into_iter().map(|p| (p, "startup")).collect(),
        "port" => crate::processes::peek(|s| s.iter().find(|x| x.name == name).and_then(|x| x.exe.clone())).into_iter().map(|p| (p, "listener")).collect(),
        "delpheye" | "recorder" => std::env::current_exe().ok().into_iter().map(|p| (p, "program")).collect(),
        _ => Vec::new(),
    };
    // A local file only: a network path would reach out to another computer.
    found.into_iter().filter(|(p, _)| p.is_absolute() && !p.to_string_lossy().starts_with(r"\\") && p.is_file()).map(|(p, role)| Part { path: p.to_string_lossy().into_owned(), role }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_become_files() {
        let w = Path::new(r"C:\Windows");
        let s = |c: &str| image(c, w).map(|p| p.to_string_lossy().into_owned());
        assert_eq!(s(r"\SystemRoot\System32\drivers\wintun.sys").as_deref(), Some(r"C:\Windows\System32\drivers\wintun.sys"));
        assert_eq!(s(r"system32\drivers\acpi.sys").as_deref(), Some(r"C:\Windows\system32\drivers\acpi.sys"));
        assert_eq!(s(r"\??\C:\Program Files\Proton VPN\callout.sys").as_deref(), Some(r"C:\Program Files\Proton VPN\callout.sys"));
        assert_eq!(s(r#""C:\Program Files\A B\svc.exe" -k run"#).as_deref(), Some(r"C:\Program Files\A B\svc.exe"));
    }

    #[test]
    fn windows_own_service_is_found() {
        let w = crate::system::Dirs::real().unwrap().windows;
        let p = find("svccrash", "wuauserv", None, &w);
        assert!(p.first().is_some_and(|p| p.path.to_lowercase().ends_with(".dll")), "{p:?}");
        assert!(find("driver", "x|y|no-such-family", None, &w).is_empty());
        assert!(find("net", "Home", None, &w).is_empty());
    }
}

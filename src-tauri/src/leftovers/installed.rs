//! What is installed on this machine, according to Windows itself.
//!
//! The main source is the list behind "Apps & features": the `Uninstall` registry keys.
//! Services are added too, since drivers and background services often have no entry there.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};

const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

/// One installed program, as far as matching folders to it goes.
#[derive(Deserialize, Debug, Default, Clone)]
pub struct Installed {
    pub name: String,
    #[serde(default)]
    pub publisher: String,
    /// Folders the program lives in or points to.
    #[serde(default)]
    pub paths: Vec<PathBuf>,
}

/// An "Apps & features" entry whose program is no longer on the disk.
#[derive(Debug, Clone)]
pub struct BrokenEntry {
    pub name: String,
    /// Full key path as `reg.exe` writes it, e.g. `HKCU\Software\...\Uninstall\Foo`.
    pub key: String,
    pub needs_admin: bool,
}

/// The program path at the start of a command line, e.g. an `UninstallString`.
///
/// Returns `None` when the line does not start with a plain absolute path.
pub fn command_path(line: &str) -> Option<PathBuf> {
    let line = line.trim();
    let path = if let Some(rest) = line.strip_prefix('"') {
        &rest[..rest.find('"')?]
    } else {
        let lower = line.to_lowercase();
        let end = lower.find(".exe").map_or(line.len(), |at| at + 4);
        &line[..end]
    };
    // `DisplayIcon` values carry an icon number after a comma: `C:\app.exe,0`.
    let path = path.rsplit_once(',').filter(|(_, n)| n.trim().parse::<i32>().is_ok()).map_or(path, |(p, _)| p);
    let path = path.strip_prefix(r"\??\").unwrap_or(path).trim();
    let bytes = path.as_bytes();
    let absolute = bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
    absolute.then(|| PathBuf::from(path))
}

/// The folder a program path stands for: the path itself if it names a folder, else its parent.
fn folder_of(path: PathBuf) -> PathBuf {
    let looks_like_file = path.extension().is_some_and(|ext| ext.len() <= 4);
    if looks_like_file && !path.is_dir() { path.parent().map(Path::to_path_buf).unwrap_or(path) } else { path }
}

fn text(key: &RegKey, name: &str) -> String {
    key.get_value::<String, _>(name).unwrap_or_default()
}

/// Reads every "Apps & features" entry: the programs, and the entries left without one.
pub fn from_registry() -> (Vec<Installed>, Vec<BrokenEntry>) {
    let views = [
        (HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY, format!(r"HKLM\{UNINSTALL}"), true),
        (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY, r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall".to_string(), true),
        (HKEY_CURRENT_USER, 0, format!(r"HKCU\{UNINSTALL}"), false),
    ];
    let mut installed = Vec::new();
    let mut broken = Vec::new();
    for (hive, view, shown, needs_admin) in views {
        let Ok(list) = RegKey::predef(hive).open_subkey_with_flags(UNINSTALL, KEY_READ | view) else { continue };
        for id in list.enum_keys().flatten() {
            let Ok(entry) = list.open_subkey_with_flags(&id, KEY_READ | view) else { continue };
            let name = text(&entry, "DisplayName");
            if name.is_empty() {
                continue;
            }
            let location = text(&entry, "InstallLocation");
            let uninstall = text(&entry, "UninstallString");
            let paths: Vec<PathBuf> = [command_path(&location).or_else(|| (!location.is_empty()).then(|| PathBuf::from(location.trim_matches('"')))),
                command_path(&uninstall),
                command_path(&text(&entry, "DisplayIcon"))]
            .into_iter()
            .flatten()
            .map(folder_of)
            .collect();

            if is_broken(&entry, &uninstall, &location) {
                broken.push(BrokenEntry { name: name.clone(), key: format!(r"{shown}\{id}"), needs_admin });
            }
            installed.push(Installed { name, publisher: text(&entry, "Publisher"), paths });
        }
    }
    (installed, broken)
}

/// An entry is broken when both its uninstaller and its install folder are gone.
///
/// Entries managed by Windows Installer, hidden system components and updates are never
/// called broken: their bookkeeping lives elsewhere and must stay consistent.
fn is_broken(entry: &RegKey, uninstall: &str, location: &str) -> bool {
    let flag = |name: &str| entry.get_value::<u32, _>(name).unwrap_or(0) == 1;
    if flag("SystemComponent") || flag("WindowsInstaller") || !text(entry, "ParentKeyName").is_empty() {
        return false;
    }
    let lower = uninstall.to_lowercase();
    if lower.contains("msiexec") || lower.contains("rundll32") {
        return false;
    }
    let Some(uninstaller) = command_path(uninstall) else { return false };
    let location_gone = location.trim().is_empty() || !Path::new(location.trim_matches('"')).exists();
    !uninstaller.exists() && location_gone
}

/// The folders of every service and driver's program.
pub fn service_folders() -> Vec<PathBuf> {
    let Ok(services) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SYSTEM\CurrentControlSet\Services") else {
        return Vec::new();
    };
    services
        .enum_keys()
        .flatten()
        .filter_map(|name| services.open_subkey(&name).ok())
        .filter_map(|service| command_path(&text(&service, "ImagePath")))
        .map(folder_of)
        .collect()
}

/// Whether a key exists at `path` under the hive and registry view given.
pub fn key_exists(hive_is_machine: bool, path: &str, view_32: bool) -> bool {
    let hive = RegKey::predef(if hive_is_machine { HKEY_LOCAL_MACHINE } else { HKEY_CURRENT_USER });
    let view = if view_32 { KEY_WOW64_32KEY } else { KEY_WOW64_64KEY };
    hive.open_subkey_with_flags(path, KEY_READ | view).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_paths_are_read_from_command_lines() {
        let cases = [
            (r#""C:\Program Files\Foo\unins000.exe" /SILENT"#, Some(r"C:\Program Files\Foo\unins000.exe")),
            (r"C:\Program Files\Foo\uninstall.exe --force", Some(r"C:\Program Files\Foo\uninstall.exe")),
            (r"C:\Program Files\Foo\App.EXE,0", Some(r"C:\Program Files\Foo\App.EXE")),
            (r#""C:\Users\me\AppData\Local\Bar\bar.ico",2"#, Some(r"C:\Users\me\AppData\Local\Bar\bar.ico")),
            (r"\??\C:\Windows\system32\drivers\x.sys", Some(r"C:\Windows\system32\drivers\x.sys")),
            (r"C:\Games\Old Game", Some(r"C:\Games\Old Game")),
            (r"MsiExec.exe /X{1234}", None),
            (r"system32\drivers\y.sys", None),
            (r"\SystemRoot\System32\z.sys", None),
            ("", None),
            (r#""unterminated"#, None),
        ];
        for (line, expected) in cases {
            assert_eq!(command_path(line), expected.map(PathBuf::from), "{line}");
        }
    }

    #[test]
    fn a_program_path_stands_for_its_folder() {
        assert_eq!(folder_of(PathBuf::from(r"C:\Nowhere\Foo\app.exe")), PathBuf::from(r"C:\Nowhere\Foo"));
        assert_eq!(folder_of(PathBuf::from(r"C:\Nowhere\Foo")), PathBuf::from(r"C:\Nowhere\Foo"));
    }
}

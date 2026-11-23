//! "Would your files survive ransomware?" — whether there is a copy of them somewhere the
//! ransomware cannot reach, and whether Windows guards the folders that matter.

use std::path::PathBuf;

use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};

use super::hardening::{Outcome, Report, Test};

/// Expands %VAR% in a registry path.
fn expand(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('%') {
            Some(j) => {
                out.push_str(&std::env::var(&after[..j]).unwrap_or_default());
                rest = &after[j + 1..];
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Where Documents, Desktop and Pictures really are.
fn known_folders() -> Vec<(&'static str, PathBuf)> {
    let Ok(k) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") else { return Vec::new() };
    [("documents", "Personal"), ("desktop", "Desktop"), ("pictures", "My Pictures")]
        .into_iter()
        .filter_map(|(name, value)| k.get_value::<String, _>(value).ok().map(|p| (name, PathBuf::from(expand(&p)))))
        .collect()
}

/// The OneDrive folders on this account (personal and work).
fn onedrive_roots() -> Vec<PathBuf> {
    ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].iter().filter_map(|v| std::env::var_os(v).map(PathBuf::from)).collect()
}

/// Which of the folders are inside OneDrive, i.e. kept in the cloud with their history.
pub fn in_cloud(folders: &[(&'static str, PathBuf)], roots: &[PathBuf]) -> Vec<&'static str> {
    folders
        .iter()
        .filter(|(_, p)| roots.iter().any(|r| !r.as_os_str().is_empty() && p.to_string_lossy().to_lowercase().starts_with(&r.to_string_lossy().to_lowercase())))
        .map(|(n, _)| *n)
        .collect()
}

fn file_history_on() -> Option<bool> {
    let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(r"Microsoft\Windows\FileHistory\Configuration");
    if !dir.is_dir() {
        return Some(false);
    }
    // Config1.xml holds <Enabled>1</Enabled>-like state; its presence with a target means it was set up.
    let text = std::fs::read_dir(&dir).ok()?.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".xml")).find_map(|e| std::fs::read_to_string(e.path()).ok())?;
    Some(text.contains("<Target") || text.contains("TargetUrl"))
}

/// Controlled folder access: Defender refuses unknown programs writing to protected folders.
fn controlled_folders(defender_active: bool) -> (Outcome, Option<String>) {
    if !defender_active {
        // Another antivirus is in charge; many have their own ransomware shield.
        return (Outcome::Unknown, Some("other-av".into()));
    }
    let v = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SOFTWARE\Microsoft\Windows Defender\Windows Defender Exploit Guard\Controlled Folder Access", KEY_READ | KEY_WOW64_64KEY)
        .ok()
        .and_then(|k| k.get_value::<u32, _>("EnableControlledFolderAccess").ok());
    (if v == Some(1) { Outcome::Pass } else { Outcome::Fail }, None)
}

fn system_protection() -> Option<bool> {
    let key = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore").ok()?;
    if key.get_value::<u32, _>("DisableSR").unwrap_or(0) == 1 {
        return Some(false);
    }
    key.get_value::<u32, _>("RPSessionInterval").ok().map(|v| v != 0)
}

pub fn run(defender_active: bool) -> Report {
    let mut tests = Vec::new();
    let folders = known_folders();
    let cloud = in_cloud(&folders, &onedrive_roots());
    let all = folders.len();
    tests.push(Test {
        id: "cloud-folders",
        outcome: if all > 0 && cloud.len() == all { Outcome::Pass } else { Outcome::Fail },
        weight: 30,
        detail: Some(if cloud.is_empty() { String::new() } else { cloud.join(", ") }),
        fix: Some("ms-settings:backup"),
    });
    let fh = file_history_on();
    let cloud_ok = all > 0 && cloud.len() == all;
    // One copy is enough: with the folders in the cloud, File History is a bonus, not a must.
    let (fh_outcome, fh_detail) = match fh {
        Some(true) => (Outcome::Pass, None),
        _ if cloud_ok => (Outcome::Unknown, Some("cloud-enough".to_string())),
        Some(false) => (Outcome::Fail, None),
        None => (Outcome::Unknown, None),
    };
    tests.push(Test { id: "file-history", outcome: fh_outcome, weight: 20, detail: fh_detail, fix: Some("ms-settings:backup") });
    let (cfa, detail) = controlled_folders(defender_active);
    tests.push(Test { id: "controlled-folders", outcome: cfa, weight: 20, detail, fix: Some("windowsdefender://ransomwareprotection") });
    tests.push(Test {
        id: "system-protection",
        outcome: match system_protection() {
            Some(true) => Outcome::Pass,
            Some(false) => Outcome::Fail,
            None => Outcome::Unknown,
        },
        weight: 15,
        detail: None,
        fix: None,
    });
    let counted: Vec<&Test> = tests.iter().filter(|t| t.outcome != Outcome::Unknown).collect();
    let total: u32 = counted.iter().map(|t| t.weight).sum();
    let got: u32 = counted.iter().filter(|t| t.outcome == Outcome::Pass).map(|t| t.weight).sum();
    // A copy anywhere counts most: with cloud folders or File History the files survive.
    let score = if total == 0 { 0 } else { got * 100 / total };
    Report { score, tests }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_inside_onedrive_count_as_backed_up() {
        let folders = vec![("documents", PathBuf::from(r"C:\Users\a\OneDrive\Documents")), ("desktop", PathBuf::from(r"C:\Users\a\Desktop"))];
        assert_eq!(in_cloud(&folders, &[PathBuf::from(r"C:\Users\a\OneDrive")]), vec!["documents"]);
        assert!(in_cloud(&folders, &[]).is_empty());
        assert_eq!(expand("%NOPE_VAR%\\x"), "\\x");
    }
}

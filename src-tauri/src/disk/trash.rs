//! Moving files and folders to the Recycle Bin, and deciding what must never go there.

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::Win32::UI::Shell::{
    FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_SILENT, FOF_WANTNUKEWARNING, SHFILEOPSTRUCTW,
    SHFileOperationW,
};
use windows::core::PCWSTR;

use crate::system::Dirs;

/// Things at the top of a drive that belong to Windows itself.
const SYSTEM_ROOT_ITEMS: &[&str] = &[
    "pagefile.sys",
    "hiberfil.sys",
    "swapfile.sys",
    "dumpstack.log.tmp",
    "bootmgr",
    "bootnxt",
    "boot",
    "efi",
    "recovery",
    "system volume information",
    "documents and settings",
];

/// Why `path` may not be sent to the Recycle Bin, or `None` if it may.
///
/// Anything inside a personal or program folder is the user's to remove. What is refused is
/// what would break Windows or wipe a whole profile in one click: the system folder and
/// everything in it, the folders that hold all programs or all user data, and the drive's own
/// system files.
pub fn refusal(path: &Path, dirs: &Dirs) -> Option<&'static str> {
    let lower = |p: &Path| p.to_string_lossy().to_lowercase().trim_end_matches('\\').to_string();
    let target = lower(path);
    let inside = |inner: &str, outer: &str| inner.len() > outer.len() && inner.starts_with(outer) && inner.as_bytes()[outer.len()] == b'\\';

    let parts: Vec<&str> = target.split('\\').filter(|p| !p.is_empty()).collect();
    match parts.as_slice() {
        [] | [_] => return Some("a whole drive"),
        [_, name] if name.starts_with('$') || SYSTEM_ROOT_ITEMS.contains(name) => return Some("a system item"),
        _ => {}
    }

    let windows = lower(&dirs.windows);
    if target == windows || inside(&target, &windows) {
        return Some("part of Windows");
    }

    let home = &dirs.home;
    let personal = ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos", "AppData"];
    let mut kept: Vec<String> = personal.iter().map(|d| lower(&home.join(d))).collect();
    kept.extend([home, &dirs.local, &dirs.roaming, &dirs.program_data].map(|p| lower(p)));
    kept.extend(home.parent().map(lower));
    kept.extend(dirs.program_files.iter().chain(&dirs.personal).map(|p| lower(p)));

    // Refused when it is one of these folders or holds one of them.
    kept.iter().any(|keep| *keep == target || inside(keep, &target)).then_some("a folder Windows or your profile depends on")
}

/// Whether `path` lies in a folder that Windows or installers manage for themselves.
pub fn is_system_managed(path: &Path, dirs: &Dirs) -> bool {
    let lower = |p: &Path| p.to_string_lossy().to_lowercase();
    let path = lower(path);
    [&dirs.windows, &dirs.program_data].iter().any(|folder| {
        let folder = lower(folder);
        path.len() > folder.len() && path.starts_with(&folder) && path.as_bytes()[folder.len()] == b'\\'
    })
}

/// Moves one file or folder to the Recycle Bin. Returns whether it is gone from its place.
///
/// If the item is too big for the bin, Windows asks before deleting it for good instead of
/// doing so silently.
pub fn recycle(path: &Path) -> bool {
    // The API takes a list of paths: each ends with a NUL, and the list with one more.
    let from: Vec<u16> = path.as_os_str().encode_wide().chain([0, 0]).collect();
    let flags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_WANTNUKEWARNING;
    let mut operation = SHFILEOPSTRUCTW {
        hwnd: Default::default(),
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        pTo: PCWSTR::null(),
        fFlags: flags.0 as u16,
        fAnyOperationsAborted: false.into(),
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: PCWSTR::null(),
    };
    // SAFETY: `operation` and the path list it points to are valid for the whole call.
    let status = unsafe { SHFileOperationW(&mut operation) };
    status == 0 && !operation.fAnyOperationsAborted.as_bool() && !path.exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cleanup::testing::{Sandbox, write};
    use std::path::PathBuf;

    #[test]
    fn system_and_profile_folders_are_refused_but_their_content_is_not() {
        let sandbox = Sandbox::new();
        let dirs = &sandbox.dirs;
        let drive = PathBuf::from(sandbox.root.to_string_lossy()[..3].to_string());

        let refused = [
            drive.clone(),
            drive.join("pagefile.sys"),
            drive.join("$Recycle.Bin"),
            drive.join("System Volume Information"),
            dirs.windows.clone(),
            dirs.windows.join("System32").join("drivers").join("etc").join("hosts"),
            dirs.home.clone(),
            dirs.home.parent().unwrap().to_path_buf(),
            dirs.home.join("Documents"),
            dirs.home.join("AppData"),
            dirs.local.clone(),
            dirs.program_data.clone(),
            dirs.program_files[0].clone(),
            sandbox.root.clone(), // holds the profile
        ];
        for path in &refused {
            assert!(refusal(path, dirs).is_some(), "{} should be refused", path.display());
        }

        let allowed = [
            dirs.home.join("Documents").join("old-report.docx"),
            dirs.home.join("Downloads").join("installer.exe"),
            dirs.local.join("SomeGame").join("cache"),
            dirs.program_files[0].join("Steam").join("steamapps").join("common").join("OldGame"),
            dirs.program_data.join("SomeApp"),
            drive.join("Games").join("big.pak"),
            drive.join("Games"),
        ];
        for path in &allowed {
            assert!(refusal(path, dirs).is_none(), "{} should be allowed", path.display());
        }
    }

    #[test]
    fn windows_and_program_data_are_system_managed() {
        let sandbox = Sandbox::new();
        let dirs = &sandbox.dirs;
        assert!(is_system_managed(&dirs.windows.join("Installer").join("a.msi"), dirs));
        assert!(is_system_managed(&PathBuf::from(dirs.program_data.to_string_lossy().to_uppercase()).join("NVIDIA").join("x.dll"), dirs));
        assert!(!is_system_managed(&dirs.home.join("Downloads").join("a.msi"), dirs));
        assert!(!is_system_managed(&dirs.program_files[0].join("Steam").join("game.pak"), dirs));
        let lookalike = PathBuf::from(format!("{}-old", dirs.windows.display())).join("a.msi");
        assert!(!is_system_managed(&lookalike, dirs), "a folder that merely starts with the same letters");
    }

    /// Puts one small file in the real Recycle Bin, so it only runs when asked for:
    /// `cargo test -- --ignored recycle`.
    #[test]
    #[ignore]
    fn recycle_moves_a_file_out_of_its_folder() {
        let sandbox = Sandbox::new();
        let file = sandbox.root.join("delpheye-recycle-test.txt");
        write(&file, 10);
        assert!(recycle(&file));
        assert!(!file.exists());
    }
}

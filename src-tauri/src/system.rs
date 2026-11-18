//! Facts about the machine and about the app's own privileges.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::AppHandle;

/// Where things live on this machine.
///
/// Everything the cleanup module reads or deletes is derived from these few roots,
/// which is what lets tests — and the debug-only sandbox — swap in a fake tree.
#[derive(Clone, Debug)]
pub struct Dirs {
    /// The user's profile, e.g. `C:\Users\name`.
    pub home: PathBuf,
    /// `AppData\Local`.
    pub local: PathBuf,
    /// `AppData\Roaming`.
    pub roaming: PathBuf,
    /// The user's temp folder.
    pub temp: PathBuf,
    /// `C:\Windows`.
    pub windows: PathBuf,
    /// `C:\ProgramData`.
    pub program_data: PathBuf,
    /// The `Program Files` folders. Never cleaned; listed so they can be protected.
    pub program_files: Vec<PathBuf>,
    /// Other personal places that must never be cleaned, such as OneDrive.
    pub personal: Vec<PathBuf>,
    /// The fake tree's root when these are not the real machine's folders.
    pub sandbox: Option<PathBuf>,
}

impl Dirs {
    /// The real folders, or `None` if the environment does not describe them properly.
    pub fn real() -> Option<Self> {
        let var = |key: &str| {
            std::env::var_os(key)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
        };
        let list = |keys: &[&str]| keys.iter().filter_map(|k| var(k)).collect::<Vec<_>>();
        Some(Self {
            home: var("USERPROFILE")?,
            local: var("LOCALAPPDATA")?,
            roaming: var("APPDATA")?,
            temp: std::env::temp_dir(),
            windows: var("SystemRoot")?,
            program_data: var("ProgramData")?,
            program_files: list(&["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]),
            personal: list(&["OneDrive", "OneDriveConsumer", "OneDriveCommercial", "PUBLIC"]),
            sandbox: None,
        })
    }

    /// A Windows-shaped layout rooted at `root`, for tests and the sandbox.
    pub fn under(root: &Path) -> Self {
        let home = root.join("Users").join("tester");
        let local = home.join("AppData").join("Local");
        Self {
            roaming: home.join("AppData").join("Roaming"),
            temp: local.join("Temp"),
            windows: root.join("Windows"),
            program_data: root.join("ProgramData"),
            program_files: vec![root.join("Program Files")],
            personal: Vec::new(),
            sandbox: Some(root.to_path_buf()),
            local,
            home,
        }
    }

    /// The folders the app should work with.
    ///
    /// Debug builds honour `DELPHEYE_FAKE_ROOT`, which points every cleanup location at a
    /// fake tree so the whole scan-and-delete flow can be exercised without touching real files.
    pub fn detect() -> Option<Self> {
        #[cfg(debug_assertions)]
        if let Some(root) = std::env::var_os("DELPHEYE_FAKE_ROOT").map(PathBuf::from) {
            if root.is_absolute() {
                return Some(Self::under(&root));
            }
        }
        Self::real()
    }
}

/// Whether the app may act as an administrator.
pub fn is_elevated() -> bool {
    // In the sandbox the answer is scripted, so both states of the UI can be tested.
    #[cfg(debug_assertions)]
    if std::env::var_os("DELPHEYE_FAKE_ROOT").is_some() {
        return std::env::var_os("DELPHEYE_FAKE_ELEVATED").is_some_and(|v| v == "1");
    }
    token_is_elevated()
}

fn token_is_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // SAFETY: the token handle is only used while open and is closed before returning;
    // `elevation` is a correctly sized, writable buffer for the class requested.
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let read = GetTokenInformation(
            token,
            TokenElevation,
            Some((&raw mut elevation).cast()),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );
        let _ = CloseHandle(token);
        read.is_ok() && elevation.TokenIsElevated != 0
    }
}

/// Lower-cased executable names of everything currently running.
pub fn running_processes() -> HashSet<String> {
    let Ok(mut sys) = System::new() else {
        return HashSet::new();
    };
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    sys.processes()
        .values()
        .map(|p| p.name().to_string_lossy().to_lowercase())
        .collect()
}

static MICA: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Mica exists from Windows 11 (build 22000) on.
pub fn supports_mica() -> bool {
    winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .and_then(|k| k.get_value::<String, _>("CurrentBuildNumber"))
        .ok()
        .and_then(|b| b.trim().parse::<u32>().ok())
        .is_some_and(|build| build >= 22000)
}

pub fn set_mica(on: bool) {
    MICA.store(on, std::sync::atomic::Ordering::Relaxed);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    elevated: bool,
    sandbox: bool,
    version: &'static str,
    /// The window has the Mica backdrop, so the interface may be see-through in places.
    mica: bool,
}

#[tauri::command]
pub fn app_status() -> AppStatus {
    AppStatus {
        elevated: is_elevated(),
        sandbox: Dirs::detect().is_some_and(|d| d.sandbox.is_some()),
        version: env!("CARGO_PKG_VERSION"),
        mica: MICA.load(std::sync::atomic::Ordering::Relaxed),
    }
}

/// Starts a second, elevated copy of the app and closes this one.
///
/// Fails with `"declined"` when the user dismisses the UAC prompt; this copy then keeps running.
#[tauri::command]
pub fn relaunch_elevated(app: AppHandle) -> Result<(), String> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{HSTRING, PCWSTR, w};

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = HSTRING::from(exe.as_os_str());
    // SAFETY: every string passed is a valid, NUL-terminated wide string that outlives the call.
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("runas"),
            &exe,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecute signals success with a value above 32.
    if result.0 as isize <= 32 {
        return Err("declined".into());
    }
    app.exit(0);
    Ok(())
}

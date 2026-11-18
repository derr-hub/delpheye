//! Running programs that pretend to be part of Windows, or run from places software is
//! downloaded to rather than installed to.

use std::path::Path;

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use super::finding::{Finding, Severity};
use super::patterns::{self, SYSTEM_NAMES};
use crate::startup::fileinfo;

pub struct Running {
    pub pid: u32,
    pub name: String,
    /// `None` when Windows hides it (system processes, without administrator rights).
    pub exe: Option<String>,
}

pub fn list() -> Vec<Running> {
    let Ok(mut sys) = System::new() else { return Vec::new() };
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_exe(UpdateKind::Always));
    sys.processes()
        .values()
        .map(|p| Running { pid: p.pid().as_u32(), name: p.name().to_string_lossy().into_owned(), exe: p.exe().map(|e| e.display().to_string()) })
        .collect()
}

/// Judges the running processes. `signed` tells whether a file carries a valid signature.
pub fn check(processes: &[Running], windows: &Path, signed: &dyn Fn(&str) -> Option<bool>) -> Vec<Finding> {
    let windows = windows.display().to_string().to_lowercase();
    let mut found = Vec::new();
    let mut seen_files = std::collections::HashSet::new();
    for p in processes {
        let name = p.name.to_lowercase();
        let exe_lower = p.exe.as_deref().map(str::to_lowercase);

        // A Windows name running from outside the Windows folder is an impostor.
        if SYSTEM_NAMES.contains(&name.as_str()) {
            if let Some(exe) = exe_lower.as_deref().filter(|e| !e.starts_with(&windows)) {
                found.push(Finding::new("process", "masquerade", Severity::High, p.name.clone(), exe.to_string(), exe.to_string()).reason("wrong-folder").file(p.exe.clone()).pid(p.pid));
            }
            continue;
        }
        if let Some(real) = patterns::lookalike(&name) {
            found.push(Finding::new("process", "masquerade", Severity::High, p.name.clone(), real, p.exe.clone().unwrap_or_default()).reason("lookalike").file(p.exe.clone()).pid(p.pid));
            continue;
        }

        let Some(exe) = exe_lower else { continue };
        if !seen_files.insert(exe.clone()) {
            continue;
        }
        let file_name = Path::new(&exe).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if patterns::double_extension(&file_name) {
            found.push(Finding::new("process", "double-extension", Severity::High, p.name.clone(), file_name, p.exe.clone().unwrap_or_default()).file(p.exe.clone()).pid(p.pid));
            continue;
        }
        if patterns::in_risky_folder(&exe) {
            // Installers unpack themselves to Temp and run from there; signed ones are routine.
            let severity = match signed(p.exe.as_deref().unwrap_or_default()) {
                Some(true) => Severity::Info,
                _ => Severity::Medium,
            };
            found.push(Finding::new("process", "odd-location", severity, p.name.clone(), p.exe.clone().unwrap_or_default(), p.exe.clone().unwrap_or_default()).file(p.exe.clone()).pid(p.pid));
        }
    }
    found
}

pub fn signature(path: &str) -> Option<bool> {
    fileinfo::inspect(Path::new(path), true).signed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running(pid: u32, name: &str, exe: Option<&str>) -> Running {
        Running { pid, name: name.into(), exe: exe.map(str::to_string) }
    }

    #[test]
    fn impostors_and_temp_programs_are_reported() {
        let windows = Path::new(r"C:\Windows");
        let processes = [
            running(1, "svchost.exe", Some(r"C:\Windows\System32\svchost.exe")),
            running(2, "svchost.exe", Some(r"C:\Users\me\AppData\Roaming\svchost.exe")),
            running(3, "svchost.exe", None),
            running(4, "scvhost.exe", Some(r"C:\Users\me\AppData\Local\scvhost.exe")),
            running(5, "setup.exe", Some(r"C:\Users\me\AppData\Local\Temp\is-123\setup.exe")),
            running(6, "unknown.exe", Some(r"C:\Users\me\Downloads\unknown.exe")),
            running(7, "steam.exe", Some(r"C:\Program Files (x86)\Steam\steam.exe")),
            running(8, "invoice.pdf.exe", Some(r"C:\Users\me\Documents\invoice.pdf.exe")),
        ];
        let signed = |path: &str| Some(path.ends_with("setup.exe"));
        let found = check(&processes, windows, &signed);
        let summary: Vec<(u32, &str, Option<&str>, Severity)> = found.iter().map(|f| (f.pid.unwrap(), f.kind, f.reason, f.severity)).collect();
        assert_eq!(
            summary,
            [
                (2, "masquerade", Some("wrong-folder"), Severity::High),
                (4, "masquerade", Some("lookalike"), Severity::High),
                (5, "odd-location", None, Severity::Info),
                (6, "odd-location", None, Severity::Medium),
                (8, "double-extension", None, Severity::High),
            ]
        );
    }
}

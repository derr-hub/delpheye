//! Protection: a local check for malware's hiding places, signs of tampering, and how well
//! Windows' own defences are set up — independent of whichever antivirus is installed.
//!
//! The check only reads. Every action on a finding (setting a file or registry key aside,
//! ending a process) is a separate, explicit step, and the first two can be undone from
//! quarantine.

mod backup;
mod certs;
mod exposure;
pub mod extensions;
pub mod finding;
mod hardening;
pub mod pwned;
mod patterns;
mod persistence;
mod processes;
mod reputation;
mod tamper;

use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::State;

use crate::journal::Journal;
use crate::leftovers::quarantine;
use crate::system::{self, Dirs};
use finding::Finding;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Runs the sensor helper's `--security` mode for the facts only WMI has.
fn helper_facts() -> hardening::Facts {
    let Some(helper) = crate::monitor::sidecar::helper_path() else { return hardening::Facts::default() };
    let output = Command::new(helper).arg("--security").creation_flags(CREATE_NO_WINDOW).output();
    output.ok().and_then(|o| serde_json::from_slice(&o.stdout).ok()).unwrap_or_default()
}

fn task_xml(windows: &Path) -> String {
    let output = Command::new(windows.join(r"System32\schtasks.exe")).args(["/query", "/xml", "ONE"]).creation_flags(CREATE_NO_WINDOW).output();
    output.map(|o| crate::startup::decode(&o.stdout)).unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    elevated: bool,
    duration_ms: u64,
    /// Places that could not be read without administrator rights.
    limited: Vec<&'static str>,
    findings: Vec<Finding>,
    hardening: hardening::Report,
    /// Browser extensions and what they may do.
    extensions: Vec<extensions::Extension>,
    /// Would the files survive ransomware?
    backup: hardening::Report,
    /// What the network can reach on this computer.
    exposure: exposure::Exposure,
}

fn scan(windows: &Path, elevated: bool) -> ScanReport {
    let started = Instant::now();
    // The slow parts run side by side.
    let ((facts, (xml, running)), (exts, exposure)) = rayon::join(
        || rayon::join(helper_facts, || rayon::join(|| task_xml(windows), processes::list)),
        || rayon::join(extensions::list, exposure::check),
    );

    let mut findings = Vec::new();
    findings.extend(persistence::ifeo());
    findings.extend(persistence::winlogon(windows));
    findings.extend(persistence::injected_dlls());
    findings.extend(persistence::lsa_packages());
    let subscriptions: Vec<(String, String, String)> = facts.wmi_subscriptions.items.iter().map(|s| (s.kind.clone(), s.name.clone(), s.detail.clone())).collect();
    findings.extend(persistence::wmi(&subscriptions));
    findings.extend(persistence::tasks(&persistence::task_commands(&xml)));
    findings.extend(persistence::run_commands());
    findings.extend(persistence::startup_scripts());
    findings.extend(persistence::browser_policies());
    findings.extend(processes::check(&running, windows, &processes::signature));
    let (hosts, hosts_path) = tamper::hosts_file(windows);
    findings.extend(tamper::hosts(&hosts, &hosts_path));
    findings.extend(tamper::proxy());
    findings.extend(tamper::dns());
    findings.extend(tamper::defender_exclusions());
    findings.extend(tamper::root_certificates(&certs::roots));

    findings.sort_by(|a, b| b.severity.cmp(&a.severity).then(a.area.cmp(b.area)).then(a.title.cmp(&b.title)));
    for (i, f) in findings.iter_mut().enumerate() {
        f.id = format!("f{i}");
    }

    let mut limited = Vec::new();
    if !facts.wmi_subscriptions.readable {
        limited.push("wmi");
    }
    if !elevated {
        limited.extend(["defender-exclusions", "system-processes", "encryption"]);
    }
    let today = quarantine::now();
    // Microsoft Defender is the active antivirus (not replaced by another one).
    let defender = facts.antivirus.items.iter().any(|p| p.enabled && (p.name.contains("Defender") || p.name.contains("Захисник")));
    ScanReport {
        elevated,
        limited,
        findings,
        hardening: hardening::run(&facts, &hardening::read_settings(), today),
        extensions: exts,
        backup: backup::run(defender),
        exposure,
        duration_ms: started.elapsed().as_millis() as u64,
    }
}

/// For the watcher: the hiding places that can be read quickly, as stable keys
/// ("kind|title|location") — a new key between two looks means something new settled in.
pub fn watch_keys() -> Vec<(String, Finding)> {
    let Some(dirs) = Dirs::real() else { return Vec::new() };
    let mut f = Vec::new();
    f.extend(persistence::ifeo());
    f.extend(persistence::winlogon(&dirs.windows));
    f.extend(persistence::injected_dlls());
    f.extend(persistence::lsa_packages());
    f.extend(persistence::run_commands());
    f.extend(persistence::startup_scripts());
    f.extend(persistence::browser_policies());
    f.extend(tamper::proxy());
    f.extend(tamper::dns());
    f.extend(tamper::defender_exclusions());
    f.extend(tamper::root_certificates(&certs::roots));
    f.into_iter().filter(|x| x.severity != finding::Severity::Info).map(|x| (format!("{}|{}|{}", x.kind, x.title, x.location), x)).collect()
}

#[derive(Default)]
pub struct SecurityState {
    /// The last scan's findings by id, so actions act on exactly what was shown.
    findings: Mutex<HashMap<String, Finding>>,
}

#[tauri::command]
pub async fn security_scan(state: State<'_, SecurityState>) -> Result<ScanReport, String> {
    let dirs = Dirs::real().ok_or("environment")?;
    let elevated = system::is_elevated();
    let report = tauri::async_runtime::spawn_blocking(move || scan(&dirs.windows, elevated)).await.map_err(|e| e.to_string())?;
    *state.findings.lock().unwrap() = report.findings.iter().map(|f| (f.id.clone(), f.clone())).collect();
    Ok(report)
}

/// Looks up files by hash online. Called only after the user turned this on.
#[tauri::command]
pub async fn security_reputation(paths: Vec<String>) -> Result<Vec<reputation::Reputation>, String> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().take(50).map(|p| reputation::lookup(Path::new(p))).collect())
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    done: bool,
    /// Why not, as a code.
    reason: Option<&'static str>,
}

fn result(outcome: Result<(), &'static str>) -> ActionResult {
    match outcome {
        Ok(()) => ActionResult { done: true, reason: None },
        Err(reason) => ActionResult { done: false, reason: Some(reason) },
    }
}

/// Acts on a finding: "quarantine-file", "quarantine-key" or "end-process".
#[tauri::command]
pub fn security_act(state: State<'_, SecurityState>, journal: State<'_, Journal>, id: String, action: String) -> ActionResult {
    let Some(finding) = state.findings.lock().unwrap().get(&id).cloned() else { return result(Err("stale")) };
    let Some(dirs) = Dirs::real() else { return result(Err("environment")) };
    let outcome = match action.as_str() {
        "quarantine-file" => quarantine_file(&finding, &dirs, &journal),
        "quarantine-key" => quarantine_key(&finding, &dirs, &journal),
        "end-process" => end_process(&finding),
        _ => Err("unknown-action"),
    };
    if outcome.is_ok() {
        let details = serde_json::json!({ "action": action, "kind": finding.kind, "title": finding.title, "items": [{ "path": finding.file.clone().or(finding.key.clone()).unwrap_or_default(), "bytes": 0 }] });
        let _ = journal.add("security", 0, 1, 0, &details);
    }
    result(outcome)
}

fn quarantine_file(finding: &Finding, dirs: &Dirs, journal: &Journal) -> Result<(), &'static str> {
    let path = PathBuf::from(finding.file.as_deref().ok_or("no-file")?);
    // Never set aside Windows' own files, whatever a finding says.
    if path.starts_with(&dirs.windows) || crate::disk::is_protected(&path, dirs) {
        return Err("protected");
    }
    let meta = std::fs::symlink_metadata(&path).map_err(|_| "gone")?;
    if !meta.is_file() {
        return Err("not-a-file");
    }
    let admin = !path.starts_with(&dirs.home);
    if admin && !system::is_elevated() {
        return Err("needs-admin");
    }
    quarantine::hold_folder(journal, &quarantine::store_root(dirs), &finding.title, &path, meta.len(), admin).map(|_| ())
}

fn quarantine_key(finding: &Finding, dirs: &Dirs, journal: &Journal) -> Result<(), &'static str> {
    let key = finding.key.as_deref().ok_or("no-key")?;
    let admin = key.starts_with("HKLM");
    if admin && !system::is_elevated() {
        return Err("needs-admin");
    }
    quarantine::hold_key(journal, dirs, &finding.title, key, admin).map(|_| ())
}

fn end_process(finding: &Finding) -> Result<(), &'static str> {
    let pid = finding.pid.ok_or("no-process")?;
    let mut sys = sysinfo::System::new().map_err(|_| "failed")?;
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]), true);
    let process = sys.process(sysinfo::Pid::from_u32(pid)).ok_or("gone")?;
    // The process must still be the one that was flagged, not a new one with a reused id.
    if !process.name().to_string_lossy().eq_ignore_ascii_case(&finding.title) {
        return Err("changed");
    }
    process.kill().then_some(()).ok_or("denied")
}

#[cfg(test)]
mod tests {
    use super::*;
    use finding::Severity;

    #[test]
    fn a_real_scan_completes_and_numbers_its_findings() {
        let dirs = Dirs::real().unwrap();
        let report = scan(&dirs.windows, system::is_elevated());
        for (i, f) in report.findings.iter().enumerate() {
            assert_eq!(f.id, format!("f{i}"));
        }
        assert!(report.findings.windows(2).all(|w| w[0].severity >= w[1].severity), "most severe first");
        assert!(report.hardening.tests.len() >= 10);
        println!("findings: {:#?}\nscore {}", report.findings.iter().map(|f| (f.kind, f.reason, f.severity, &f.title)).collect::<Vec<_>>(), report.hardening.score);
    }

    #[test]
    fn severities_order_from_info_to_high() {
        assert!(Severity::High > Severity::Medium && Severity::Medium > Severity::Low && Severity::Low > Severity::Info);
    }
}

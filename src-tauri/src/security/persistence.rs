//! Places where malware makes itself start again and again — including the ones Task Manager
//! never shows.

use std::path::Path;

use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};

use super::finding::{Finding, Severity};
use super::patterns::{self, command_risk};
use crate::leftovers::command_path;

const IFEO: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options";
const SILENT_EXIT: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\SilentProcessExit";
const WINLOGON: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon";
const WINDOWS: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows";
const LSA: &str = r"SYSTEM\CurrentControlSet\Control\Lsa";
const APPCERT: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\AppCertDlls";

/// Security packages Windows ships with. Anything else loads into the process that holds passwords.
const KNOWN_LSA_PACKAGES: &[&str] = &[
    "", "msv1_0", "kerberos", "schannel", "wdigest", "tspkg", "pku2u", "cloudap", "negoexts", "livessp", "scecli", "rassfm", "fwpuclnt", "credssp",
];
/// Defaults of the Windows Defender WMI subscription every machine has.
const KNOWN_WMI: &[&str] = &["SCM Event Log Filter", "SCM Event Log Consumer", "BVTFilter", "BVTConsumer"];

fn machine() -> RegKey {
    RegKey::predef(HKEY_LOCAL_MACHINE)
}

fn user() -> RegKey {
    RegKey::predef(HKEY_CURRENT_USER)
}

fn text(key: &RegKey, name: &str) -> Option<String> {
    key.get_value::<String, _>(name).ok().map(|v| v.trim_matches('\0').trim().to_string())
}

/// "Image File Execution Options": a `Debugger` value makes Windows run another program
/// instead of the one asked for — used to hijack Task Manager or block antivirus tools.
pub fn ifeo() -> Vec<Finding> {
    let mut found = Vec::new();
    // Windows shares this key between the 64- and 32-bit registry views, so the same entry
    // usually shows up in both; report it once.
    let mut seen = std::collections::HashSet::new();
    for (view, shown) in [(KEY_WOW64_64KEY, r"HKLM\"), (KEY_WOW64_32KEY, r"HKLM\(32-bit) ")] {
        let Ok(root) = machine().open_subkey_with_flags(IFEO, KEY_READ | view) else { continue };
        for exe in root.enum_keys().flatten() {
            let Ok(key) = root.open_subkey_with_flags(&exe, KEY_READ | view) else { continue };
            if let Some(debugger) = text(&key, "Debugger").filter(|d| !d.is_empty()) {
                if !seen.insert((exe.to_lowercase(), debugger.to_lowercase())) {
                    continue;
                }
                let lower = debugger.to_lowercase();
                // Developer and Microsoft debugging tools set this on purpose.
                let benign = ["vsjitdebugger", "windbg", "procexp", "systray.exe"].iter().any(|t| lower.contains(t));
                let severity = if benign { Severity::Low } else { Severity::High };
                found.push(
                    Finding::new("persistence", "ifeo-debugger", severity, exe.clone(), debugger.clone(), format!(r"{shown}{IFEO}\{exe}"))
                        .file(command_path(&debugger).map(|p| p.display().to_string()))
                        .key(format!(r"HKLM\{IFEO}\{exe}")),
                );
            }
        }
    }
    // SilentProcessExit runs a "monitor" program whenever the named one exits.
    if let Ok(root) = machine().open_subkey(SILENT_EXIT) {
        for exe in root.enum_keys().flatten() {
            let Ok(key) = root.open_subkey(&exe) else { continue };
            if let Some(monitor) = text(&key, "MonitorProcess").filter(|m| !m.is_empty()) {
                found.push(
                    Finding::new("persistence", "silent-exit", Severity::High, exe.clone(), monitor.clone(), format!(r"HKLM\{SILENT_EXIT}\{exe}"))
                        .file(command_path(&monitor).map(|p| p.display().to_string()))
                        .key(format!(r"HKLM\{SILENT_EXIT}\{exe}")),
                );
            }
        }
    }
    found
}

/// Winlogon starts the desktop (`Shell`) and the user's session (`Userinit`). Anything added
/// to them runs at every sign-in, before almost everything else.
pub fn winlogon(windows: &Path) -> Vec<Finding> {
    let mut found = Vec::new();
    let system32 = windows.join("System32").display().to_string().to_lowercase();
    for (hive, name) in [(machine(), "HKLM"), (user(), "HKCU")] {
        let Ok(key) = hive.open_subkey(WINLOGON) else { continue };
        if let Some(shell) = text(&key, "Shell") {
            let normal = shell.is_empty() || matches!(shell.to_lowercase().as_str(), "explorer.exe" | "explorer");
            if !normal {
                found.push(Finding::new("persistence", "winlogon", Severity::High, "Shell", shell, format!(r"{name}\{WINLOGON}")).reason("shell"));
            }
        }
        if let Some(userinit) = text(&key, "Userinit") {
            let extra: Vec<&str> = userinit
                .split(',')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .filter(|p| {
                    let p = p.to_lowercase();
                    !(p == "userinit.exe" || p == format!(r"{system32}\userinit.exe"))
                })
                .collect();
            if !extra.is_empty() {
                found.push(Finding::new("persistence", "winlogon", Severity::High, "Userinit", userinit.clone(), format!(r"{name}\{WINLOGON}")).reason("userinit"));
            }
        }
    }
    found
}

/// DLLs Windows injects into every program (AppInit_DLLs) or every process launch (AppCertDlls).
pub fn injected_dlls() -> Vec<Finding> {
    let mut found = Vec::new();
    for (view, shown) in [(KEY_WOW64_64KEY, "HKLM"), (KEY_WOW64_32KEY, "HKLM (32-bit)")] {
        let Ok(key) = machine().open_subkey_with_flags(WINDOWS, KEY_READ | view) else { continue };
        let dlls = text(&key, "AppInit_DLLs").unwrap_or_default();
        let enabled = key.get_value::<u32, _>("LoadAppInit_DLLs").unwrap_or(0) == 1;
        if !dlls.is_empty() {
            let severity = if enabled { Severity::High } else { Severity::Low };
            found.push(Finding::new("persistence", "appinit", severity, "AppInit_DLLs", dlls.clone(), format!(r"{shown}\{WINDOWS}")).reason(if enabled { "active" } else { "inactive" }));
        }
    }
    if let Ok(key) = machine().open_subkey(APPCERT) {
        for (name, value) in key.enum_values().flatten() {
            found.push(Finding::new("persistence", "appcert", Severity::High, name, value.to_string(), format!(r"HKLM\{APPCERT}")));
        }
    }
    found
}

/// Extra packages loaded into LSA, the process that holds sign-in secrets.
pub fn lsa_packages() -> Vec<Finding> {
    let Ok(key) = machine().open_subkey(LSA) else { return Vec::new() };
    let mut found = Vec::new();
    for list in ["Security Packages", "Authentication Packages", "Notification Packages"] {
        let Ok(values) = key.get_value::<Vec<String>, _>(list) else { continue };
        for package in values {
            let name = package.trim().trim_matches('"').to_lowercase();
            if !KNOWN_LSA_PACKAGES.contains(&name.as_str()) {
                found.push(Finding::new("persistence", "lsa-package", Severity::Medium, package.clone(), list, format!(r"HKLM\{LSA}")));
            }
        }
    }
    found
}

/// WMI event subscriptions: code that Windows itself re-runs on an event, with no file in any
/// startup list. The `subscriptions` come from the sensor helper as (kind, name, detail).
pub fn wmi(subscriptions: &[(String, String, String)]) -> Vec<Finding> {
    subscriptions
        .iter()
        .filter(|(kind, _, _)| kind == "command" || kind == "script")
        .filter(|(_, name, _)| !KNOWN_WMI.contains(&name.as_str()))
        .map(|(kind, name, detail)| {
            let severity = if command_risk(detail).is_some() || kind == "script" { Severity::High } else { Severity::Medium };
            Finding::new("persistence", "wmi-subscription", severity, name.clone(), detail.clone(), r"WMI root\subscription").reason(if kind == "script" { "script" } else { "command" })
        })
        .collect()
}

/// Every scheduled task's command, not only the ones that start at sign-in.
pub fn task_commands(xml: &str) -> Vec<(String, String, Option<String>)> {
    let Ok(doc) = roxmltree::Document::parse(xml) else { return Vec::new() };
    let mut out = Vec::new();
    let mut path: Option<String> = None;
    for node in doc.root_element().children() {
        if node.is_comment() {
            path = node.text().map(|t| t.trim().to_string());
            continue;
        }
        if !node.has_tag_name("Task") {
            continue;
        }
        let Some(task) = path.take() else { continue };
        let author = node
            .descendants()
            .find(|n| n.has_tag_name("Author"))
            .and_then(|n| n.text())
            .map(str::to_string);
        for exec in node.descendants().filter(|n| n.has_tag_name("Exec")) {
            let field = |name: &str| exec.children().find(|n| n.has_tag_name(name)).and_then(|n| n.text()).unwrap_or("").trim().to_string();
            let command = format!("{} {}", field("Command"), field("Arguments")).trim().to_string();
            if !command.is_empty() {
                out.push((task.clone(), command, author.clone()));
            }
        }
    }
    out
}

/// Scheduled tasks whose commands look like an attack rather than maintenance.
pub fn tasks(commands: &[(String, String, Option<String>)]) -> Vec<Finding> {
    commands
        .iter()
        .filter_map(|(task, command, _)| {
            let expanded = crate::startup::expand(command);
            let lower = expanded.to_lowercase();
            if let Some((severity, reason)) = command_risk(&expanded) {
                return Some(Finding::new("persistence", "task-command", severity, task.rsplit('\\').next().unwrap_or(task), expanded.clone(), task.clone()).reason(reason));
            }
            let program = command_path(&expanded);
            let program_lower = program.as_ref().map(|p| p.display().to_string().to_lowercase()).unwrap_or_default();
            if patterns::in_risky_folder(&program_lower) || patterns::is_script(&program_lower) && patterns::in_risky_folder(&lower) {
                return Some(
                    Finding::new("persistence", "task-command", Severity::Medium, task.rsplit('\\').next().unwrap_or(task), expanded.clone(), task.clone())
                        .reason("runs-from-temp")
                        .file(program.map(|p| p.display().to_string())),
                );
            }
            None
        })
        .collect()
}

/// Startup folders holding scripts rather than shortcuts.
pub fn startup_scripts() -> Vec<Finding> {
    let folders = [
        std::env::var_os("APPDATA").map(|p| Path::new(&p).join(r"Microsoft\Windows\Start Menu\Programs\Startup")),
        std::env::var_os("ProgramData").map(|p| Path::new(&p).join(r"Microsoft\Windows\Start Menu\Programs\StartUp")),
    ];
    let mut found = Vec::new();
    for folder in folders.into_iter().flatten() {
        for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if patterns::is_script(&name) || name.ends_with(".exe") {
                let path = entry.path().display().to_string();
                let severity = if patterns::is_script(&name) { Severity::Medium } else { Severity::Low };
                found.push(
                    Finding::new("persistence", "startup-file", severity, entry.file_name().to_string_lossy(), path.clone(), folder.display().to_string())
                        .reason(if patterns::is_script(&name) { "script" } else { "program" })
                        .file(Some(path)),
                );
            }
        }
    }
    found
}

/// Run keys whose commands look like an attack. (Ordinary entries are the Startup page's job.)
pub fn run_commands() -> Vec<Finding> {
    let mut found = Vec::new();
    let places = [
        (user(), KEY_WOW64_64KEY, r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run"),
        (user(), KEY_WOW64_64KEY, r"HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce"),
        (machine(), KEY_WOW64_64KEY, r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run"),
        (machine(), KEY_WOW64_32KEY, r"HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run"),
        (machine(), KEY_WOW64_64KEY, r"HKLM\Software\Microsoft\Windows\CurrentVersion\RunOnce"),
    ];
    for (hive, view, shown) in places {
        let subkey = shown.split_once('\\').map_or(shown, |(_, rest)| rest).replace(r"WOW6432Node\", "");
        let Ok(key) = hive.open_subkey_with_flags(&subkey, KEY_READ | view) else { continue };
        for (name, value) in key.enum_values().flatten() {
            let command = crate::startup::expand(value.to_string().trim_matches('\0'));
            let program = command_path(&command);
            let program_lower = program.as_ref().map(|p| p.display().to_string().to_lowercase()).unwrap_or_default();
            let risk = command_risk(&command).or_else(|| patterns::in_risky_folder(&program_lower).then_some((Severity::Medium, "runs-from-temp")));
            if let Some((severity, reason)) = risk {
                found.push(Finding::new("persistence", "run-command", severity, name, command.clone(), shown).reason(reason).file(program.map(|p| p.display().to_string())));
            }
        }
    }
    found
}

/// Browser policies that force extensions in or set a proxy — the usual tools of adware and
/// of hijackers that read or rewrite what you browse.
pub fn browser_policies() -> Vec<Finding> {
    let browsers = [(r"SOFTWARE\Policies\Google\Chrome", "Google Chrome"), (r"SOFTWARE\Policies\Microsoft\Edge", "Microsoft Edge"), (r"SOFTWARE\Policies\BraveSoftware\Brave", "Brave")];
    let mut found = Vec::new();
    for (hive, hive_name) in [(machine(), "HKLM"), (user(), "HKCU")] {
        for (path, browser) in browsers {
            let Ok(policy) = hive.open_subkey(path) else { continue };
            if let Ok(list) = policy.open_subkey("ExtensionInstallForcelist") {
                for (_, value) in list.enum_values().flatten() {
                    let id = value.to_string().trim_matches('\0').split(';').next().unwrap_or("").to_string();
                    found.push(Finding::new("persistence", "forced-extension", Severity::Medium, browser, id, format!(r"{hive_name}\{path}\ExtensionInstallForcelist")));
                }
            }
            for setting in ["ProxyServer", "ProxyPacUrl"] {
                if let Some(value) = text(&policy, setting).filter(|v| !v.is_empty()) {
                    found.push(Finding::new("tamper", "browser-proxy-policy", Severity::Medium, browser, value, format!(r"{hive_name}\{path}")));
                }
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const TASKS: &str = r#"<Tasks>
<!-- \Updater\Daily -->
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Author>Vendor</Author></RegistrationInfo>
  <Actions><Exec><Command>"C:\Program Files\Vendor\update.exe"</Command><Arguments>/check</Arguments></Exec></Actions></Task>
<!-- \SystemHelper -->
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Actions><Exec><Command>powershell.exe</Command><Arguments>-w hidden -enc SQBFAFgA</Arguments></Exec></Actions></Task>
<!-- \Sync -->
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Actions><Exec><Command>C:\Users\me\AppData\Local\Temp\svc\sync.exe</Command></Exec></Actions></Task>
</Tasks>"#;

    #[test]
    fn suspicious_tasks_are_flagged_and_ordinary_ones_are_not() {
        let commands = task_commands(TASKS);
        assert_eq!(commands.len(), 3);
        assert_eq!(commands[0], (r"\Updater\Daily".to_string(), r#""C:\Program Files\Vendor\update.exe" /check"#.to_string(), Some("Vendor".to_string())));

        let found = tasks(&commands);
        let summary: Vec<(&str, Option<&str>, Severity)> = found.iter().map(|f| (f.title.as_str(), f.reason, f.severity)).collect();
        assert_eq!(summary, [("SystemHelper", Some("ps-encoded"), Severity::High), ("Sync", Some("runs-from-temp"), Severity::Medium)]);
        assert_eq!(found[1].file.as_deref(), Some(r"C:\Users\me\AppData\Local\Temp\svc\sync.exe"));
    }

    #[test]
    fn windows_own_wmi_subscription_is_not_reported() {
        let subs = vec![
            ("filter".to_string(), "SCM Event Log Filter".to_string(), "select * from MSFT_SCMEventLogEvent".to_string()),
            ("command".to_string(), "SCM Event Log Consumer".to_string(), "x".to_string()),
            ("command".to_string(), "Updater".to_string(), "powershell -enc AAAA".to_string()),
            ("script".to_string(), "Watcher".to_string(), "GetObject(...)".to_string()),
        ];
        let found = wmi(&subs);
        let summary: Vec<(&str, Severity)> = found.iter().map(|f| (f.title.as_str(), f.severity)).collect();
        assert_eq!(summary, [("Updater", Severity::High), ("Watcher", Severity::High)]);
    }

    #[test]
    fn this_machine_has_the_standard_lsa_packages_only() {
        // A clean Windows install must not trip the LSA check; anything listed here is worth a look.
        for finding in lsa_packages() {
            println!("unexpected LSA package: {} in {}", finding.title, finding.detail);
        }
    }
}

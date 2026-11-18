//! Every place Windows starts programs from automatically.
//!
//! * `Run` keys in the registry, for this user and for the whole machine;
//! * the Startup folders;
//! * scheduled tasks that fire at log-on or at boot;
//! * services that start with Windows.
//!
//! Programs are switched off the same way Task Manager does it (the `StartupApproved`
//! keys), so Task Manager and DelphEye always agree, and nothing is ever deleted to disable it.

use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use windows::Win32::System::Services::{
    CloseServiceHandle, ENUM_SERVICE_STATUS_PROCESSW, EnumServicesStatusExW, OpenSCManagerW, SC_ENUM_PROCESS_INFO,
    SC_MANAGER_ENUMERATE_SERVICE, SERVICE_RUNNING, SERVICE_STATE_ALL, SERVICE_WIN32,
};
use windows::core::PCWSTR;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, KEY_WOW64_32KEY, KEY_WOW64_64KEY, REG_BINARY};
use winreg::{RegKey, RegValue};

use super::fileinfo;
use crate::leftovers::command_path;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved";

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Run,
    Folder,
    Task,
    Service,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum StartType {
    Auto,
    Delayed,
    Manual,
    Disabled,
}

impl StartType {
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "auto" => Self::Auto,
            "delayed" => Self::Delayed,
            "manual" => Self::Manual,
            "disabled" => Self::Disabled,
            _ => return None,
        })
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Delayed => "delayed",
            Self::Manual => "manual",
            Self::Disabled => "disabled",
        }
    }

    fn sc_word(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Delayed => "delayed-auto",
            Self::Manual => "demand",
            Self::Disabled => "disabled",
        }
    }
}

/// Where a program's on/off switch lives.
#[derive(Clone, Debug)]
pub enum Switch {
    /// A value in one of the `StartupApproved` keys.
    Approved { machine: bool, list: &'static str, value: String },
    /// A scheduled task, by its full path.
    Task { path: String },
    /// A service, by its key name.
    Service { name: String },
}

#[derive(Clone, Debug)]
pub struct Raw {
    pub kind: Kind,
    pub name: String,
    pub command: String,
    pub program: Option<PathBuf>,
    pub location: String,
    pub machine: bool,
    pub enabled: bool,
    pub switch: Switch,
    pub description: Option<String>,
    /// For a `Run` value: where it is and what it held, so a dead one can be removed and put back.
    pub run_value: Option<(bool, bool, String, String)>,
    pub service: Option<ServiceState>,
    pub task_author: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ServiceState {
    pub name: String,
    pub start: StartType,
    pub running: bool,
    pub pid: u32,
    pub shared: bool,
}

fn hive(machine: bool) -> RegKey {
    RegKey::predef(if machine { HKEY_LOCAL_MACHINE } else { HKEY_CURRENT_USER })
}

/// Whether Task Manager's switch for this value says "on". No switch means on.
fn approved(machine: bool, list: &str, value: &str) -> bool {
    let key = hive(machine).open_subkey_with_flags(format!(r"{APPROVED}\{list}"), KEY_READ | KEY_WOW64_64KEY);
    match key.and_then(|k| k.get_raw_value(value)) {
        // The first byte is odd when the entry is switched off.
        Ok(raw) => raw.bytes.first().is_none_or(|b| b & 1 == 0),
        Err(_) => true,
    }
}

/// Flips Task Manager's switch for one value.
pub fn set_approved(machine: bool, list: &str, value: &str, on: bool) -> std::io::Result<()> {
    let (key, _) = hive(machine).create_subkey_with_flags(format!(r"{APPROVED}\{list}"), KEY_SET_VALUE | KEY_WOW64_64KEY)?;
    let mut bytes = vec![0u8; 12];
    if on {
        bytes[0] = 2;
    } else {
        bytes[0] = 3;
        // Task Manager records when the entry was switched off.
        let filetime = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| (d.as_secs() + 11_644_473_600) * 10_000_000);
        bytes[4..12].copy_from_slice(&filetime.to_le_bytes());
    }
    key.set_raw_value(value, &RegValue { bytes: bytes.into(), vtype: REG_BINARY })
}

fn run_keys(found: &mut Vec<Raw>) {
    let places = [(false, KEY_WOW64_64KEY, "Run", r"HKCU"), (true, KEY_WOW64_64KEY, "Run", r"HKLM"), (true, KEY_WOW64_32KEY, "Run32", r"HKLM (32-bit)")];
    for (machine, view, list, shown) in places {
        let Ok(key) = hive(machine).open_subkey_with_flags(RUN, KEY_READ | view) else { continue };
        for (value, data) in key.enum_values().flatten() {
            let command = data.to_string();
            let command = command.trim_matches('\0').trim().to_string();
            found.push(Raw {
                kind: Kind::Run,
                enabled: approved(machine, list, &value),
                program: command_path(&expand(&command)).map(|p| squirrel_app(&p, &command)),
                location: format!(r"{shown}\{RUN}"),
                machine,
                switch: Switch::Approved { machine, list, value: value.clone() },
                description: None,
                run_value: Some((machine, view == KEY_WOW64_32KEY, value.clone(), command.clone())),
                service: None,
                task_author: None,
                name: value,
                command,
            });
        }
    }
}

/// Apps installed with Squirrel (Discord and others) start through a shared `Update.exe`
/// with `--processStart App.exe`; the program that matters is that app, in its newest
/// `app-<version>` folder.
fn squirrel_app(program: &Path, command: &str) -> PathBuf {
    let is_updater = program.file_name().is_some_and(|n| n.eq_ignore_ascii_case("update.exe"));
    let target = command.split_once("--processStart").map(|(_, rest)| rest.trim().trim_matches('"'));
    let (true, Some(target), Some(folder)) = (is_updater, target, program.parent()) else {
        return program.to_path_buf();
    };
    let target = target.split_whitespace().next().unwrap_or(target).trim_matches('"');
    let mut versions: Vec<PathBuf> = std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("app-"))
        .map(|e| e.path().join(target))
        .filter(|p| p.is_file())
        .collect();
    versions.sort();
    versions.pop().unwrap_or_else(|| program.to_path_buf())
}

fn startup_folders(found: &mut Vec<Raw>) {
    let user = std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs\Startup"));
    let common = std::env::var_os("ProgramData").map(|p| PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs\StartUp"));
    for (folder, machine) in [(user, false), (common, true)] {
        let Some(folder) = folder else { continue };
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            if file.eq_ignore_ascii_case("desktop.ini") || entry.path().is_dir() {
                continue;
            }
            let path = entry.path();
            let (program, command) = if file.to_lowercase().ends_with(".lnk") {
                match fileinfo::shortcut_target(&path) {
                    Some((target, args)) => {
                        let command = format!("\"{}\" {}", target.display(), args).trim().to_string();
                        (Some(target), command)
                    }
                    None => (None, path.display().to_string()),
                }
            } else {
                (Some(path.clone()), path.display().to_string())
            };
            let name = file.rsplit_once('.').map_or(file.as_str(), |(stem, _)| stem).to_string();
            found.push(Raw {
                kind: Kind::Folder,
                enabled: approved(machine, "StartupFolder", &file),
                name,
                command,
                program,
                location: folder.display().to_string(),
                machine,
                switch: Switch::Approved { machine, list: "StartupFolder", value: file },
                description: None,
                run_value: None,
                service: None,
                task_author: None,
            });
        }
    }
}

/// Replaces `%NAME%` with the value of that environment variable.
pub fn expand(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(value) if !name.is_empty() => out.push_str(&value),
                    _ => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// A scheduled task, as far as autostart goes.
#[derive(Debug, PartialEq)]
pub struct TaskInfo {
    pub path: String,
    pub enabled: bool,
    pub command: String,
    pub arguments: String,
    pub author: Option<String>,
    pub description: Option<String>,
}

/// Tasks that start at log-on or at boot, from the XML `schtasks /query /xml ONE` prints.
pub fn parse_tasks(xml: &str) -> Vec<TaskInfo> {
    let Ok(doc) = roxmltree::Document::parse(xml) else { return Vec::new() };
    let mut tasks = Vec::new();
    let mut path: Option<String> = None;
    for node in doc.root_element().children() {
        if node.is_comment() {
            path = node.text().map(|t| t.trim().to_string());
            continue;
        }
        if !node.has_tag_name("Task") {
            continue;
        }
        let Some(task_path) = path.take() else { continue };
        let text = |parent: Option<roxmltree::Node>, name: &str| {
            parent.and_then(|p| child(p, name)).and_then(|n| n.text()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
        };
        let on = |node: roxmltree::Node| text(Some(node), "Enabled").is_none_or(|v| v != "false");

        let starts_with_windows = child(node, "Triggers").is_some_and(|triggers| {
            triggers.children().any(|t| (t.has_tag_name("LogonTrigger") || t.has_tag_name("BootTrigger")) && on(t))
        });
        let exec = child(node, "Actions").and_then(|actions| child(actions, "Exec"));
        let (Some(exec), true) = (exec, starts_with_windows) else { continue };
        let Some(command) = text(Some(exec), "Command") else { continue };
        let info = child(node, "RegistrationInfo");
        tasks.push(TaskInfo {
            enabled: child(node, "Settings").is_none_or(on),
            command: command.trim_matches('"').to_string(),
            arguments: text(Some(exec), "Arguments").unwrap_or_default(),
            author: text(info, "Author"),
            description: text(info, "Description"),
            path: task_path,
        });
    }
    tasks
}

fn child<'a, 'input>(parent: roxmltree::Node<'a, 'input>, name: &str) -> Option<roxmltree::Node<'a, 'input>> {
    parent.children().find(|n| n.has_tag_name(name))
}

/// `schtasks` prints UTF-16 when its output is not a console; accept either.
pub fn decode(bytes: &[u8]) -> String {
    let looks_utf16 = bytes.len() >= 2 && (bytes.starts_with(&[0xFF, 0xFE]) || bytes[1] == 0);
    if looks_utf16 {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
        String::from_utf16_lossy(&units).trim_start_matches('\u{feff}').to_string()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn tasks(found: &mut Vec<Raw>, windows: &Path) {
    let output = Command::new(windows.join("System32").join("schtasks.exe"))
        .args(["/query", "/xml", "ONE"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let Ok(output) = output else { return };
    for task in parse_tasks(&decode(&output.stdout)) {
        let program = command_path(&expand(&task.command)).or_else(|| {
            // A bare program name, e.g. `rundll32.exe`, is looked up in System32.
            (!task.command.contains('\\')).then(|| windows.join("System32").join(&task.command))
        });
        let name = task.path.rsplit('\\').next().unwrap_or(&task.path).to_string();
        found.push(Raw {
            kind: Kind::Task,
            enabled: task.enabled,
            name,
            command: format!("\"{}\" {}", expand(&task.command), task.arguments).trim().to_string(),
            program,
            location: task.path.clone(),
            machine: true,
            switch: Switch::Task { path: task.path.clone() },
            description: task.description,
            run_value: None,
            service: None,
            task_author: task.author,
        });
    }
}

/// Running state, process and display name of every service, from the service manager.
pub(crate) fn service_states() -> HashMap<String, (bool, u32, String)> {
    let mut states = HashMap::new();
    // SAFETY: the buffer is sized by the first call and only read within the count the second
    // call reports; every string pointer it holds points inside the same buffer.
    unsafe {
        let Ok(manager) = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_ENUMERATE_SERVICE) else { return states };
        let (mut needed, mut count, mut resume) = (0u32, 0u32, 0u32);
        let _ = EnumServicesStatusExW(manager, SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_STATE_ALL, None, &mut needed, &mut count, Some(&mut resume), PCWSTR::null());
        let mut buffer = vec![0u8; needed as usize + 4096];
        resume = 0;
        if EnumServicesStatusExW(manager, SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_STATE_ALL, Some(&mut buffer), &mut needed, &mut count, Some(&mut resume), PCWSTR::null()).is_ok() {
            let items = std::slice::from_raw_parts(buffer.as_ptr() as *const ENUM_SERVICE_STATUS_PROCESSW, count as usize);
            for item in items {
                let name = item.lpServiceName.to_string().unwrap_or_default();
                let display = item.lpDisplayName.to_string().unwrap_or_default();
                let status = item.ServiceStatusProcess;
                states.insert(name.to_lowercase(), (status.dwCurrentState == SERVICE_RUNNING, status.dwProcessId, display));
            }
        }
        let _ = CloseServiceHandle(manager);
    }
    states
}

fn services(found: &mut Vec<Raw>) {
    let Ok(all) = hive(true).open_subkey(r"SYSTEM\CurrentControlSet\Services") else { return };
    let states = service_states();
    for name in all.enum_keys().flatten() {
        let Ok(key) = all.open_subkey(&name) else { continue };
        let kind: u32 = key.get_value("Type").unwrap_or(0);
        // Programs only (own or shared process); drivers and per-user templates are not autostart apps.
        if kind & 0x30 == 0 || kind & 0x40 != 0 {
            continue;
        }
        let start = match key.get_value::<u32, _>("Start").unwrap_or(3) {
            2 if key.get_value::<u32, _>("DelayedAutostart").unwrap_or(0) == 1 => StartType::Delayed,
            2 => StartType::Auto,
            4 => StartType::Disabled,
            _ => StartType::Manual,
        };
        let image: String = key.get_value("ImagePath").unwrap_or_default();
        let shared = image.to_lowercase().contains("svchost.exe");
        // A service hosted by svchost is really the DLL it loads.
        let dll = || {
            let in_parameters = key.open_subkey("Parameters").ok().and_then(|p| p.get_value::<String, _>("ServiceDll").ok());
            in_parameters.or_else(|| key.get_value::<String, _>("ServiceDll").ok())
        };
        // A service hosted by svchost is really the DLL it loads; without one, it is svchost itself.
        let program = if shared {
            dll().and_then(|dll| command_path(&expand(&dll))).or_else(|| command_path(&expand(&image)))
        } else {
            command_path(&expand(&image))
        };
        let (running, pid, display) = states.get(&name.to_lowercase()).cloned().unwrap_or((false, 0, name.clone()));
        let description: String = key.get_value("Description").unwrap_or_default();
        found.push(Raw {
            kind: Kind::Service,
            enabled: matches!(start, StartType::Auto | StartType::Delayed),
            name: if display.is_empty() { name.clone() } else { display },
            command: expand(&image),
            program,
            location: format!(r"HKLM\SYSTEM\CurrentControlSet\Services\{name}"),
            machine: true,
            switch: Switch::Service { name: name.clone() },
            description: resolve_text(&description),
            run_value: None,
            service: Some(ServiceState { name, start, running, pid, shared }),
            task_author: None,
        });
    }
}

/// Turns `@%SystemRoot%\system32\foo.dll,-101` style references into the text they point to.
fn resolve_text(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    if !text.starts_with('@') {
        return Some(text.to_string());
    }
    let mut buffer = [0u16; 1024];
    let source = windows::core::HSTRING::from(text);
    // SAFETY: `buffer` is writable and its length is passed along with it.
    let resolved = unsafe { windows::Win32::UI::Shell::SHLoadIndirectString(&source, &mut buffer, None) };
    resolved.ok()?;
    let text = String::from_utf16_lossy(buffer.split(|&u| u == 0).next().unwrap_or(&[]));
    (!text.is_empty()).then_some(text)
}

pub fn collect(windows: &Path) -> Vec<Raw> {
    let mut found = Vec::new();
    run_keys(&mut found);
    startup_folders(&mut found);
    tasks(&mut found, windows);
    services(&mut found);
    found
}

fn run_tool(program: &Path, args: &[&str]) -> bool {
    Command::new(program).args(args).creation_flags(CREATE_NO_WINDOW).output().is_ok_and(|o| o.status.success())
}

pub fn set_task(windows: &Path, path: &str, on: bool) -> bool {
    run_tool(&windows.join("System32").join("schtasks.exe"), &["/change", "/tn", path, if on { "/enable" } else { "/disable" }])
}

pub fn set_service(windows: &Path, name: &str, start: StartType) -> bool {
    run_tool(&windows.join("System32").join("sc.exe"), &["config", name, "start=", start.sc_word()])
}

/// Removes a `Run` value. Returns false if Windows refused.
pub fn remove_run_value(machine: bool, wow32: bool, value: &str) -> bool {
    let view = if wow32 { KEY_WOW64_32KEY } else { KEY_WOW64_64KEY };
    hive(machine)
        .open_subkey_with_flags(RUN, KEY_SET_VALUE | view)
        .and_then(|key| key.delete_value(value))
        .is_ok()
}

/// Puts a removed `Run` value back.
pub fn restore_run_value(machine: bool, wow32: bool, value: &str, command: &str) -> bool {
    let view = if wow32 { KEY_WOW64_32KEY } else { KEY_WOW64_64KEY };
    hive(machine)
        .create_subkey_with_flags(RUN, KEY_SET_VALUE | view)
        .and_then(|(key, _)| key.set_value(value, &command.to_string()))
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logon_and_boot_tasks_are_picked_from_the_xml() {
        let xml = r#"<Tasks>
<!-- \Vendor\Updater -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>Vendor Inc.</Author><Description>Keeps it fresh</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Settings><Enabled>true</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>"%ProgramFiles%\Vendor\up.exe"</Command><Arguments>/silent</Arguments></Exec></Actions>
</Task>
<!-- \Daily Thing -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><CalendarTrigger/></Triggers>
  <Actions Context="Author"><Exec><Command>C:\x.exe</Command></Exec></Actions>
</Task>
<!-- \Switched Off -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><BootTrigger/></Triggers>
  <Settings><Enabled>false</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>C:\y.exe</Command></Exec></Actions>
</Task>
<!-- \Trigger Off -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>false</Enabled></LogonTrigger></Triggers>
  <Actions Context="Author"><Exec><Command>C:\z.exe</Command></Exec></Actions>
</Task>
</Tasks>"#;
        let tasks = parse_tasks(xml);
        assert_eq!(tasks.len(), 2);
        assert_eq!(
            tasks[0],
            TaskInfo {
                path: r"\Vendor\Updater".into(),
                enabled: true,
                command: r"%ProgramFiles%\Vendor\up.exe".into(),
                arguments: "/silent".into(),
                author: Some("Vendor Inc.".into()),
                description: Some("Keeps it fresh".into()),
            }
        );
        assert_eq!((tasks[1].path.as_str(), tasks[1].enabled), (r"\Switched Off", false));
        assert!(parse_tasks("not xml").is_empty());
    }

    #[test]
    fn environment_references_expand() {
        let windows = std::env::var("SystemRoot").unwrap();
        assert_eq!(expand(r"%SystemRoot%\x.exe"), format!(r"{windows}\x.exe"));
        assert_eq!(expand("100% sure"), "100% sure");
        assert_eq!(expand("%NO_SUCH_VAR_DELPHEYE%\\a"), "%NO_SUCH_VAR_DELPHEYE%\\a");
    }

    #[test]
    fn schtasks_output_decodes_in_either_encoding() {
        let utf16: Vec<u8> = [0xFEFFu16].iter().chain("<Tasks/>".encode_utf16().collect::<Vec<_>>().iter()).flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(decode(&utf16), "<Tasks/>");
        assert_eq!(decode(b"<Tasks/>"), "<Tasks/>");
    }

    #[test]
    fn this_machine_has_services_and_the_service_manager_answers() {
        let mut found = Vec::new();
        services(&mut found);
        let event_log = found.iter().find(|r| matches!(&r.switch, Switch::Service { name } if name.eq_ignore_ascii_case("EventLog"))).expect("EventLog service");
        let state = event_log.service.as_ref().unwrap();
        assert!(state.running && state.pid > 0 && state.shared);
        assert!(event_log.program.as_ref().is_some_and(|p| p.to_string_lossy().to_lowercase().contains("wevtsvc")));
    }
}

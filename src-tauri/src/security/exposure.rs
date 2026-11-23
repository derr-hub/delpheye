//! What on this computer can be reached from the network: services listening on every address,
//! the risky ones named, and whether the network the computer is on is marked public.

use std::os::windows::process::CommandExt;
use std::process::Command;

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Open {
    /// The first (lowest) port; `ports` has them all.
    pub port: u16,
    pub ports: Vec<u16>,
    pub name: String,
    pub exe: Option<String>,
    /// A well-known service on this port ("rdp", "smb"…), when it is one.
    pub service: Option<&'static str>,
    /// "high", "medium", "low".
    pub risk: &'static str,
    /// Part of Windows itself.
    pub windows: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Exposure {
    pub open: Vec<Open>,
    /// Names of connected networks Windows treats as public (strangers around).
    pub public_networks: Vec<String>,
    pub private_networks: Vec<String>,
}

/// Ports whose services attackers look for first.
pub fn service(port: u16) -> Option<(&'static str, &'static str)> {
    Some(match port {
        3389 => ("rdp", "high"),
        445 | 139 => ("smb", "high"),
        5900..=5903 => ("vnc", "high"),
        23 => ("telnet", "high"),
        21 => ("ftp", "medium"),
        22 => ("ssh", "medium"),
        5985 | 5986 => ("winrm", "high"),
        3306 => ("mysql", "medium"),
        5432 => ("postgres", "medium"),
        27017 => ("mongodb", "high"),
        6379 => ("redis", "high"),
        1433 => ("mssql", "medium"),
        80 | 8080 | 8000 | 8888 => ("web", "low"),
        443 | 8443 => ("web", "low"),
        135 => ("rpc", "low"),
        5357 | 5358 => ("wsd", "low"),
        7680 => ("delivery", "low"),
        47811 => ("delpheye", "low"),
        _ => return None,
    })
}

fn profiles() -> (Vec<String>, Vec<String>) {
    let windows = crate::system::Dirs::real().map(|d| d.windows).unwrap_or_default();
    let out = Command::new(windows.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-NetConnectionProfile | ForEach-Object { \"$($_.NetworkCategory)|$($_.Name)\" }"])
        .creation_flags(0x0800_0000)
        .output();
    let text = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let (mut public, mut private) = (Vec::new(), Vec::new());
    for line in text.lines() {
        if let Some((cat, name)) = line.trim().split_once('|') {
            if cat.eq_ignore_ascii_case("Public") { public.push(name.to_string()) } else { private.push(name.to_string()) }
        }
    }
    (public, private)
}

/// Windows' own processes, whatever the process table could tell about them.
const SYSTEM: [&str; 9] = ["system", "svchost.exe", "lsass.exe", "wininit.exe", "services.exe", "spoolsv.exe", "smss.exe", "csrss.exe", "winlogon.exe"];

fn rank(r: &str) -> usize {
    ["high", "medium", "low"].iter().position(|x| *x == r).unwrap_or(3)
}

/// How risky one port is, on a network of this kind.
pub fn judge(port: u16, windows: bool, public: bool) -> (Option<&'static str>, &'static str) {
    match service(port) {
        // Shared folders are normal at home; on a public network they should be closed.
        Some(("smb", _)) if !public => (Some("smb"), "medium"),
        Some((s, r)) => (Some(s), r),
        // Windows' own dynamic RPC ports and services.
        None if windows => (None, "low"),
        // A program's own server, open to the network: worth knowing.
        None => (None, "medium"),
    }
}

pub fn check() -> Exposure {
    let (public_networks, private_networks) = profiles();
    let public = !public_networks.is_empty();
    let mut open: Vec<Open> = Vec::new();
    for (port, name, exe, windows) in crate::network::exposed_listeners() {
        let windows = windows || SYSTEM.contains(&name.to_lowercase().as_str());
        let (service, risk) = judge(port, windows, public);
        // A known service keeps its own row; other ports group under their program.
        let key = service.map(|s| s.to_string()).unwrap_or_else(|| format!("app:{name}"));
        match open.iter_mut().find(|o| o.service.map(|s| s.to_string()).unwrap_or_else(|| format!("app:{}", o.name)) == key) {
            Some(o) => {
                if !o.ports.contains(&port) {
                    o.ports.push(port);
                    o.ports.sort();
                    o.port = o.ports[0];
                }
                if rank(risk) < rank(o.risk) {
                    o.risk = risk;
                }
            }
            None => open.push(Open { port, ports: vec![port], name, exe, service, risk, windows }),
        }
    }
    open.sort_by(|a, b| rank(a.risk).cmp(&rank(b.risk)).then(a.port.cmp(&b.port)));
    Exposure { open, public_networks, private_networks }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risky_ports_are_named() {
        assert_eq!(service(3389), Some(("rdp", "high")));
        assert_eq!(service(445).map(|s| s.0), Some("smb"));
        assert_eq!(service(51234), None);
        assert_eq!(judge(445, true, false).1, "medium");
        assert_eq!(judge(445, true, true).1, "high");
        assert_eq!(judge(49664, true, false), (None, "low"));
        assert_eq!(judge(57100, false, false), (None, "medium"));
    }
}

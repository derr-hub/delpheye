//! Signs that something has rewired how the computer reaches the internet or trusts it:
//! the hosts file, proxy settings, DNS servers, added root certificates and antivirus exclusions.

use std::path::Path;

use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

use super::finding::{Finding, Severity};

/// Domains whose redirection or blocking is a hallmark of malware: it keeps you from updates,
/// security software, or sends you to a fake copy of a site.
const SENSITIVE: &[&str] = &[
    "microsoft", "windowsupdate", "windows.com", "live.com", "office", "google", "gstatic", "youtube", "facebook", "instagram",
    "apple", "paypal", "privat24", "privatbank", "monobank", "bank", "steam", "epicgames", "riotgames", "battle.net",
    "eset", "kaspersky", "avast", "avg.com", "bitdefender", "malwarebytes", "mcafee", "norton", "virustotal", "drweb",
];

fn is_local(ip: &str) -> bool {
    ip == "0.0.0.0" || ip.starts_with("127.") || ip == "::1" || ip == "::"
}

/// Judges the lines of a hosts file.
pub fn hosts(content: &str, location: &str) -> Vec<Finding> {
    let mut found = Vec::new();
    for line in content.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        let mut parts = line.split_whitespace();
        let (Some(ip), Some(_)) = (parts.next(), parts.clone().next()) else { continue };
        for domain in parts {
            let d = domain.to_lowercase();
            if d == "localhost" || d.ends_with(".localhost") {
                continue;
            }
            let sensitive = SENSITIVE.iter().any(|s| d.contains(s));
            let (severity, reason) = match (is_local(ip), sensitive) {
                (false, true) => (Severity::High, "redirect-sensitive"),
                (false, false) => (Severity::Medium, "redirect"),
                (true, true) => (Severity::Medium, "block-sensitive"),
                (true, false) => (Severity::Info, "block"),
            };
            found.push(Finding::new("tamper", "hosts", severity, domain, format!("{ip} {domain}"), location).reason(reason));
        }
    }
    found
}

/// Proxy and auto-configuration set for this user's web traffic.
pub fn proxy() -> Vec<Finding> {
    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings") else { return Vec::new() };
    let location = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let mut found = Vec::new();
    let enabled = key.get_value::<u32, _>("ProxyEnable").unwrap_or(0) == 1;
    let server: String = key.get_value("ProxyServer").unwrap_or_default();
    if enabled && !server.is_empty() {
        let local = server.split(';').all(|s| {
            let host = s.rsplit('=').next().unwrap_or(s);
            host.starts_with("127.") || host.starts_with("localhost")
        });
        let (severity, reason) = if local { (Severity::Low, "local") } else { (Severity::Medium, "remote") };
        found.push(Finding::new("tamper", "proxy", severity, "ProxyServer", server, location).reason(reason));
    }
    let pac: String = key.get_value("AutoConfigURL").unwrap_or_default();
    if !pac.is_empty() {
        found.push(Finding::new("tamper", "proxy", Severity::Medium, "AutoConfigURL", pac, location).reason("pac"));
    }
    found
}

/// Well-known public resolvers: choosing one is a normal privacy or speed choice.
const KNOWN_DNS: &[&str] = &[
    "8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1", "9.9.9.9", "149.112.112.112", "208.67.222.222", "208.67.220.220", "94.140.14.14",
    "94.140.15.15", "76.76.2.0", "76.76.10.0", "2001:4860:4860::8888", "2001:4860:4860::8844", "2606:4700:4700::1111", "2606:4700:4700::1001",
];

fn private(ip: &str) -> bool {
    let octets: Vec<u8> = ip.split('.').filter_map(|o| o.parse().ok()).collect();
    match octets.as_slice() {
        [10, ..] | [192, 168, ..] | [127, ..] => true,
        [172, b, ..] => (16..=31).contains(b),
        _ => ip.starts_with("fe80") || ip.starts_with("fd") || ip.starts_with("fc"),
    }
}

/// DNS servers typed in by hand (DHCP-provided ones are the router's business). Malware
/// sets them to its own resolver to send you to fake sites.
pub fn dns() -> Vec<Finding> {
    let root = r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces";
    let Ok(interfaces) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(root) else { return Vec::new() };
    let mut found = Vec::new();
    for id in interfaces.enum_keys().flatten() {
        let Ok(key) = interfaces.open_subkey(&id) else { continue };
        let servers: String = key.get_value("NameServer").unwrap_or_default();
        for server in servers.split([',', ' ']).map(str::trim).filter(|s| !s.is_empty()) {
            if private(server) {
                continue;
            }
            let (severity, reason) = if KNOWN_DNS.contains(&server) { (Severity::Info, "known") } else { (Severity::Medium, "unknown") };
            found.push(Finding::new("tamper", "dns", severity, server, server, format!(r"HKLM\{root}\{id}")).reason(reason));
        }
    }
    found
}

/// Folders, processes and extensions excluded from Microsoft Defender. Malware adds itself
/// here so it is never scanned. Readable only with administrator rights.
pub fn defender_exclusions() -> Vec<Finding> {
    let root = r"SOFTWARE\Microsoft\Windows Defender\Exclusions";
    let mut found = Vec::new();
    for list in ["Paths", "Processes", "Extensions"] {
        let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(format!(r"{root}\{list}")) else { continue };
        for (name, _) in key.enum_values() .flatten() {
            let risky = super::patterns::in_risky_folder(&name.to_lowercase()) || name.len() <= 4;
            let severity = if risky { Severity::High } else { Severity::Medium };
            found.push(Finding::new("tamper", "defender-exclusion", severity, name.clone(), list, format!(r"HKLM\{root}\{list}")));
        }
    }
    found
}

/// Root certificates someone added. A root certificate lets its owner impersonate any
/// website, so an unknown one can mean your HTTPS traffic is being read.
pub fn root_certificates(read: &dyn Fn(bool) -> Vec<(String, String)>) -> Vec<Finding> {
    let mut found = Vec::new();
    for (machine, shown) in [(true, r"HKLM\SOFTWARE\Microsoft\SystemCertificates\Root"), (false, r"HKCU\Software\Microsoft\SystemCertificates\Root")] {
        for (thumbprint, subject) in read(machine) {
            let lower = subject.to_lowercase();
            if lower.contains("microsoft") || WINDOWS_ROOTS.iter().any(|r| lower.contains(r)) {
                continue;
            }
            // Antivirus HTTPS scanning installs its own root on purpose.
            let antivirus = ["eset", "avast", "avg", "kaspersky", "bitdefender", "norton", "mcafee", "malwarebytes", "dr.web", "sophos", "adguard"].iter().any(|a| lower.contains(a));
            let (severity, reason) = if antivirus { (Severity::Info, "antivirus") } else if machine { (Severity::Low, "machine") } else { (Severity::Medium, "user") };
            found.push(Finding::new("tamper", "root-cert", severity, subject, thumbprint, shown).reason(reason));
        }
    }
    found
}

/// Roots Windows itself places in the Root store besides Microsoft's own.
const WINDOWS_ROOTS: &[&str] = &[
    "verisign", "thawte", "symantec", "digicert", "globalsign", "baltimore", "comodo", "sectigo", "usertrust", "isrg", "entrust",
    "godaddy", "starfield", "certum", "quovadis", "amazon", "identrust", "addtrust", "geotrust", "network solutions", "copyright (c) 1997",
    "no liability accepted", "class 3 public primary", "aaa certificate services", "t-telesec", "d-trust", "actalis", "buypass", "secom", "swisssign", "ssl.com", "hongkong post",
];

pub fn hosts_file(windows: &Path) -> (String, String) {
    let path = windows.join(r"System32\drivers\etc\hosts");
    (std::fs::read_to_string(&path).unwrap_or_default(), path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_entries_are_graded_by_what_they_do() {
        let content = "# Copyright (c) 1993-2009 Microsoft Corp.\n#\n# 127.0.0.1 localhost\n127.0.0.1 localhost\n\
            0.0.0.0 ads.example.com tracker.example.net\n\
            0.0.0.0 update.microsoft.com\n\
            185.12.0.4 www.paypal.com # phishing\n\
            10.0.0.5 nas.home\n";
        let found = hosts(content, "hosts");
        let summary: Vec<(&str, Option<&str>, Severity)> = found.iter().map(|f| (f.title.as_str(), f.reason, f.severity)).collect();
        assert_eq!(
            summary,
            [
                ("ads.example.com", Some("block"), Severity::Info),
                ("tracker.example.net", Some("block"), Severity::Info),
                ("update.microsoft.com", Some("block-sensitive"), Severity::Medium),
                ("www.paypal.com", Some("redirect-sensitive"), Severity::High),
                ("nas.home", Some("redirect"), Severity::Medium),
            ]
        );
        assert!(hosts("# only comments\n\n", "hosts").is_empty());
    }

    #[test]
    fn private_and_public_addresses_are_told_apart() {
        for ip in ["192.168.1.1", "10.0.0.1", "172.20.0.1", "fe80::1"] {
            assert!(private(ip), "{ip}");
        }
        for ip in ["8.8.8.8", "172.32.0.1", "45.90.28.0"] {
            assert!(!private(ip), "{ip}");
        }
    }

    #[test]
    fn antivirus_and_windows_roots_are_not_alarming() {
        let read = |machine: bool| {
            if machine {
                vec![
                    ("aa".into(), "Microsoft Root Certificate Authority 2011".into()),
                    ("bb".into(), "DigiCert Global Root G2".into()),
                    ("cc".into(), "ESET SSL Filter CA".into()),
                    ("dd".into(), "Some Vendor Local Root".into()),
                ]
            } else {
                vec![("ee".into(), "Fiddler Root".into())]
            }
        };
        let found = root_certificates(&read);
        let summary: Vec<(&str, Severity)> = found.iter().map(|f| (f.title.as_str(), f.severity)).collect();
        assert_eq!(summary, [("ESET SSL Filter CA", Severity::Info), ("Some Vendor Local Root", Severity::Low), ("Fiddler Root", Severity::Medium)]);
    }
}

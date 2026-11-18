//! How well the computer is protected, as a scored test of Windows' own defences.

use serde::{Deserialize, Serialize};
use winreg::RegKey;
use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Pass,
    Fail,
    /// Could not be checked (needs administrator rights, or not applicable).
    Unknown,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Test {
    pub id: &'static str,
    pub outcome: Outcome,
    /// How much it counts towards the score.
    pub weight: u32,
    /// Extra facts for the explanation, e.g. a product name or a date.
    pub detail: Option<String>,
    /// A Windows settings page that fixes it.
    pub fix: Option<&'static str>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// 0–100 over the tests that could be checked.
    pub score: u32,
    pub tests: Vec<Test>,
}

/// What the sensor helper's `--security` mode reports.
#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Facts {
    pub antivirus: Section<Product>,
    pub firewall: Section<Product>,
    pub wmi_subscriptions: Section<Subscription>,
    pub tpm_present: Option<bool>,
    pub tpm_ready: Option<bool>,
    pub encryption: Section<Volume>,
    pub last_update: Option<String>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Section<T> {
    pub readable: bool,
    pub items: Vec<T>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Product {
    pub name: String,
    pub enabled: bool,
    pub up_to_date: bool,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Subscription {
    pub kind: String,
    pub name: String,
    pub detail: String,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Volume {
    pub drive: String,
    pub protected: bool,
}

/// Registry readings the tests need, gathered in one place so tests can supply their own.
#[derive(Default, Debug, Clone)]
pub struct Settings {
    pub enable_lua: Option<u32>,
    pub consent_admin: Option<u32>,
    pub smartscreen_policy: Option<u32>,
    pub smartscreen_explorer: Option<String>,
    pub secure_boot: Option<u32>,
    pub hvci: Option<u32>,
    pub lsa_ppl: Option<u32>,
    pub driver_blocklist: Option<u32>,
    pub rdp_denied: Option<u32>,
    pub smb1_service_start: Option<u32>,
    pub smb1_server: Option<u32>,
    pub autologon: Option<String>,
    pub default_password: bool,
    pub windows_firewall_on: Option<bool>,
}

fn dword(path: &str, name: &str) -> Option<u32> {
    RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY).ok()?.get_value(name).ok()
}

fn string(path: &str, name: &str) -> Option<String> {
    RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY).ok()?.get_value(name).ok()
}

pub fn read_settings() -> Settings {
    let policies = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
    let winlogon = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon";
    let firewall = r"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy";
    let profiles: Vec<Option<u32>> = ["DomainProfile", "StandardProfile", "PublicProfile"].iter().map(|p| dword(&format!(r"{firewall}\{p}"), "EnableFirewall")).collect();
    Settings {
        enable_lua: dword(policies, "EnableLUA"),
        consent_admin: dword(policies, "ConsentPromptBehaviorAdmin"),
        smartscreen_policy: dword(r"SOFTWARE\Policies\Microsoft\Windows\System", "EnableSmartScreen"),
        smartscreen_explorer: string(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer", "SmartScreenEnabled"),
        secure_boot: dword(r"SYSTEM\CurrentControlSet\Control\SecureBoot\State", "UEFISecureBootEnabled"),
        hvci: dword(r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity", "Enabled"),
        lsa_ppl: dword(r"SYSTEM\CurrentControlSet\Control\Lsa", "RunAsPPL"),
        driver_blocklist: dword(r"SYSTEM\CurrentControlSet\Control\CI\Config", "VulnerableDriverBlocklistEnable"),
        rdp_denied: dword(r"SYSTEM\CurrentControlSet\Control\Terminal Server", "fDenyTSConnections"),
        smb1_service_start: dword(r"SYSTEM\CurrentControlSet\Services\mrxsmb10", "Start"),
        smb1_server: dword(r"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters", "SMB1"),
        autologon: string(winlogon, "AutoAdminLogon"),
        default_password: string(winlogon, "DefaultPassword").is_some_and(|p| !p.is_empty()),
        windows_firewall_on: profiles.iter().all(Option::is_some).then(|| profiles.iter().all(|p| *p == Some(1))),
    }
}

fn days_since(date: &str, today: i64) -> Option<i64> {
    let parts: Vec<i64> = date.split('-').filter_map(|p| p.parse().ok()).collect();
    let [y, m, d] = parts[..] else { return None };
    // Days from the civil date (Howard Hinnant's algorithm), as in the crash log parser.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    Some(today / 86_400 - days)
}

pub fn run(facts: &Facts, s: &Settings, today: i64) -> Report {
    use Outcome::{Fail, Pass, Unknown};
    let mut tests = Vec::new();
    let mut add = |id, outcome, weight, detail: Option<String>, fix| tests.push(Test { id, outcome, weight, detail, fix });

    // Antivirus: any product switched on, and its definitions current.
    let active: Vec<&Product> = facts.antivirus.items.iter().filter(|p| p.enabled).collect();
    let names = |products: &[&Product]| (!products.is_empty()).then(|| products.iter().map(|p| p.name.clone()).collect::<Vec<_>>().join(", "));
    add("antivirus", if !facts.antivirus.readable { Unknown } else if active.is_empty() { Fail } else { Pass }, 20, names(&active), Some("windowsdefender:"));
    if !active.is_empty() {
        let current = active.iter().any(|p| p.up_to_date);
        add("antivirus-updates", if current { Pass } else { Fail }, 5, names(&active), None);
    }

    // Firewall: a registered product, or Windows' own on every profile.
    let firewall_product: Vec<&Product> = facts.firewall.items.iter().filter(|p| p.enabled).collect();
    let firewall = if !firewall_product.is_empty() || s.windows_firewall_on == Some(true) {
        Pass
    } else if s.windows_firewall_on == Some(false) {
        Fail
    } else {
        Unknown
    };
    add("firewall", firewall, 15, names(&firewall_product).or(Some("Windows Defender Firewall".into())), Some("windowsdefender://network"));

    // Updates installed recently.
    let age = facts.last_update.as_deref().and_then(|d| days_since(d, today));
    add("updates", match age { Some(a) if a <= 45 => Pass, Some(_) => Fail, None => Unknown }, 15, facts.last_update.clone(), Some("ms-settings:windowsupdate"));

    // User Account Control, and that it actually asks.
    let uac = match (s.enable_lua, s.consent_admin) {
        (Some(0), _) | (_, Some(0)) => Fail,
        (None, _) => Unknown,
        _ => Pass,
    };
    add("uac", uac, 10, None, None);

    // SmartScreen: unless policy or Explorer turned it off.
    let smartscreen = if s.smartscreen_policy == Some(0) || s.smartscreen_explorer.as_deref().is_some_and(|v| v.eq_ignore_ascii_case("off")) { Fail } else { Pass };
    add("smartscreen", smartscreen, 5, None, Some("windowsdefender://appbrowser"));

    add("secure-boot", match s.secure_boot { Some(1) => Pass, Some(_) => Fail, None => Unknown }, 5, None, None);
    add("tpm", match (facts.tpm_present, facts.tpm_ready) { (Some(true), Some(true)) => Pass, (Some(false), _) | (Some(true), Some(false)) => Fail, _ => Unknown }, 5, None, Some("windowsdefender://devicesecurity"));

    // Disk encryption on the system drive.
    let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()).to_uppercase();
    let encryption = if !facts.encryption.readable {
        Unknown
    } else if facts.encryption.items.iter().any(|v| v.drive.eq_ignore_ascii_case(&system_drive) && v.protected) {
        Pass
    } else {
        Fail
    };
    add("encryption", encryption, 5, None, Some("ms-settings:deviceencryption"));

    add("core-isolation", if s.hvci == Some(1) { Pass } else { Fail }, 5, None, Some("windowsdefender://coreisolation"));
    add("lsa-protection", if matches!(s.lsa_ppl, Some(1 | 2)) { Pass } else { Fail }, 3, None, Some("windowsdefender://coreisolation"));
    // On current Windows the blocklist is on unless explicitly switched off.
    add("driver-blocklist", if s.driver_blocklist == Some(0) { Fail } else { Pass }, 2, None, Some("windowsdefender://coreisolation"));

    add("rdp", if s.rdp_denied == Some(0) { Fail } else { Pass }, 3, None, Some("ms-settings:remotedesktop"));
    let smb1_on = s.smb1_server == Some(1) || matches!(s.smb1_service_start, Some(0..=3));
    add("smb1", if smb1_on { Fail } else { Pass }, 3, None, None);
    let autologon = s.autologon.as_deref() == Some("1") && s.default_password;
    add("autologon", if autologon { Fail } else { Pass }, 4, None, None);

    let (got, possible) = tests.iter().fold((0, 0), |(got, possible), t| match t.outcome {
        Pass => (got + t.weight, possible + t.weight),
        Fail => (got, possible + t.weight),
        Unknown => (got, possible),
    });
    let score = if possible == 0 { 0 } else { got * 100 / possible };
    Report { score, tests }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn product(name: &str, enabled: bool, up_to_date: bool) -> Product {
        Product { name: name.into(), enabled, up_to_date }
    }

    fn hardened() -> (Facts, Settings) {
        let facts = Facts {
            antivirus: Section { readable: true, items: vec![product("Windows Defender", false, true), product("ESET Security", true, true)] },
            firewall: Section { readable: true, items: vec![product("ESET Firewall", true, true)] },
            tpm_present: Some(true),
            tpm_ready: Some(true),
            encryption: Section { readable: true, items: vec![Volume { drive: "C:".into(), protected: true }] },
            last_update: Some("2026-11-10".into()),
            ..Facts::default()
        };
        let settings = Settings {
            enable_lua: Some(1),
            consent_admin: Some(5),
            secure_boot: Some(1),
            hvci: Some(1),
            lsa_ppl: Some(2),
            rdp_denied: Some(1),
            smb1_service_start: Some(4),
            windows_firewall_on: Some(true),
            ..Settings::default()
        };
        (facts, settings)
    }

    const TODAY: i64 = 1_795_000_000; // mid-November 2026

    fn outcome(report: &Report, id: &str) -> Outcome {
        report.tests.iter().find(|t| t.id == id).unwrap().outcome
    }

    #[test]
    fn a_hardened_machine_scores_full_marks() {
        let (facts, settings) = hardened();
        let report = run(&facts, &settings, TODAY);
        assert_eq!(report.score, 100, "{:?}", report.tests.iter().filter(|t| t.outcome != Outcome::Pass).collect::<Vec<_>>());
        assert_eq!(report.tests.iter().find(|t| t.id == "antivirus").unwrap().detail.as_deref(), Some("ESET Security"));
    }

    #[test]
    fn weaknesses_lower_the_score_and_unknowns_do_not_count() {
        let (mut facts, mut settings) = hardened();
        facts.antivirus.items = vec![product("Windows Defender", false, true)];
        facts.last_update = Some("2026-06-01".into());
        facts.encryption = Section { readable: false, items: vec![] };
        settings.enable_lua = Some(0);
        settings.autologon = Some("1".into());
        settings.default_password = true;
        let report = run(&facts, &settings, TODAY);
        for (id, expected) in [("antivirus", Outcome::Fail), ("updates", Outcome::Fail), ("uac", Outcome::Fail), ("autologon", Outcome::Fail), ("encryption", Outcome::Unknown)] {
            assert_eq!(outcome(&report, id), expected, "{id}");
        }
        assert!(report.score < 60, "score {}", report.score);
    }

    #[test]
    fn dates_count_days() {
        assert_eq!(days_since("1970-01-11", 864_000 + 3600), Some(0));
        assert_eq!(days_since("2026-11-10", TODAY), Some(8));
        assert_eq!(days_since("nonsense", TODAY), None);
    }
}

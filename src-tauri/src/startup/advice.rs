//! What each autostart entry is, and what to do about it.
//!
//! The rules are deliberately simple and readable: they look at the entry's name, program
//! path, publisher and description. They only ever *suggest*; nothing is changed by them.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Windows,
    Security,
    Hardware,
    Launcher,
    Updater,
    Messenger,
    Cloud,
    Browser,
    Media,
    Other,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Advice {
    /// Needed for the system, a device or protection to work properly.
    Keep,
    /// A matter of taste.
    Optional,
    /// Gains nothing by starting with Windows; can be started by hand when needed.
    Disable,
    /// Something about it looks off; worth a look before deciding.
    Review,
    /// The program it starts is gone.
    Broken,
}

/// Everything the rules look at.
pub struct Facts<'a> {
    pub name: &'a str,
    pub command: &'a str,
    pub publisher: Option<&'a str>,
    pub description: Option<&'a str>,
    pub exists: bool,
    pub signed: Option<bool>,
    pub microsoft: bool,
    /// The program lives inside the Windows folder.
    pub in_windows: bool,
}

const SECURITY: &[&str] = &[
    "defender", "securityhealth", "eset", "ekrn", "egui", "kaspersky", "avast", "avg ", "bitdefender",
    "malwarebytes", "norton", "mcafee", "sophos", "avira", "vanguard", "vgtray", "vgc", "easyanticheat",
    "battleye", "anticheat", "anti-cheat", "faceit", "eaanticheat", "firewall",
];
const HARDWARE: &[&str] = &[
    "nvidia", "realtek", "intel", "radeon", "amd software", "amd ", "logitech", "lghub", "razer", "corsair",
    "steelseries", "synaptics", "elan", "dolby", "waves", "asus", "armoury", "msi ", "lenovo", "dell ",
    "hp ", "bluetooth", "audio", "touchpad", "wacom", "nahimic", "thunderbolt", "rgb",
];
const BROWSERS: &[&str] = &["autolaunch", "--no-startup-window", "browser_broker"];
const LAUNCHERS: &[&str] = &[
    "steam", "epicgames", "epic games", "eadm", "ea desktop", "ealauncher", "eabackground", "origin",
    "ubisoft", "uplay", "riotclient", "riot client", "battle.net", "battlenet", "galaxyclient", "goggalaxy",
    "gog galaxy", "wargaming", "overwolf", "rockstar", "bethesda", "xboxapp", "playnite", "launcher",
];
const MESSENGERS: &[&str] = &[
    "discord", "telegram", "signal", "teams", "skype", "slack", "zoom", "whatsapp", "viber", "messenger",
];
const CLOUD: &[&str] = &["onedrive", "dropbox", "googledrive", "google drive", "icloud", "mega", "yandex", "nextcloud", "sync"];
const MEDIA: &[&str] = &[
    "ccleaner", "filmora", "wondershare", "wallpaperengine", "wallpaper engine", "adobe", "creative cloud",
    "spotify", "itunes", "obs", "nvidia share", "tray",
];
const UPDATERS: &[&str] = &["update", "updater", "autoupdate", "selfupdate", "maintenance", "helper"];
/// Places a well-behaved program does not run from.
const ODD_PLACES: &[&str] = &["\\temp\\", "\\downloads\\", "\\users\\public\\", "\\appdata\\local\\temp"];

fn any(text: &str, words: &[&str]) -> bool {
    words.iter().any(|word| text.contains(word))
}

/// Category, advice and the reasons behind it, as codes the UI translates.
pub fn advise(facts: &Facts) -> (Category, Advice, Vec<&'static str>) {
    let text = format!(
        "{} {} {} {}",
        facts.name,
        facts.command,
        facts.publisher.unwrap_or(""),
        facts.description.unwrap_or("")
    )
    .to_lowercase();
    let mut reasons = Vec::new();

    let category = if any(&text, SECURITY) {
        Category::Security
    } else if facts.microsoft && facts.in_windows {
        Category::Windows
    } else if any(&text, HARDWARE) {
        Category::Hardware
    } else if any(&text, BROWSERS) {
        Category::Browser
    // Messengers first: "ms-teams" contains "steam".
    } else if any(&text, MESSENGERS) {
        Category::Messenger
    } else if any(&text, LAUNCHERS) {
        Category::Launcher
    } else if any(&text, CLOUD) {
        Category::Cloud
    } else if any(&text, MEDIA) {
        Category::Media
    } else if any(&text, UPDATERS) {
        Category::Updater
    } else {
        Category::Other
    };

    if !facts.exists {
        reasons.push("missing");
        return (category, Advice::Broken, reasons);
    }

    let unsigned = facts.signed == Some(false);
    let odd_place = any(&facts.command.to_lowercase(), ODD_PLACES);
    if unsigned {
        reasons.push("unsigned");
    }
    if facts.publisher.is_none() && !facts.in_windows {
        reasons.push("no-publisher");
    }
    if odd_place {
        reasons.push("odd-place");
    }

    let advice = match category {
        Category::Windows | Category::Security | Category::Hardware => Advice::Keep,
        // An unknown, unsigned program from an odd place deserves a look whatever it claims to be.
        _ if odd_place || (unsigned && facts.publisher.is_none()) => Advice::Review,
        Category::Browser | Category::Launcher | Category::Updater | Category::Media => Advice::Disable,
        Category::Messenger | Category::Cloud | Category::Other => Advice::Optional,
    };
    reasons.push(match category {
        Category::Windows => "windows",
        Category::Security => "security",
        Category::Hardware => "hardware",
        Category::Browser => "browser",
        Category::Launcher => "launcher",
        Category::Updater => "updater",
        Category::Messenger => "messenger",
        Category::Cloud => "cloud",
        Category::Media => "media",
        Category::Other => "other",
    });
    (category, advice, reasons)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts<'a>(name: &'a str, command: &'a str, publisher: Option<&'a str>) -> Facts<'a> {
        Facts { name, command, publisher, description: None, exists: true, signed: Some(true), microsoft: false, in_windows: false }
    }

    fn judge(f: &Facts) -> (Category, Advice) {
        let (category, advice, _) = advise(f);
        (category, advice)
    }

    #[test]
    fn real_entries_from_a_gaming_pc_get_sensible_advice() {
        let cases = [
            (facts("Steam", r#""C:\Program Files (x86)\Steam\steam.exe" -silent"#, Some("Valve")), (Category::Launcher, Advice::Disable)),
            (facts("EpicGamesLauncher", r#""C:\Program Files (x86)\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe" -silent"#, Some("Epic Games, Inc.")), (Category::Launcher, Advice::Disable)),
            (facts("Discord", r#""C:\Users\me\AppData\Local\Discord\Update.exe" --processStart Discord.exe"#, Some("Discord Inc.")), (Category::Messenger, Advice::Optional)),
            (facts("GoogleChromeAutoLaunch_D456", r#""C:\Program Files\Google\Chrome\Application\chrome.exe" --no-startup-window"#, Some("Google LLC")), (Category::Browser, Advice::Disable)),
            (facts("OneDrive", r#""C:\Program Files\Microsoft OneDrive\OneDrive.exe" /background"#, Some("Microsoft Corporation")), (Category::Cloud, Advice::Optional)),
            (facts("Riot Vanguard", r#""C:\Program Files\Riot Vanguard\vgtray.exe""#, Some("Riot Games, Inc.")), (Category::Security, Advice::Keep)),
            (facts("egui", r#""C:\Program Files\ESET\ESET Security\ecmds.exe" /run"#, Some("ESET")), (Category::Security, Advice::Keep)),
            (facts("CCleaner Smart Cleaning", r"C:\Program Files\CCleaner\CCleaner64.exe /MONITOR", Some("Piriform")), (Category::Media, Advice::Disable)),
            (facts("Teams", r#""C:\Users\me\AppData\Local\Microsoft\WindowsApps\MSTeams_8wekyb3d8bbwe\ms-teams.exe" msteams:system-initiated"#, Some("Microsoft Store")), (Category::Messenger, Advice::Optional)),
            (facts("RtkAudUService", r"C:\Program Files\Realtek\Audio\RtkAudUService64.exe", Some("Realtek Semiconductor")), (Category::Hardware, Advice::Keep)),
        ];
        for (f, expected) in cases {
            assert_eq!(judge(&f), expected, "{}", f.name);
        }
    }

    #[test]
    fn windows_components_are_kept() {
        let f = Facts { microsoft: true, in_windows: true, ..facts("SecurityHealth", r"C:\WINDOWS\system32\SecurityHealthSystray.exe", Some("Microsoft Corporation")) };
        assert_eq!(judge(&f).1, Advice::Keep);
    }

    #[test]
    fn a_missing_program_is_broken() {
        let f = Facts { exists: false, ..facts("GalaxyClient", "", None) };
        assert_eq!(advise(&f).1, Advice::Broken);
        assert_eq!(advise(&f).2, ["missing"]);
    }

    #[test]
    fn unknown_unsigned_programs_from_odd_places_need_a_look() {
        let f = Facts { signed: Some(false), ..facts("qhpxndiguijf", r"C:\Users\me\AppData\Local\Temp\qhpx.exe", None) };
        let (_, advice, reasons) = advise(&f);
        assert_eq!(advice, Advice::Review);
        assert!(reasons.contains(&"unsigned") && reasons.contains(&"odd-place") && reasons.contains(&"no-publisher"));

        // Signed and from a normal place: just a matter of taste.
        let f = facts("Some Tool", r"C:\Program Files\Some Tool\tool.exe", Some("Some Vendor"));
        assert_eq!(judge(&f), (Category::Other, Advice::Optional));
    }
}

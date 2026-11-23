//! Browser extensions: what each one is allowed to see and do. An extension that reads every
//! site, its cookies or the requests it makes can take over accounts — the most common way
//! accounts are stolen today. Read from the browsers' own files; nothing is changed.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Extension {
    /// "chrome", "edge", "brave", "vivaldi", "opera", "firefox".
    pub browser: &'static str,
    pub profile: String,
    pub id: String,
    pub name: String,
    pub version: String,
    /// None when the browser's settings could not be read (it may hold them open).
    pub enabled: Option<bool>,
    /// Installed from the browser's own store.
    pub from_store: bool,
    /// Loaded unpacked, in developer mode.
    pub unpacked: bool,
    /// Reads and can change every site.
    pub all_sites: bool,
    /// Powerful permissions it holds, by their names in the manifest.
    pub powers: Vec<String>,
    /// "high", "medium", "low": how much it could do, not a verdict on the extension.
    pub risk: &'static str,
    /// A well-known extension whose wide permissions are its job.
    pub known: bool,
    pub path: String,
}

/// Permissions that let an extension watch or steer what the user does.
const POWERS: [&str; 14] = [
    "cookies",
    "webRequest",
    "webRequestBlocking",
    "debugger",
    "nativeMessaging",
    "proxy",
    "history",
    "clipboardRead",
    "management",
    "privacy",
    "downloads",
    "tabCapture",
    "desktopCapture",
    "declarativeNetRequestWithHostAccess",
];
/// The ones that, together with every site, amount to reading the user's sessions.
const SEVERE: [&str; 6] = ["cookies", "webRequest", "webRequestBlocking", "debugger", "nativeMessaging", "proxy"];

fn all_sites_pattern(p: &str) -> bool {
    matches!(p, "<all_urls>" | "*://*/*" | "http://*/*" | "https://*/*" | "*://*" | "http://*/" | "https://*/")
}

/// Well-known extensions whose wide permissions are their job (blockers, password managers…).
const KNOWN: [&str; 12] = [
    "cjpalhdlnbpafiamejdnhcphjbkeiagm", // uBlock Origin
    "ddkjiahejlhfcafbddmgiahcphecmpfh", // uBlock Origin Lite
    "bgnkhhnnamicmpeenaelnjfhikgbkllg", // AdGuard
    "nngceckbapebfimnlniiiahkandclblb", // Bitwarden
    "aeblfdkhhhdcdjpifhhbdiojplfjncoa", // 1Password
    "hdokiejnpimakedhajhdlcegeplioahd", // LastPass
    "ghmbeldphafepmbegfdlkpapadhbakde", // Proton Pass
    "aapbdbdomjkkjkaonfhkkikfgjllcleb", // Google Translate
    "kbfnbcaeplbcioakkpcpgfkobkghlhen", // Grammarly
    "eimadpbcbfnmbkopoojfekhnkhdbieeh", // Dark Reader
    "uBlock0@raymondhill.net",          // uBlock Origin (Firefox)
    "{446900e4-71c2-419f-a6a7-df9c091e268b}", // Bitwarden (Firefox)
];

pub fn known(id: &str) -> bool {
    KNOWN.contains(&id)
}

pub fn risk(all_sites: bool, powers: &[String], from_store: bool) -> &'static str {
    let severe = powers.iter().any(|p| SEVERE.contains(&p.as_str()));
    if all_sites && (severe || !from_store) {
        "high"
    } else if all_sites || severe || !from_store {
        "medium"
    } else {
        "low"
    }
}

/// Reads "__MSG_name__" from the extension's messages.
fn localized(dir: &Path, manifest: &Value, text: &str) -> String {
    let Some(key) = text.strip_prefix("__MSG_").and_then(|t| t.strip_suffix("__")) else { return text.to_string() };
    let default = manifest["default_locale"].as_str().unwrap_or("en");
    for locale in ["uk", default, "en", "en_US"] {
        let file = dir.join("_locales").join(locale).join("messages.json");
        if let Ok(v) = std::fs::read_to_string(&file).map(|t| serde_json::from_str::<Value>(&t).unwrap_or(Value::Null)) {
            if let Some(found) = v.as_object().and_then(|m| m.iter().find(|(k, _)| k.eq_ignore_ascii_case(key))) {
                if let Some(msg) = found.1["message"].as_str() {
                    return msg.to_string();
                }
            }
        }
    }
    key.to_string()
}

fn soften(risk: &'static str, known: bool) -> &'static str {
    match (risk, known) {
        ("high", true) => "medium",
        (r, _) => r,
    }
}

/// What a Chromium manifest asks for: (every site, powerful permissions).
pub fn chromium_permissions(manifest: &Value) -> (bool, Vec<String>) {
    let mut all = false;
    let mut powers = Vec::new();
    let list = |k: &str| manifest[k].as_array().cloned().unwrap_or_default();
    for p in list("permissions").into_iter().chain(list("host_permissions")).chain(list("optional_host_permissions").into_iter().take(0)) {
        if let Some(p) = p.as_str() {
            if all_sites_pattern(p) {
                all = true;
            } else if POWERS.contains(&p) && !powers.iter().any(|x| x == p) {
                powers.push(p.to_string());
            }
        }
    }
    for cs in list("content_scripts") {
        if cs["matches"].as_array().into_iter().flatten().any(|m| m.as_str().is_some_and(all_sites_pattern)) {
            all = true;
        }
    }
    (all, powers)
}

const STORE_UPDATES: [&str; 3] = ["clients2.google.com/service/update2/crx", "edge.microsoft.com/extensionwebstorebase", "extension-updates.opera.com"];

fn chromium_profile(browser: &'static str, profile_dir: &Path, out: &mut Vec<Extension>) {
    let ext_dir = profile_dir.join("Extensions");
    let Ok(ids) = std::fs::read_dir(&ext_dir) else { return };
    // The settings say which are switched on and where they came from, when readable.
    let prefs: Value = ["Secure Preferences", "Preferences"]
        .iter()
        .filter_map(|f| std::fs::read_to_string(profile_dir.join(f)).ok())
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .find(|v| v["extensions"]["settings"].is_object())
        .unwrap_or(Value::Null);
    let profile = profile_dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    for id in ids.flatten() {
        let id_name = id.file_name().to_string_lossy().into_owned();
        if id_name == "Temp" {
            continue;
        }
        // The newest version folder.
        let Some(version_dir) = std::fs::read_dir(id.path()).ok().and_then(|v| v.flatten().filter(|e| e.path().is_dir()).map(|e| e.path()).max()) else { continue };
        let Some(manifest) = std::fs::read_to_string(version_dir.join("manifest.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        let setting = &prefs["extensions"]["settings"][&id_name];
        // Component and built-in extensions (location 5 and 10) are part of the browser.
        let location = setting["location"].as_i64();
        if matches!(location, Some(5) | Some(10)) {
            continue;
        }
        let update = manifest["update_url"].as_str().unwrap_or_default();
        let from_store = setting["from_webstore"].as_bool().unwrap_or(false) || STORE_UPDATES.iter().any(|u| update.contains(u));
        let enabled = if setting.is_object() {
            Some(setting["state"].as_i64().map(|s| s == 1).unwrap_or_else(|| setting["disable_reasons"].as_array().map_or(true, |a| a.is_empty()) && setting["disable_reasons"].as_i64().unwrap_or(0) == 0))
        } else {
            None
        };
        let (all_sites, powers) = chromium_permissions(&manifest);
        let name = localized(&version_dir, &manifest, manifest["name"].as_str().unwrap_or(&id_name));
        out.push(Extension {
            browser,
            profile: profile.clone(),
            risk: soften(risk(all_sites, &powers, from_store), known(&id_name)),
            known: known(&id_name),
            id: id_name,
            name,
            version: manifest["version"].as_str().unwrap_or_default().to_string(),
            enabled,
            from_store,
            unpacked: location == Some(4),
            all_sites,
            powers,
            path: version_dir.display().to_string(),
        });
    }
}

fn chromium(browser: &'static str, user_data: PathBuf, out: &mut Vec<Extension>) {
    let Ok(entries) = std::fs::read_dir(&user_data) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name == "Default" || name.starts_with("Profile ") {
            chromium_profile(browser, &e.path(), out);
        }
    }
    // Opera keeps a single profile in the folder itself.
    if user_data.join("Extensions").is_dir() {
        chromium_profile(browser, &user_data, out);
    }
}

/// Firefox lists its add-ons in each profile's extensions.json.
pub fn firefox_addons(json: &Value, profile: &str, out: &mut Vec<Extension>) {
    for a in json["addons"].as_array().into_iter().flatten() {
        if a["type"].as_str() != Some("extension") || a["location"].as_str() != Some("app-profile") {
            continue;
        }
        let perms: Vec<String> = a["userPermissions"]["permissions"].as_array().into_iter().flatten().filter_map(|p| p.as_str().map(String::from)).collect();
        let origins: Vec<&str> = a["userPermissions"]["origins"].as_array().into_iter().flatten().filter_map(|p| p.as_str()).collect();
        let all_sites = origins.iter().any(|o| all_sites_pattern(o));
        let powers: Vec<String> = perms.into_iter().filter(|p| POWERS.contains(&p.as_str())).collect();
        // Signed by Mozilla means it went through addons.mozilla.org.
        let from_store = a["signedState"].as_i64().unwrap_or(0) >= 2 || a["sourceURI"].as_str().unwrap_or_default().contains("addons.mozilla.org");
        out.push(Extension {
            browser: "firefox",
            profile: profile.to_string(),
            risk: soften(risk(all_sites, &powers, from_store), known(a["id"].as_str().unwrap_or_default())),
            known: known(a["id"].as_str().unwrap_or_default()),
            id: a["id"].as_str().unwrap_or_default().to_string(),
            name: a["defaultLocale"]["name"].as_str().unwrap_or_else(|| a["id"].as_str().unwrap_or_default()).to_string(),
            version: a["version"].as_str().unwrap_or_default().to_string(),
            enabled: a["active"].as_bool(),
            from_store,
            unpacked: a["temporarilyInstalled"].as_bool().unwrap_or(false),
            all_sites,
            powers,
            path: a["path"].as_str().unwrap_or_default().to_string(),
        });
    }
}

/// Every browser extension on this user account, riskiest first.
pub fn list() -> Vec<Extension> {
    let mut out = Vec::new();
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    if let Some(l) = &local {
        chromium("chrome", l.join(r"Google\Chrome\User Data"), &mut out);
        chromium("edge", l.join(r"Microsoft\Edge\User Data"), &mut out);
        chromium("brave", l.join(r"BraveSoftware\Brave-Browser\User Data"), &mut out);
        chromium("vivaldi", l.join(r"Vivaldi\User Data"), &mut out);
    }
    if let Some(r) = &roaming {
        chromium("opera", r.join(r"Opera Software\Opera Stable"), &mut out);
        chromium("opera", r.join(r"Opera Software\Opera GX Stable"), &mut out);
        if let Ok(profiles) = std::fs::read_dir(r.join(r"Mozilla\Firefox\Profiles")) {
            for p in profiles.flatten() {
                if let Some(v) = std::fs::read_to_string(p.path().join("extensions.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                    firefox_addons(&v, &p.file_name().to_string_lossy(), &mut out);
                }
            }
        }
    }
    let rank = |r: &str| match r {
        "high" => 0,
        "medium" => 1,
        _ => 2,
    };
    out.sort_by(|a, b| rank(a.risk).cmp(&rank(b.risk)).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn permissions_and_risk() {
        let m = json!({ "permissions": ["storage", "cookies", "tabs"], "host_permissions": ["<all_urls>"] });
        let (all, powers) = chromium_permissions(&m);
        assert!(all);
        assert_eq!(powers, vec!["cookies".to_string()]);
        assert_eq!(risk(all, &powers, true), "high");
        let m = json!({ "permissions": ["storage"], "content_scripts": [{ "matches": ["https://*/*"] }] });
        let (all, powers) = chromium_permissions(&m);
        assert_eq!((all, risk(all, &powers, true)), (true, "medium"));
        assert_eq!(risk(false, &[], true), "low");
        assert_eq!(risk(false, &[], false), "medium");
        assert_eq!(risk(true, &[], false), "high");
    }

    #[test]
    fn firefox_profile_addons() {
        let v = json!({ "addons": [
            { "id": "ublock@x", "type": "extension", "location": "app-profile", "active": true, "signedState": 2, "version": "1.0",
              "defaultLocale": { "name": "uBlock Origin" }, "userPermissions": { "permissions": ["webRequest", "storage"], "origins": ["<all_urls>"] } },
            { "id": "builtin@mozilla", "type": "extension", "location": "app-builtin" },
        ]});
        let mut out = Vec::new();
        firefox_addons(&v, "abc.default", &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].name.as_str(), out[0].risk, out[0].from_store), ("uBlock Origin", "high", true));
        assert!(!out[0].known, "an id it does not know stays unknown");
    }
}

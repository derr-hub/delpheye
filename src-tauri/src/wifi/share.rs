//! Sharing the Wi-Fi with guests: the network's name and password, as Windows keeps them for the
//! connection the computer is on, turned into the standard "WIFI:" QR code that phone cameras
//! join with one tap. Nothing leaves the computer.

use std::os::windows::process::CommandExt;
use std::process::Command;

use serde::Serialize;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub ssid: String,
    pub password: String,
    /// "WPA" (WPA2, or WPA2/WPA3), "SAE" (WPA3 only), "WEP" or "nopass".
    pub kind: &'static str,
    pub hidden: bool,
    /// What goes into the QR code.
    pub qr: String,
}

/// Backslash-escapes what the WIFI: format reserves.
fn esc(s: &str) -> String {
    s.chars().flat_map(|c| if matches!(c, '\\' | ';' | ',' | ':' | '"') { vec!['\\', c] } else { vec![c] }).collect()
}

pub fn qr_text(ssid: &str, password: &str, kind: &str, hidden: bool) -> String {
    let mut q = format!("WIFI:T:{kind};S:{};", esc(ssid));
    if kind != "nopass" {
        q.push_str(&format!("P:{};", esc(password)));
    }
    if hidden {
        q.push_str("H:true;");
    }
    q.push(';');
    q
}

/// Reads one saved profile's key in plain text (Windows hands it to the user who saved it).
fn profile(ssid: &str) -> Result<(String, &'static str, bool), String> {
    let dir = std::env::temp_dir().join(format!("delpheye-share-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let windows = crate::system::Dirs::real().map(|d| d.windows).ok_or("no-windows")?;
    let out = Command::new(windows.join(r"System32\netsh.exe"))
        .args(["wlan", "export", "profile", &format!("name={ssid}"), "key=clear", &format!("folder={}", dir.display())])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string());
    let xml = std::fs::read_dir(&dir).ok().and_then(|mut d| d.find_map(|e| e.ok())).and_then(|e| std::fs::read_to_string(e.path()).ok());
    let _ = std::fs::remove_dir_all(&dir);
    out?;
    let xml = xml.ok_or("no-profile")?;
    let doc = roxmltree::Document::parse(&xml).map_err(|e| e.to_string())?;
    let text = |name: &str| doc.descendants().find(|n| n.has_tag_name(name)).and_then(|n| n.text()).unwrap_or_default().trim().to_string();
    let auth = text("authentication");
    let protected = text("protected") == "true";
    let key = text("keyMaterial");
    let hidden = text("nonBroadcast") == "true";
    let kind = match auth.as_str() {
        "open" | "OWE" => "nopass",
        "WPA3SAE" | "WPA3" => "SAE",
        a if a.contains("WEP") || text("encryption") == "WEP" => "WEP",
        _ => "WPA",
    };
    if kind != "nopass" && (protected || key.is_empty()) {
        return Err("no-key".into());
    }
    Ok((key, kind, hidden))
}

/// The network the computer is on, ready to share.
#[tauri::command]
pub async fn wifi_share() -> Result<Share, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let link = super::link_now().ok_or("not-connected")?;
        let (password, kind, hidden) = profile(&link.ssid)?;
        Ok(Share { qr: qr_text(&link.ssid, &password, kind, hidden), ssid: link.ssid, password, kind, hidden })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_codes_escape_reserved_characters() {
        assert_eq!(qr_text("Home", "pa;ss", "WPA", false), "WIFI:T:WPA;S:Home;P:pa\\;ss;;");
        assert_eq!(qr_text("Cafe", "", "nopass", true), "WIFI:T:nopass;S:Cafe;H:true;;");
        assert_eq!(qr_text("a:b", "x\\y", "SAE", false), "WIFI:T:SAE;S:a\\:b;P:x\\\\y;;");
    }
}

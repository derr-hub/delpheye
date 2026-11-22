//! ASUS routers (Asuswrt and Asuswrt-Merlin): the same local web API the ASUS Router app uses.
//!
//! Login: POST /login.cgi with `login_authorization` = base64("user:password"); the answer carries
//! a session token (`asus_token`). Data: GET /appGet.cgi?hook=… with that token as a cookie.
//! Logout: GET /Logout.asp.
//!
//! Everything here only reads. The router guards its login: a captcha after two wrong passwords
//! and a lock after nine, so a login is tried exactly once per request from the user.

use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use serde_json::{Value, json};

/// The ASUS Router app's client name: with it the router answers in JSON and keeps the session
/// separate from a browser's, so the user's open router page is not logged out.
const APP_AGENT: &str = "asusrouter-Android-DUTUtil-1.0.0.245";

fn agent_as(user_agent: &str) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .http_status_as_error(false)
        .max_redirects(0)
        .user_agent(user_agent)
        .build()
        .into()
}

fn agent() -> ureq::Agent {
    agent_as(APP_AGENT)
}

/// What the login page says about earlier failed logins.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoginInfo {
    /// Wrong passwords in a row so far.
    pub errors: u32,
    /// The router asks for a captcha now (DelphEye cannot and will not answer it).
    pub captcha: bool,
    /// Seconds until a lock ends, if locked.
    pub locked_for: Option<u32>,
}

fn number_after(text: &str, key: &str) -> Option<i64> {
    let at = text.find(&format!("\"{key}\""))? + key.len() + 2;
    let rest = text[at..].trim_start_matches([':', ' ', '"']);
    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '-')).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// Reads `login_info = {...}` from Main_Login.asp.
pub fn parse_login_page(html: &str) -> LoginInfo {
    let errors = number_after(html, "error_num").unwrap_or(0).max(0) as u32;
    let status = number_after(html, "error_status").unwrap_or(0);
    let lock = number_after(html, "lock_time").unwrap_or(0);
    let captcha_enabled = !html.contains("captcha_enable = htmlEnDeCode.htmlEncode(decodeURIComponent('0'))");
    LoginInfo {
        errors,
        captcha: captcha_enabled && errors >= 2 && status != 7,
        locked_for: (status == 7 && lock > 0).then_some(lock as u32),
    }
}

pub fn login_page(host: &str) -> Result<LoginInfo, String> {
    // The browser page carries the failure count; the app answer does not.
    let mut r = agent_as("Mozilla/5.0 (Windows NT 10.0; Win64; x64) DelphEye").get(&format!("http://{host}/Main_Login.asp")).call().map_err(|e| e.to_string())?;
    let html = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
    Ok(parse_login_page(&html))
}

/// Is this an ASUS router? Only looks at the start page; answers with the model name, which ASUS
/// routers send to their app even before login (`Model_Name` header).
pub fn detect(host: &str) -> Option<String> {
    let mut r = agent().get(&format!("http://{host}/")).call().ok()?;
    let header = |k: &str| r.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    let (server, model, api) = (header("server").unwrap_or_default(), header("model_name"), header("aihomeapilevel"));
    let body = r.body_mut().read_to_string().unwrap_or_default();
    let asus = server.starts_with("httpd") && (api.is_some() || model.is_some() || body.contains("Main_Login.asp"));
    asus.then(|| model.unwrap_or_default())
}

#[derive(Debug, PartialEq)]
pub enum LoginError {
    Wrong,
    Captcha,
    Locked(Option<u32>),
    Unreachable(String),
    Other(String),
}

pub fn login(host: &str, user: &str, password: &str) -> Result<String, LoginError> {
    let auth = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
    let mut r = agent()
        .post(&format!("http://{host}/login.cgi"))
        .header("referer", &format!("http://{host}/Main_Login.asp"))
        .send_form([("login_authorization", auth.as_str())])
        .map_err(|e| LoginError::Unreachable(e.to_string()))?;
    let cookie_token = r
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|c| c.split(';').next()?.trim().strip_prefix("asus_token=").map(str::to_string));
    let body = r.body_mut().read_to_string().unwrap_or_default();
    let json: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if let Some(token) = json["asus_token"].as_str().map(str::to_string).or(cookie_token).filter(|t| !t.is_empty()) {
        return Ok(token);
    }
    let status = json["error_status"].as_str().and_then(|s| s.parse().ok()).or(json["error_status"].as_i64()).or_else(|| number_after(&body, "error_status"));
    Err(match status {
        Some(3) => LoginError::Wrong,
        Some(10) => LoginError::Captcha,
        Some(7) | Some(8) => LoginError::Locked(json["remaining_lock_time"].as_str().and_then(|s| s.parse().ok())),
        other => LoginError::Other(format!("status {other:?}")),
    })
}

pub fn logout(host: &str, token: &str) {
    let _ = agent().get(&format!("http://{host}/Logout.asp")).header("cookie", &format!("asus_token={token}")).call();
}

/// One appGet.cgi call. Err("expired") when the router no longer knows the token.
pub fn hook(host: &str, token: &str, hooks: &str) -> Result<Value, String> {
    let url = format!("http://{host}/appGet.cgi?hook={}", hooks.replace(' ', "%20"));
    let mut r = agent()
        .get(&url)
        .header("cookie", &format!("asus_token={token}"))
        .header("referer", &format!("http://{host}/index.asp"))
        .call()
        .map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    let body = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
    if status == 302 || status == 401 || body.contains("Main_Login.asp") {
        return Err("expired".into());
    }
    parse_loose(&body).ok_or_else(|| "unreadable".to_string())
}

/// appGet answers are almost JSON: trailing commas and raw newlines inside strings happen.
pub fn parse_loose(body: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str(body) {
        return Some(v);
    }
    let mut clean = String::with_capacity(body.len());
    let mut in_string = false;
    let mut escaped = false;
    for c in body.chars() {
        if in_string {
            match c {
                '\n' | '\r' => continue,
                '\\' if !escaped => escaped = true,
                '"' if !escaped => in_string = false,
                _ => escaped = false,
            }
            if c != '\\' {
                escaped = false;
            }
        } else if c == '"' {
            in_string = true;
        }
        clean.push(c);
    }
    let clean = clean.replace(",\n}", "\n}").replace(",}", "}").replace(",]", "]");
    serde_json::from_str(&clean).ok()
}

// ───────────────────────── what is read ─────────────────────────

/// Settings read from the router. Passwords and keys are never among them.
pub const NVRAM: &[&str] = &[
    "productid", "firmver", "buildno", "extendno", "lan_ipaddr", "http_username", "http_enable", "misc_http_x", "sshd_enable", "telnetd_enable",
    "wan0_upnp_enable", "fw_enable_x", "wps_enable", "smart_connect_x",
    "wl0_ssid", "wl1_ssid", "wl2_ssid", "wl0_chanspec", "wl1_chanspec", "wl2_chanspec", "wl0_bw", "wl1_bw", "wl2_bw", "wl0_nband", "wl1_nband", "wl2_nband",
    "wl0_auth_mode_x", "wl1_auth_mode_x", "wl2_auth_mode_x", "wl0_crypto", "wl1_crypto", "wl2_crypto", "wl0_closed", "wl1_closed", "wl2_closed",
    "wl0_radio", "wl1_radio", "wl2_radio",
    "wl0.1_bss_enabled", "wl0.1_ssid", "wl0.2_bss_enabled", "wl0.2_ssid", "wl0.3_bss_enabled", "wl0.3_ssid",
    "wl1.1_bss_enabled", "wl1.1_ssid", "wl1.2_bss_enabled", "wl1.2_ssid", "wl1.3_bss_enabled", "wl1.3_ssid",
    "wl2.1_bss_enabled", "wl2.1_ssid",
];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Radio {
    pub unit: u8,
    pub band: &'static str,
    pub ssid: String,
    pub enabled: bool,
    pub channel: Option<u32>,
    /// Channel chosen automatically by the router.
    pub auto: bool,
    pub width: Option<u32>,
    pub security: &'static str,
    pub tkip: bool,
    pub hidden: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Guest {
    pub band: &'static str,
    pub ssid: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    pub mac: String,
    pub name: String,
    pub ip: String,
    pub vendor: String,
    /// "wired", "2.4", "5", "6".
    pub link: &'static str,
    /// How loud the device is at the router, dBm (wireless only).
    pub rssi: Option<i32>,
    pub online: bool,
    pub connected_secs: Option<u64>,
    pub tx_mbps: Option<f32>,
    pub rx_mbps: Option<f32>,
    /// A private (randomised) address: phones and laptops do this per network.
    pub random_mac: bool,
    /// Connected to a guest network.
    pub guest: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: &'static str,
    /// "ok", "info", "warn", "risk".
    pub level: &'static str,
    pub values: Value,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub vendor: &'static str,
    pub model: String,
    pub firmware: String,
    pub host: String,
    pub uptime_secs: Option<u64>,
    pub radios: Vec<Radio>,
    pub guests: Vec<Guest>,
    pub clients: Vec<Client>,
    pub checks: Vec<Check>,
}

fn s(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::String(x) => x.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn band_of(unit: u8, nband: &str) -> &'static str {
    match nband {
        "2" => "2.4",
        "1" => "5",
        "4" => "6",
        _ => ["2.4", "5", "6"][unit.min(2) as usize],
    }
}

/// "100/80", "36/160", "6l" (40 MHz, lower), "149" → (channel, width).
pub fn chanspec(spec: &str) -> (Option<u32>, Option<u32>) {
    let spec = spec.trim();
    if spec.is_empty() || spec == "0" {
        return (None, None);
    }
    let spec = spec.trim_start_matches("6g");
    let (ch, width) = match spec.split_once('/') {
        Some((c, w)) => (c, w.parse().ok()),
        None if spec.ends_with('l') || spec.ends_with('u') => (&spec[..spec.len() - 1], Some(40)),
        None => (spec, Some(20)),
    };
    (ch.parse().ok(), width)
}

pub fn security(auth: &str, crypto: &str) -> (&'static str, bool) {
    let label = match auth {
        "open" => "open",
        "shared" => "wep",
        "psk" => "wpa",
        "pskpsk2" => "wpa",
        "psk2" => "wpa2",
        "psk2sae" => "wpa2-wpa3",
        "sae" => "wpa3",
        "owe" => "owe",
        a if a.starts_with("wpa") || a == "radius" => "enterprise",
        _ => "other",
    };
    (label, crypto.contains("tkip"))
}

/// "12:03:44" or "123:03:44" → seconds.
pub fn hms(text: &str) -> Option<u64> {
    let p: Vec<u64> = text.split(':').filter_map(|x| x.trim().parse().ok()).collect();
    (p.len() == 3).then(|| p[0] * 3600 + p[1] * 60 + p[2])
}

pub fn clients(list: &Value) -> Vec<Client> {
    let root = &list["get_clientlist"];
    let Some(map) = root.as_object() else { return Vec::new() };
    let mut out: Vec<Client> = map
        .iter()
        .filter(|(k, v)| k.contains(':') && v.is_object())
        .map(|(mac, v)| {
            let name = [s(v, "nickName"), s(v, "name")].into_iter().find(|x| !x.is_empty()).unwrap_or_default();
            let link = match s(v, "isWL").as_str() {
                "1" => "2.4",
                "2" | "3" => "5",
                "4" | "5" => "6",
                _ => "wired",
            };
            let num = |k: &str| s(v, k).parse::<f32>().ok().filter(|x| *x > 0.0);
            let first = u8::from_str_radix(mac.get(0..2).unwrap_or("00"), 16).unwrap_or(0);
            Client {
                mac: mac.to_uppercase(),
                name,
                ip: s(v, "ip"),
                vendor: s(v, "vendor"),
                link,
                rssi: s(v, "rssi").parse::<i32>().ok().filter(|r| *r < 0 && link != "wired"),
                online: s(v, "isOnline") == "1",
                connected_secs: hms(&s(v, "wlConnectTime")),
                tx_mbps: num("curTx"),
                rx_mbps: num("curRx"),
                random_mac: first & 0x02 != 0,
                guest: !s(v, "isGN").is_empty() && s(v, "isGN") != "0",
            }
        })
        .collect();
    out.sort_by(|a, b| b.online.cmp(&a.online).then(a.link.cmp(b.link)).then(b.rssi.cmp(&a.rssi)).then(a.name.cmp(&b.name)));
    out
}

pub fn overview(host: &str, nv: &Value, client_list: &Value, uptime: &Value) -> Overview {
    let mut radios = Vec::new();
    let mut guests = Vec::new();
    for unit in 0..3u8 {
        let ssid = s(nv, &format!("wl{unit}_ssid"));
        if ssid.is_empty() {
            continue;
        }
        let band = band_of(unit, &s(nv, &format!("wl{unit}_nband")));
        let spec = s(nv, &format!("wl{unit}_chanspec"));
        let (channel, width) = chanspec(&spec);
        let (security, tkip) = security(&s(nv, &format!("wl{unit}_auth_mode_x")), &s(nv, &format!("wl{unit}_crypto")));
        radios.push(Radio {
            unit,
            band,
            ssid,
            enabled: s(nv, &format!("wl{unit}_radio")) != "0",
            channel,
            auto: channel.is_none(),
            width,
            security,
            tkip,
            hidden: s(nv, &format!("wl{unit}_closed")) == "1",
        });
        for sub in 1..=3 {
            if s(nv, &format!("wl{unit}.{sub}_bss_enabled")) == "1" {
                guests.push(Guest { band, ssid: s(nv, &format!("wl{unit}.{sub}_ssid")) });
            }
        }
    }
    let uptime_secs = {
        let text = s(uptime, "uptime");
        text.split('(').nth(1).and_then(|x| x.split_whitespace().next()).and_then(|x| x.parse().ok())
    };
    let firmware = [s(nv, "firmver"), s(nv, "buildno"), s(nv, "extendno")].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(".");
    let clients = clients(client_list);
    let checks = checks(nv, &radios, &guests, &clients);
    Overview { vendor: "asus", model: s(nv, "productid"), firmware, host: host.to_string(), uptime_secs, radios, guests, clients, checks }
}

pub fn checks(nv: &Value, radios: &[Radio], guests: &[Guest], clients: &[Client]) -> Vec<Check> {
    let mut out = Vec::new();
    macro_rules! add {
        ($id:expr, $level:expr, $values:expr) => {
            out.push(Check { id: $id, level: $level, values: $values })
        };
    }
    if s(nv, "misc_http_x") == "1" {
        add!("wan-admin", "risk", json!({}));
    }
    match s(nv, "sshd_enable").as_str() {
        "1" => add!("ssh-wan", "risk", json!({})),
        "2" => add!("ssh-lan", "info", json!({})),
        _ => {}
    }
    if s(nv, "telnetd_enable") == "1" {
        add!("telnet-on", "warn", json!({}));
    }
    if s(nv, "fw_enable_x") == "0" {
        add!("firewall-off", "risk", json!({}));
    }
    for r in radios.iter().filter(|r| r.enabled) {
        match r.security {
            "open" => add!("radio-open", "risk", json!({ "ssid": r.ssid, "band": r.band })),
            "wep" | "wpa" => add!("radio-old", "risk", json!({ "ssid": r.ssid, "band": r.band })),
            _ if r.tkip => add!("radio-tkip", "warn", json!({ "ssid": r.ssid, "band": r.band })),
            _ => {}
        }
    }
    if s(nv, "wps_enable") == "1" {
        add!("wps-on", "warn", json!({}));
    }
    if !guests.is_empty() {
        let names: Vec<String> = guests.iter().map(|g| g.ssid.clone()).collect();
        add!("guest-on", "info", json!({ "names": names.join(", "), "count": guests.len() }));
    }
    if s(nv, "wan0_upnp_enable") == "1" {
        add!("upnp-on", "info", json!({}));
    }
    if s(nv, "http_username") == "admin" {
        add!("default-login", "info", json!({}));
    }
    if s(nv, "http_enable") == "0" {
        add!("http-only", "info", json!({}));
    }
    if radios.iter().any(|r| r.hidden) {
        add!("hidden-ssid", "info", json!({}));
    }
    let unnamed = clients.iter().filter(|c| c.online && c.name.is_empty()).count();
    if unnamed > 0 {
        add!("unnamed-clients", "info", json!({ "count": unnamed }));
    }
    if !out.iter().any(|c| c.level == "risk" || c.level == "warn") {
        add!("all-good", "ok", json!({}));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_page_counts_failures() {
        let page = r#"var login_info = { "lock_time": -29170, "error_status": 1, "last_time_lock_warning": 0, "error_num": 0, "page": "" };
            captcha_enable = htmlEnDeCode.htmlEncode(decodeURIComponent('1'));"#;
        assert_eq!(parse_login_page(page), LoginInfo { errors: 0, captcha: false, locked_for: None });
        let page = page.replace("\"error_num\": 0", "\"error_num\": 3");
        assert!(parse_login_page(&page).captcha);
        let locked = r#"{ "lock_time": 240, "error_status": 7, "error_num": 9 }"#;
        assert_eq!(parse_login_page(locked).locked_for, Some(240));
    }

    #[test]
    fn chanspecs_and_security() {
        assert_eq!(chanspec("100/80"), (Some(100), Some(80)));
        assert_eq!(chanspec("6l"), (Some(6), Some(40)));
        assert_eq!(chanspec("11"), (Some(11), Some(20)));
        assert_eq!(chanspec("0"), (None, None));
        assert_eq!(chanspec("6g37/160"), (Some(37), Some(160)));
        assert_eq!(security("psk2", "aes"), ("wpa2", false));
        assert_eq!(security("psk2sae", "aes"), ("wpa2-wpa3", false));
        assert_eq!(security("pskpsk2", "tkip+aes"), ("wpa", true));
        assert_eq!(hms("123:04:05"), Some(123 * 3600 + 245));
    }

    #[test]
    fn loose_json_is_read() {
        let v = parse_loose("{\n\"productid\":\"RT-AX58U\",\n\"firmver\":\"3.0.0.4\",\n}").unwrap();
        assert_eq!(v["productid"], "RT-AX58U");
        let v = parse_loose("{\"name\":\"two\nlines\"}").unwrap();
        assert_eq!(v["name"], "twolines");
    }

    #[test]
    fn overview_from_router_answers() {
        let nv = json!({
            "productid": "RT-AX58U", "firmver": "3.0.0.4", "buildno": "388", "extendno": "24231",
            "wl0_ssid": "KARID", "wl0_chanspec": "6", "wl0_auth_mode_x": "psk2", "wl0_crypto": "aes", "wl0_nband": "2",
            "wl1_ssid": "KARID", "wl1_chanspec": "100/80", "wl1_auth_mode_x": "psk2", "wl1_crypto": "aes", "wl1_nband": "1",
            "wl1.1_bss_enabled": "1", "wl1.1_ssid": "ASUS_70_5G_Guest", "wps_enable": "1", "misc_http_x": "0", "http_username": "admin",
        });
        let cl = json!({ "get_clientlist": {
            "AA:BB:CC:00:00:01": { "name": "Phone", "nickName": "", "ip": "192.168.50.20", "isWL": "2", "rssi": "-48", "isOnline": "1", "wlConnectTime": "01:02:03", "vendor": "Samsung" },
            "DA:BB:CC:00:00:02": { "name": "", "ip": "192.168.50.21", "isWL": "0", "rssi": "0", "isOnline": "1" },
            "maclist": ["AA:BB:CC:00:00:01"]
        }});
        let up = json!({ "uptime": "Sun, 22 Nov 2026 12:00:00 +0200(86400 secs since boot)" });
        let o = overview("192.168.50.1", &nv, &cl, &up);
        assert_eq!((o.model.as_str(), o.firmware.as_str(), o.uptime_secs), ("RT-AX58U", "3.0.0.4.388.24231", Some(86400)));
        assert_eq!(o.radios.len(), 2);
        assert_eq!((o.radios[1].band, o.radios[1].channel, o.radios[1].width), ("5", Some(100), Some(80)));
        assert_eq!(o.guests.len(), 1);
        assert_eq!(o.clients.len(), 2);
        let wired = o.clients.iter().find(|c| c.link == "wired").unwrap();
        assert_eq!(wired.rssi, None);
        assert!(wired.random_mac);
        let phone = o.clients.iter().find(|c| c.name == "Phone").unwrap();
        assert_eq!((phone.link, phone.rssi, phone.connected_secs), ("5", Some(-48), Some(3723)));
        let ids: Vec<&str> = o.checks.iter().map(|c| c.id).collect();
        assert!(ids.contains(&"wps-on") && ids.contains(&"guest-on") && ids.contains(&"default-login") && ids.contains(&"unnamed-clients"));
        assert!(!ids.contains(&"all-good"));
    }
}

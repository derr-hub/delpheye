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

/// Hooks in a query: the router reads only the first hook unless the separator is encoded.
fn encode(hooks: &str) -> String {
    hooks.replace(' ', "%20").replace(';', "%3B")
}

/// One appGet.cgi call. Err("expired") when the router no longer knows the token.
pub fn hook(host: &str, token: &str, hooks: &str) -> Result<Value, String> {
    let url = format!("http://{host}/appGet.cgi?hook={}", encode(hooks));
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

/// A hook whose answer is one long text (the system log): its lines are kept as they are, which
/// the JSON reading would not do.
pub fn hook_text(host: &str, token: &str, hooks: &str) -> Result<String, String> {
    let mut r = agent()
        .get(&format!("http://{host}/appGet.cgi?hook={}", encode(hooks)))
        .header("cookie", &format!("asus_token={token}"))
        .header("referer", &format!("http://{host}/index.asp"))
        .call()
        .map_err(|e| e.to_string())?;
    let body = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
    if body.contains("Main_Login.asp") {
        return Err("expired".into());
    }
    // {"name":…text…} — the text is not quoted and has quotes of its own, so it is cut from after
    // the key to the closing brace, not between quotes.
    let start = body.find("\":").map(|i| i + 2).unwrap_or(0);
    let mut text = body[start..].trim_start_matches(['"', ' ']);
    if let Some(e) = text.rfind('}') {
        text = &text[..e];
    }
    Ok(text.trim_end().trim_end_matches('"').to_string())
}

#[cfg(debug_assertions)]
pub fn raw(host: &str, token: &str, hooks: &str) -> Result<String, String> {
    let mut r = agent()
        .get(&format!("http://{host}/appGet.cgi?hook={}", encode(hooks)))
        .header("cookie", &format!("asus_token={token}"))
        .header("referer", &format!("http://{host}/index.asp"))
        .call()
        .map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    Ok(format!("{status}
{}", r.body_mut().read_to_string().map_err(|e| e.to_string())?))
}

/// The only changes DelphEye makes on a router, each with its exact settings and the service
/// the router restarts to apply them. `guest` names the guest network, e.g. "wl1.1".
/// A channel setting as the router writes it: "0" (auto), "149", "6l", "100/80".
pub fn valid_spec(spec: &str) -> bool {
    if spec == "0" {
        return true;
    }
    let (ch, rest) = match spec.split_once('/') {
        Some((c, w)) => (c, Some(w)),
        None => (spec.trim_end_matches(['l', 'u']), None),
    };
    let ch_ok = !ch.is_empty() && ch.len() <= 3 && ch.bytes().all(|b| b.is_ascii_digit()) && ch.parse::<u32>().is_ok_and(|c| (1..=233).contains(&c));
    let width_ok = rest.is_none_or(|w| ["20", "40", "80", "160"].contains(&w));
    let suffix_ok = spec.split_once('/').is_some() || spec.trim_end_matches(['l', 'u']).len() + 1 >= spec.len();
    ch_ok && width_ok && suffix_ok
}

pub fn change(action: &str, guest: Option<&str>) -> Option<(Vec<(String, String)>, &'static str)> {
    if let Some(rest) = action.strip_prefix("channel:") {
        // "channel:<unit>:<spec>", e.g. "channel:1:149/80".
        let (unit, spec) = rest.split_once(':')?;
        let unit: u8 = unit.parse().ok().filter(|u| *u <= 2)?;
        if !valid_spec(spec) {
            return None;
        }
        return Some((vec![(format!("wl{unit}_chanspec"), spec.to_string())], "restart_wireless"));
    }
    let set = |k: &str, v: &str| vec![(k.to_string(), v.to_string())];
    Some(match action {
        "wps-off" => (set("wps_enable", "0"), "restart_wireless"),
        "wps-on" => (set("wps_enable", "1"), "restart_wireless"),
        "upnp-off" => (set("wan0_upnp_enable", "0"), "restart_upnp"),
        "upnp-on" => (set("wan0_upnp_enable", "1"), "restart_upnp"),
        "guest-off" | "guest-on" => {
            let id = guest?;
            // Only names of the form wlN.M — nothing else ever reaches the router.
            let valid = id.len() == 5 && id.starts_with("wl") && id.as_bytes()[2].is_ascii_digit() && id.as_bytes()[3] == b'.' && id.as_bytes()[4].is_ascii_digit();
            if !valid {
                return None;
            }
            (set(&format!("{id}_bss_enabled"), if action == "guest-off" { "0" } else { "1" }), "restart_wireless")
        }
        _ => return None,
    })
}

/// Applies settings through applyapp.cgi, the endpoint the ASUS app uses.
pub fn apply(host: &str, token: &str, values: &[(String, String)], service: &str) -> Result<(), String> {
    let mut form: Vec<(&str, &str)> = vec![("action_mode", "apply"), ("rc_service", service)];
    form.extend(values.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    let mut r = agent()
        .post(&format!("http://{host}/applyapp.cgi"))
        .header("cookie", &format!("asus_token={token}"))
        .header("referer", &format!("http://{host}/index.asp"))
        .send_form(form)
        .map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    let body = r.body_mut().read_to_string().unwrap_or_default();
    if status == 302 || status == 401 || body.contains("Main_Login.asp") {
        return Err("expired".into());
    }
    if status != 200 {
        return Err(format!("status {status}"));
    }
    Ok(())
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
    "vts_enable_x", "vts_rulelist", "wl0_macmode", "wl0_maclist_x", "wl1_macmode", "wl1_maclist_x", "wl2_macmode", "wl2_maclist_x",
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
    /// The router's own channel setting, kept to put it back after a change.
    pub spec: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Guest {
    /// The router's name for it, e.g. "wl1.1".
    pub id: String,
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

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Traffic {
    /// Byte counters since the router started (they wrap around on some firmware).
    pub internet_rx: u64,
    pub internet_tx: u64,
    pub wired_rx: u64,
    pub wired_tx: u64,
    pub wireless_rx: u64,
    pub wireless_tx: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    pub name: String,
    pub external: String,
    pub ip: String,
    pub internal: String,
    pub protocol: String,
    /// Opened by a program through UPnP rather than set by hand.
    pub upnp: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// As the router writes it, e.g. "Nov 22 17:48:24".
    pub at: String,
    pub mac: String,
    /// "join" or "leave".
    pub kind: &'static str,
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
    pub traffic: Traffic,
    pub ports: Vec<Port>,
    /// Addresses the Wi-Fi MAC filter keeps out.
    pub blocked: Vec<String>,
    /// The filter only lets listed devices in: blocking one more is not offered then.
    pub allow_list: bool,
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

fn hex(v: &Value, k: &str) -> u64 {
    v[k].as_str().and_then(|x| u64::from_str_radix(x.trim_start_matches("0x"), 16).ok()).unwrap_or(0)
}

pub fn traffic(netdev: &Value) -> Traffic {
    let n = &netdev["netdev"];
    Traffic {
        internet_rx: hex(n, "INTERNET_rx"),
        internet_tx: hex(n, "INTERNET_tx"),
        wired_rx: hex(n, "WIRED_rx"),
        wired_tx: hex(n, "WIRED_tx"),
        wireless_rx: (0..4).map(|k| hex(n, &format!("WIRELESS{k}_rx"))).sum(),
        wireless_tx: (0..4).map(|k| hex(n, &format!("WIRELESS{k}_tx"))).sum(),
    }
}

/// `vts_rulelist`: "<name>ext>ip>int>proto>src<name>…" (fields after `<`, split by `>`).
pub fn port_forwards(list: &str) -> Vec<Port> {
    list.split('<')
        .filter(|r| !r.is_empty())
        .filter_map(|r| {
            let f: Vec<&str> = r.split('>').collect();
            (f.len() >= 5).then(|| Port { name: f[0].into(), external: f[1].into(), ip: f[2].into(), internal: f[3].into(), protocol: f[4].into(), upnp: false })
        })
        .collect()
}

/// get_upnp_array(): [[proto, ext port, ip, int port, description], …] when anything is open.
pub fn upnp(v: &Value) -> Vec<Port> {
    let arr = v.as_array().or_else(|| v["get_upnp_array"].as_array()).cloned().unwrap_or_default();
    arr.iter()
        .filter_map(|r| {
            let f: Vec<String> = r.as_array()?.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).collect();
            (f.len() >= 4).then(|| Port { name: f.get(4).cloned().unwrap_or_default(), external: f[1].clone(), ip: f[2].clone(), internal: f[3].clone(), protocol: f[0].clone(), upnp: true })
        })
        .collect()
}

/// Join and leave lines from the router's system log, newest last. Understands MediaTek
/// ("New Sta:… associated", "Del Sta:…", "Recv Disassoc/Deauth") and Broadcom (wlceventd) wording.
pub fn events(log: &str) -> Vec<Event> {
    let mac_after = |line: &str, marker: &str| -> Option<String> {
        let at = line.find(marker)? + marker.len();
        let rest = line[at..].trim_start_matches([' ', ':', '-']);
        let mac: String = rest.chars().take(17).collect();
        (mac.len() == 17 && mac.chars().filter(|c| *c == ':').count() == 5).then(|| mac.to_uppercase())
    };
    let mut out: Vec<Event> = Vec::new();
    for line in log.lines() {
        let at: String = line.chars().take(15).collect();
        let lower = line.to_lowercase();
        let found = if let Some(m) = mac_after(line, "New Sta:") {
            Some((m, "join"))
        } else if let Some(m) = mac_after(line, "Del Sta:") {
            Some((m, "leave"))
        } else if lower.contains("wlceventd") && (lower.contains(": assoc ") || lower.contains(": reassoc ")) {
            line.split_whitespace().find(|w| w.len() >= 17 && w.chars().filter(|c| *c == ':').count() == 5).map(|w| (w[..17].to_uppercase(), "join"))
        } else if lower.contains("wlceventd") && (lower.contains("disassoc") || lower.contains("deauth")) {
            line.split_whitespace().find(|w| w.len() >= 17 && w.chars().filter(|c| *c == ':').count() == 5).map(|w| (w[..17].to_uppercase(), "leave"))
        } else {
            None
        };
        if let Some((mac, kind)) = found {
            // One connection is logged in several lines: keep it once.
            if !out.last().is_some_and(|e| e.mac == mac && e.kind == kind && e.at == at) {
                out.push(Event { at, mac, kind });
            }
        }
    }
    // The log holds older rotated files too, not always in order: sort by the timestamp.
    out.sort_by_key(|e| sortable(&e.at));
    let keep = out.len().saturating_sub(300);
    out.split_off(keep)
}

/// "Nov 22 17:48:24" → "11-22 17:48:24" (the year is not in the log).
pub fn sortable(at: &str) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let mut parts = at.split_whitespace();
    let (m, d, t) = (parts.next().unwrap_or(""), parts.next().unwrap_or("0"), parts.next().unwrap_or(""));
    let month = MONTHS.iter().position(|x| *x == m).map(|i| i + 1).unwrap_or(0);
    format!("{month:02}-{:0>2} {t}", d)
}

fn mac_list(list: &str) -> Vec<String> {
    list.split('<').map(|m| m.trim().to_uppercase()).filter(|m| m.len() == 17).collect()
}

/// A MAC address as the router writes it.
pub fn valid_mac(m: &str) -> bool {
    m.len() == 17 && m.split(':').count() == 6 && m.split(':').all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// The settings that add (block) or remove (unblock) one address from each radio's MAC filter.
/// None when a radio's filter is an allow-list: adding to it would change who may join at all.
pub fn mac_filter(nv: &Value, mac: &str, block: bool) -> Option<Vec<(String, String)>> {
    if !valid_mac(mac) {
        return None;
    }
    let mac = mac.to_uppercase();
    let mut values = Vec::new();
    for unit in 0..3 {
        if s(nv, &format!("wl{unit}_ssid")).is_empty() {
            continue;
        }
        let mode = s(nv, &format!("wl{unit}_macmode"));
        if mode == "allow" {
            return None;
        }
        let mut list = mac_list(&s(nv, &format!("wl{unit}_maclist_x")));
        list.retain(|m| *m != mac);
        if block {
            list.push(mac.clone());
        }
        let joined: String = list.iter().map(|m| format!("<{m}")).collect();
        values.push((format!("wl{unit}_maclist_x"), joined));
        values.push((format!("wl{unit}_macmode"), if list.is_empty() { "disabled".to_string() } else { "deny".to_string() }));
    }
    (!values.is_empty()).then_some(values)
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
            spec: spec.clone(),
        });
        for sub in 1..=3 {
            if s(nv, &format!("wl{unit}.{sub}_bss_enabled")) == "1" {
                guests.push(Guest { id: format!("wl{unit}.{sub}"), band, ssid: s(nv, &format!("wl{unit}.{sub}_ssid")) });
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
    let mut ports = if s(nv, "vts_enable_x") == "1" { port_forwards(&s(nv, "vts_rulelist")) } else { Vec::new() };
    ports.retain(|p| !p.external.is_empty());
    let mut blocked: Vec<String> = Vec::new();
    for unit in 0..3 {
        if s(nv, &format!("wl{unit}_macmode")) == "deny" {
            for m in mac_list(&s(nv, &format!("wl{unit}_maclist_x"))) {
                if !blocked.contains(&m) {
                    blocked.push(m);
                }
            }
        }
    }
    let allow_list = (0..3).any(|u| s(nv, &format!("wl{u}_macmode")) == "allow");
    Overview {
        vendor: "asus",
        model: s(nv, "productid"),
        firmware,
        host: host.to_string(),
        uptime_secs,
        radios,
        guests,
        clients,
        checks,
        traffic: Traffic::default(),
        ports,
        blocked,
        allow_list,
    }
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
    fn channel_changes_are_checked() {
        assert_eq!(change("channel:1:149/80", None).unwrap().0, vec![("wl1_chanspec".to_string(), "149/80".to_string())]);
        assert!(change("channel:1:0", None).is_some());
        assert!(change("channel:0:6l", None).is_some());
        assert!(change("channel:3:36", None).is_none());
        assert!(change("channel:1:36/81", None).is_none());
        assert!(change("channel:1:36&wps_enable=1", None).is_none());
        assert!(change("channel:1:999", None).is_none());
    }

    #[test]
    fn only_known_changes_reach_the_router() {
        assert_eq!(change("wps-off", None).unwrap(), (vec![("wps_enable".into(), "0".into())], "restart_wireless"));
        assert_eq!(change("guest-off", Some("wl1.1")).unwrap().0, vec![("wl1.1_bss_enabled".to_string(), "0".to_string())]);
        assert!(change("guest-off", Some("wl1.1_ssid=x&a")).is_none());
        assert!(change("guest-off", None).is_none());
        assert!(change("reboot", None).is_none());
    }

    #[test]
    fn router_log_and_counters() {
        let log = "Nov 22 17:48:24 kernel: 7981@C13L2rax0,MacTableInsertEntry() 1586: New Sta:d0:65:78:35:ea:e9 associated at aid 3\n\
Nov 22 17:48:24 kernel: 7981@C08L3rax0,ap_cmm_peer_assoc_req_action() 1714:  Recv Assoc from STA - d0:65:78:35:ea:e9\n\
Nov 22 18:02:10 kernel: 7981@C13L2rax0,MacTableDeleteEntry() 1900: Del Sta:d0:65:78:35:ea:e9\n\
Nov 22 18:05:01 wlceventd: wlceventd_proc_event(530): eth6: Assoc AA:BB:CC:DD:EE:FF, status: Successful (0), rssi:-60\n\
Nov 22 18:06:01 wlceventd: wlceventd_proc_event(494): eth6: Disassoc AA:BB:CC:DD:EE:FF, status: 0, reason: Disassociated due to inactivity (4)";
        let e = events(log);
        assert_eq!(e.len(), 4, "{e:?}");
        assert_eq!(sortable("Nov  5 08:07:33"), "11-05 08:07:33");
        assert_eq!((e[0].kind, e[0].mac.as_str(), e[0].at.as_str()), ("join", "D0:65:78:35:EA:E9", "Nov 22 17:48:24"));
        assert_eq!(e[1].kind, "leave");
        assert_eq!((e[2].kind, e[3].kind), ("join", "leave"));
        let t = traffic(&json!({ "netdev": { "INTERNET_rx": "0x10", "INTERNET_tx": "0x20", "WIRELESS0_rx": "0x1", "WIRELESS1_rx": "0x2" } }));
        assert_eq!((t.internet_rx, t.internet_tx, t.wireless_rx), (16, 32, 3));
        assert_eq!(port_forwards("<web>8080>192.168.50.10>80>TCP><ssh>2222>192.168.50.11>22>TCP>")[1].internal, "22");
        assert!(upnp(&json!({})).is_empty());
    }

    #[test]
    fn mac_filter_adds_and_removes_safely() {
        let nv = json!({ "wl1_ssid": "KARID", "wl1_macmode": "disabled", "wl1_maclist_x": "" });
        let v = mac_filter(&nv, "aa:bb:cc:dd:ee:ff", true).unwrap();
        assert!(v.contains(&("wl1_maclist_x".into(), "<AA:BB:CC:DD:EE:FF".into())) && v.contains(&("wl1_macmode".into(), "deny".into())));
        let nv = json!({ "wl1_ssid": "KARID", "wl1_macmode": "deny", "wl1_maclist_x": "<AA:BB:CC:DD:EE:FF<11:22:33:44:55:66" });
        let v = mac_filter(&nv, "AA:BB:CC:DD:EE:FF", false).unwrap();
        assert!(v.contains(&("wl1_maclist_x".into(), "<11:22:33:44:55:66".into())) && v.contains(&("wl1_macmode".into(), "deny".into())));
        assert!(mac_filter(&json!({ "wl1_ssid": "X", "wl1_macmode": "allow" }), "AA:BB:CC:DD:EE:FF", true).is_none());
        assert!(mac_filter(&nv, "AA:BB:CC:DD:EE:FF&x=1", true).is_none());
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

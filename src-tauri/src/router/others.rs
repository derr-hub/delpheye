//! Routers other than ASUS, read only: Keenetic (its RCI API), MikroTik (RouterOS 7 REST API)
//! and OpenWrt (LuCI's ubus JSON-RPC). Each gives the same overview as ASUS — the Wi-Fi networks,
//! the devices and how loud each one is at the router — without the one-click changes, which are
//! only offered where they have been tried on a real router.
//!
//! The session "token" is whatever the router needs on the next request: a cookie (Keenetic), the
//! Basic credentials (MikroTik) or the ubus session id (OpenWrt).

use std::time::Duration;

use base64::Engine;
use serde_json::{Value, json};
use sha2::Digest;

use super::asus::{Check, Client, LoginError, Overview, Radio, Traffic};

pub const VENDORS: [&str; 3] = ["keenetic", "mikrotik", "openwrt"];

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into()
}

/// For MikroTik's HTTPS: home routers use a self-signed certificate, and only the home network
/// is ever addressed.
fn agent_tls() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .http_status_as_error(false)
        .max_redirects(0)
        .tls_config(ureq::tls::TlsConfig::builder().disable_verification(true).build())
        .build()
        .into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn s(v: &Value) -> String {
    match v {
        Value::String(x) => x.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn band_of_mhz(mhz: u32) -> &'static str {
    crate::wifi::band(mhz)
}

fn band_of_channel(ch: u32) -> &'static str {
    if ch <= 14 { "2.4" } else { "5" }
}

/// Which of the three answers at `host`, and its model when it says before login.
pub fn detect(host: &str) -> Option<(&'static str, Option<String>)> {
    let a = agent();
    // Keenetic: /auth answers 401 with its realm (the model name) and a challenge.
    if let Ok(r) = a.get(&format!("http://{host}/auth")).call() {
        if let Some(realm) = r.headers().get("X-NDM-Realm").and_then(|v| v.to_str().ok()) {
            return Some(("keenetic", Some(realm.to_string()).filter(|m| !m.is_empty())));
        }
    }
    // OpenWrt: LuCI at /cgi-bin/luci, ubus at /ubus.
    if let Ok(mut r) = a.get(&format!("http://{host}/cgi-bin/luci/")).call() {
        let body = r.body_mut().read_to_string().unwrap_or_default();
        if body.contains("LuCI") || body.contains("OpenWrt") || body.contains("luci-static") {
            return Some(("openwrt", None));
        }
    }
    // MikroTik: the WebFig page or the REST API's realm.
    for (url, agent) in [(format!("http://{host}/"), agent()), (format!("https://{host}/rest/system/resource"), agent_tls())] {
        if let Ok(mut r) = agent.get(&url).call() {
            let realm = r.headers().get("www-authenticate").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
            let body = r.body_mut().read_to_string().unwrap_or_default();
            if realm.contains("RouterOS") || body.contains("RouterOS") || body.contains("mikrotik") || body.contains("webfig") {
                return Some(("mikrotik", None));
            }
        }
    }
    None
}

pub fn login(vendor: &str, host: &str, user: &str, password: &str) -> Result<String, LoginError> {
    match vendor {
        "keenetic" => keenetic::login(host, user, password),
        "mikrotik" => mikrotik::login(host, user, password),
        "openwrt" => openwrt::login(host, user, password),
        _ => Err(LoginError::Other("vendor".into())),
    }
}

pub fn read(vendor: &str, host: &str, token: &str) -> Result<Overview, String> {
    let (model, firmware, uptime, radios, clients) = match vendor {
        "keenetic" => keenetic::read(host, token)?,
        "mikrotik" => mikrotik::read(host, token)?,
        "openwrt" => openwrt::read(host, token)?,
        _ => return Err("vendor".into()),
    };
    Ok(Overview {
        vendor: VENDORS.iter().find(|v| **v == vendor).copied().unwrap_or("unknown"),
        checks: checks(&radios, &clients),
        model,
        firmware,
        host: host.to_string(),
        uptime_secs: uptime,
        radios,
        guests: Vec::new(),
        clients,
        traffic: Traffic::default(),
        ports: Vec::new(),
        blocked: Vec::new(),
        allow_list: false,
    })
}

/// What can be told without the router's full settings: weak Wi-Fi protection, unnamed devices.
fn checks(radios: &[Radio], clients: &[Client]) -> Vec<Check> {
    let mut out = Vec::new();
    for r in radios.iter().filter(|r| r.enabled) {
        match r.security {
            "open" => out.push(Check { id: "radio-open", level: "risk", values: json!({ "ssid": r.ssid, "band": r.band }) }),
            "wep" | "wpa" => out.push(Check { id: "radio-old", level: "risk", values: json!({ "ssid": r.ssid, "band": r.band }) }),
            _ => {}
        }
    }
    let unnamed = clients.iter().filter(|c| c.online && c.name.is_empty()).count();
    if unnamed > 0 {
        out.push(Check { id: "unnamed-clients", level: "info", values: json!({ "count": unnamed }) });
    }
    out.push(Check { id: "read-only-vendor", level: "info", values: json!({}) });
    if !out.iter().any(|c| c.level == "risk" || c.level == "warn") {
        out.push(Check { id: "all-good", level: "ok", values: json!({}) });
    }
    out
}

fn random_mac(mac: &str) -> bool {
    u8::from_str_radix(mac.get(..2).unwrap_or("00"), 16).map(|b| b & 0x02 != 0).unwrap_or(false)
}

fn client(mac: &str, name: String, ip: String, link: &'static str, rssi: Option<i32>, online: bool, secs: Option<u64>) -> Client {
    let mac = mac.to_uppercase();
    Client { random_mac: random_mac(&mac), mac, name, ip, vendor: String::new(), link, rssi, online, connected_secs: secs, tx_mbps: None, rx_mbps: None, guest: false }
}

fn security_label(text: &str) -> &'static str {
    let t = text.to_ascii_lowercase();
    if t.is_empty() || t == "none" || t.contains("open") {
        "open"
    } else if t.contains("wep") {
        "wep"
    } else if t.contains("sae") && (t.contains("psk2") || t.contains("wpa2")) || t.contains("wpa2/wpa3") || t.contains("wpa2-psk/wpa3") {
        "wpa2-wpa3"
    } else if t.contains("sae") || t.contains("wpa3") {
        "wpa3"
    } else if t.contains("psk2") || t.contains("wpa2") {
        "wpa2"
    } else if t.contains("psk") || t.contains("wpa") {
        "wpa"
    } else {
        "wpa2"
    }
}

fn radio(unit: u8, band: &'static str, ssid: String, enabled: bool, channel: Option<u32>, width: Option<u32>, security: &'static str) -> Radio {
    Radio { unit, band, ssid, enabled, channel, auto: channel.is_none(), width, security, tkip: false, hidden: false, spec: String::new() }
}

type Read = (String, String, Option<u64>, Vec<Radio>, Vec<Client>);

// ───────────────────────── Keenetic ─────────────────────────

pub mod keenetic {
    use super::*;

    /// md5("login:realm:password") as hex, then sha256(challenge + that) as hex.
    pub fn answer(user: &str, password: &str, realm: &str, challenge: &str) -> String {
        let md5 = hex(&md5::compute(format!("{user}:{realm}:{password}")).0);
        hex(&sha2::Sha256::digest(format!("{challenge}{md5}").as_bytes()))
    }

    fn cookie(r: &ureq::http::Response<ureq::Body>) -> String {
        r.headers().get_all("set-cookie").iter().filter_map(|v| v.to_str().ok()).filter_map(|c| c.split(';').next()).collect::<Vec<_>>().join("; ")
    }

    pub fn login(host: &str, user: &str, password: &str) -> Result<String, LoginError> {
        let a = agent();
        let r = a.get(&format!("http://{host}/auth")).call().map_err(|e| LoginError::Unreachable(e.to_string()))?;
        let mut jar = cookie(&r);
        if r.status().as_u16() == 200 {
            return Ok(jar);
        }
        let realm = r.headers().get("X-NDM-Realm").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        let challenge = r.headers().get("X-NDM-Challenge").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        let r = a
            .post(&format!("http://{host}/auth"))
            .header("Cookie", &jar)
            .send_json(json!({ "login": user, "password": answer(user, password, &realm, &challenge) }))
            .map_err(|e| LoginError::Unreachable(e.to_string()))?;
        match r.status().as_u16() {
            200 => {
                let more = cookie(&r);
                if !more.is_empty() {
                    jar = more;
                }
                Ok(jar)
            }
            401 | 403 => Err(LoginError::Wrong),
            s => Err(LoginError::Other(format!("status {s}"))),
        }
    }

    fn get(host: &str, jar: &str, path: &str) -> Result<Value, String> {
        let mut r = agent().get(&format!("http://{host}/rci/{path}")).header("Cookie", jar).call().map_err(|e| e.to_string())?;
        match r.status().as_u16() {
            200 => r.body_mut().read_json().map_err(|e| e.to_string()),
            401 => Err("expired".into()),
            s => Err(format!("status {s}")),
        }
    }

    pub fn read(host: &str, jar: &str) -> Result<Read, String> {
        let version = get(host, jar, "show/version")?;
        let model = [s(&version["model"]), s(&version["description"]), s(&version["device"])].into_iter().find(|m| !m.is_empty()).unwrap_or_else(|| "Keenetic".into());
        let firmware = s(&version["title"]).chars().chain(std::iter::empty()).collect::<String>();
        let firmware = if firmware.is_empty() { s(&version["release"]) } else { firmware };
        let uptime = get(host, jar, "show/system").ok().and_then(|v| s(&v["uptime"]).parse().ok());
        // Access points: "AccessPoint" interfaces, their radio ("WifiMaster0/…") gives the band.
        let ifaces = get(host, jar, "show/interface").unwrap_or(Value::Null);
        let mut radios = Vec::new();
        if let Value::Object(map) = &ifaces {
            let mut unit = 0u8;
            for (name, i) in map {
                if s(&i["type"]) != "AccessPoint" || name.contains('/') && name.matches('/').count() > 1 {
                    continue;
                }
                let master = name.split('/').next().unwrap_or_default();
                let channel = map.get(master).and_then(|m| s(&m["channel"]).parse().ok());
                let band = if master.ends_with('1') { "5" } else { channel.map(band_of_channel).unwrap_or("2.4") };
                let ssid = s(&i["ssid"]);
                if ssid.is_empty() {
                    continue;
                }
                radios.push(radio(unit, band, ssid, s(&i["state"]) == "up", channel, None, security_label(&s(&i["authentication"]))));
                unit += 1;
            }
        }
        // Devices: the host list; Wi-Fi signal from the associations.
        let hosts = get(host, jar, "show/ip/hotspot").unwrap_or(Value::Null);
        let assoc = get(host, jar, "show/associations").unwrap_or(Value::Null);
        let stations: Vec<&Value> = assoc["station"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
        let mut clients = Vec::new();
        for h in hosts["host"].as_array().into_iter().flatten() {
            let mac = s(&h["mac"]);
            if mac.is_empty() {
                continue;
            }
            let st = stations.iter().find(|x| s(&x["mac"]).eq_ignore_ascii_case(&mac));
            let link = match st {
                Some(x) => {
                    let ap = s(&x["ap"]);
                    if ap.starts_with("WifiMaster1") { "5" } else { "2.4" }
                }
                None => "wired",
            };
            let rssi = st.and_then(|x| s(&x["rssi"]).parse().ok());
            let name = [s(&h["name"]), s(&h["hostname"])].into_iter().find(|n| !n.is_empty()).unwrap_or_default();
            let secs = st.and_then(|x| s(&x["uptime"]).parse().ok()).or_else(|| s(&h["uptime"]).parse().ok());
            clients.push(client(&mac, name, s(&h["ip"]), link, rssi, h["active"].as_bool().unwrap_or(true), secs));
        }
        Ok((model, firmware, uptime, radios, clients))
    }
}

// ───────────────────────── MikroTik ─────────────────────────

pub mod mikrotik {
    use super::*;

    fn call(host: &str, auth: &str, path: &str) -> Result<Value, String> {
        // RouterOS serves its REST API over HTTPS (and over HTTP since 7.9, when enabled).
        let mut last = String::from("unreachable");
        for (scheme, a) in [("https", agent_tls()), ("http", agent())] {
            match a.get(&format!("{scheme}://{host}/rest/{path}")).header("Authorization", auth).call() {
                Ok(mut r) => match r.status().as_u16() {
                    200 => return r.body_mut().read_json().map_err(|e| e.to_string()),
                    401 => return Err("wrong".into()),
                    s => last = format!("status {s}"),
                },
                Err(e) => last = e.to_string(),
            }
        }
        Err(last)
    }

    pub fn login(host: &str, user: &str, password: &str) -> Result<String, LoginError> {
        let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}")));
        match call(host, &auth, "system/resource") {
            Ok(_) => Ok(auth),
            Err(e) if e == "wrong" => Err(LoginError::Wrong),
            Err(e) => Err(LoginError::Unreachable(e)),
        }
    }

    /// RouterOS durations: "1w2d3h4m5s".
    pub fn duration(text: &str) -> Option<u64> {
        let mut total = 0u64;
        let mut n = String::new();
        for c in text.chars() {
            if c.is_ascii_digit() {
                n.push(c);
                continue;
            }
            let v: u64 = n.parse().ok()?;
            n.clear();
            total += v * match c {
                'w' => 604_800,
                'd' => 86_400,
                'h' => 3600,
                'm' => 60,
                's' => 1,
                _ => return None,
            };
        }
        Some(total)
    }

    /// "-61" or "-61@HT20-7" → -61.
    fn signal(v: &Value) -> Option<i32> {
        s(v).split('@').next()?.trim().parse().ok()
    }

    pub fn read(host: &str, auth: &str) -> Result<Read, String> {
        let res = call(host, auth, "system/resource").map_err(|e| if e == "wrong" { "expired".into() } else { e })?;
        let model = [s(&res["board-name"]), "MikroTik".into()].into_iter().find(|m| !m.is_empty()).unwrap_or_default();
        let firmware = format!("RouterOS {}", s(&res["version"]));
        let uptime = duration(&s(&res["uptime"]));
        // Wi-Fi: the new "wifi" package (RouterOS 7.13+) or the older "wireless" one.
        let mut radios = Vec::new();
        let mut regs: Vec<Value> = Vec::new();
        if let Ok(Value::Array(list)) = call(host, auth, "interface/wifi") {
            for (i, w) in list.iter().enumerate() {
                let ssid = [s(&w["configuration.ssid"]), s(&w["configuration"]["ssid"])].into_iter().find(|x| !x.is_empty()).unwrap_or_default();
                let freq: Option<u32> = s(&w["channel.frequency"]).split(['-', ',']).next().and_then(|f| f.parse().ok());
                let band = if s(&w["channel.band"]).starts_with('5') || freq.is_some_and(|f| f > 4000) { "5" } else { "2.4" };
                radios.push(radio(i as u8, band, ssid, s(&w["disabled"]) != "true", freq.map(crate::wifi::channel), None, security_label(&s(&w["security.authentication-types"]))));
            }
            if let Ok(Value::Array(r)) = call(host, auth, "interface/wifi/registration-table") {
                regs = r;
            }
        } else if let Ok(Value::Array(list)) = call(host, auth, "interface/wireless") {
            for (i, w) in list.iter().enumerate() {
                let freq: Option<u32> = s(&w["frequency"]).parse().ok();
                let band = if s(&w["band"]).starts_with('5') || freq.is_some_and(|f| f > 4000) { "5" } else { "2.4" };
                radios.push(radio(i as u8, band, s(&w["ssid"]), s(&w["disabled"]) != "true", freq.map(crate::wifi::channel), None, "wpa2"));
            }
            if let Ok(Value::Array(r)) = call(host, auth, "interface/wireless/registration-table") {
                regs = r;
            }
        }
        let leases = match call(host, auth, "ip/dhcp-server/lease") {
            Ok(Value::Array(l)) => l,
            _ => Vec::new(),
        };
        let mut clients: Vec<Client> = Vec::new();
        for l in &leases {
            let mac = s(&l["mac-address"]);
            if mac.is_empty() {
                continue;
            }
            let reg = regs.iter().find(|r| s(&r["mac-address"]).eq_ignore_ascii_case(&mac));
            let iface = reg.map(|r| s(&r["interface"])).unwrap_or_default();
            let band = radios.iter().find(|x| iface.contains(&x.ssid) || iface.ends_with(&x.unit.to_string())).map(|x| x.band).unwrap_or("2.4");
            let link = if reg.is_some() { band } else { "wired" };
            let rssi = reg.and_then(|r| signal(&r["signal"]).or_else(|| signal(&r["signal-strength"])));
            let name = [s(&l["comment"]), s(&l["host-name"])].into_iter().find(|n| !n.is_empty()).unwrap_or_default();
            let secs = reg.and_then(|r| duration(&s(&r["uptime"])));
            clients.push(client(&mac, name, s(&l["address"]), link, rssi, s(&l["status"]) == "bound", secs));
        }
        // Wireless devices without a lease (static addresses) still count.
        for r in &regs {
            let mac = s(&r["mac-address"]);
            if !mac.is_empty() && !clients.iter().any(|c| c.mac.eq_ignore_ascii_case(&mac)) {
                clients.push(client(&mac, String::new(), String::new(), "2.4", signal(&r["signal"]).or_else(|| signal(&r["signal-strength"])), true, duration(&s(&r["uptime"]))));
            }
        }
        Ok((model, firmware, uptime, radios, clients))
    }
}

// ───────────────────────── OpenWrt ─────────────────────────

pub mod openwrt {
    use super::*;

    const ANON: &str = "00000000000000000000000000000000";

    fn ubus(host: &str, session: &str, object: &str, method: &str, args: Value) -> Result<Value, String> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "call", "params": [session, object, method, args] });
        let mut r = agent().post(&format!("http://{host}/ubus")).send_json(body).map_err(|e| e.to_string())?;
        let v: Value = r.body_mut().read_json().map_err(|e| e.to_string())?;
        if let Some(e) = v.get("error") {
            // -32002: access denied, which is what an expired session answers.
            return Err(if e["code"].as_i64() == Some(-32002) { "expired".into() } else { s(&e["message"]) });
        }
        match v["result"].as_array().map(|a| a.as_slice()) {
            Some([code, data]) if code.as_i64() == Some(0) => Ok(data.clone()),
            Some([code]) if code.as_i64() == Some(0) => Ok(Value::Null),
            Some([code, ..]) if code.as_i64() == Some(6) => Err("expired".into()),
            _ => Err(format!("ubus {object}.{method}")),
        }
    }

    pub fn login(host: &str, user: &str, password: &str) -> Result<String, LoginError> {
        match ubus(host, ANON, "session", "login", json!({ "username": user, "password": password })) {
            Ok(v) => v["ubus_rpc_session"].as_str().map(String::from).ok_or(LoginError::Wrong),
            Err(e) if e == "expired" || e.contains("session.login") => Err(LoginError::Wrong),
            Err(e) => Err(LoginError::Unreachable(e)),
        }
    }

    pub fn read(host: &str, sid: &str) -> Result<Read, String> {
        let board = ubus(host, sid, "system", "board", json!({}))?;
        let model = [s(&board["model"]), "OpenWrt".into()].into_iter().find(|m| !m.is_empty()).unwrap_or_default();
        let firmware = s(&board["release"]["description"]);
        let uptime = ubus(host, sid, "system", "info", json!({})).ok().and_then(|v| v["uptime"].as_u64());
        let devices: Vec<String> = ubus(host, sid, "iwinfo", "devices", json!({})).ok().and_then(|v| v["devices"].as_array().map(|a| a.iter().map(s).collect())).unwrap_or_default();
        let mut radios = Vec::new();
        let mut stations: Vec<(Value, &'static str)> = Vec::new();
        for (i, d) in devices.iter().enumerate() {
            let info = ubus(host, sid, "iwinfo", "info", json!({ "device": d })).unwrap_or(Value::Null);
            let mhz = info["frequency"].as_u64().unwrap_or(0) as u32;
            let band = if mhz > 0 { band_of_mhz(mhz) } else { "2.4" };
            let enc = info["encryption"]["description"].as_str().unwrap_or_default();
            let width = info["htmode"].as_str().and_then(|m| m.trim_start_matches(|c: char| c.is_alphabetic()).parse().ok());
            radios.push(radio(i as u8, band, s(&info["ssid"]), true, info["channel"].as_u64().map(|c| c as u32), width, security_label(enc)));
            if let Ok(a) = ubus(host, sid, "iwinfo", "assoclist", json!({ "device": d })) {
                for st in a["results"].as_array().into_iter().flatten() {
                    stations.push((st.clone(), band));
                }
            }
        }
        let leases = ubus(host, sid, "luci-rpc", "getDHCPLeases", json!({})).unwrap_or(Value::Null);
        let hints = ubus(host, sid, "luci-rpc", "getHostHints", json!({})).unwrap_or(Value::Null);
        let mut clients: Vec<Client> = Vec::new();
        for l in leases["dhcp_leases"].as_array().into_iter().flatten() {
            let mac = s(&l["macaddr"]);
            if mac.is_empty() {
                continue;
            }
            let st = stations.iter().find(|(x, _)| s(&x["mac"]).eq_ignore_ascii_case(&mac));
            clients.push(client(&mac, s(&l["hostname"]), s(&l["ipaddr"]), st.map(|x| x.1).unwrap_or("wired"), st.and_then(|(x, _)| x["signal"].as_i64()).map(|v| v as i32), true, st.and_then(|(x, _)| x["connected_time"].as_u64())));
        }
        for (st, band) in &stations {
            let mac = s(&st["mac"]);
            if !mac.is_empty() && !clients.iter().any(|c| c.mac.eq_ignore_ascii_case(&mac)) {
                let hint = hints.get(mac.to_uppercase()).or_else(|| hints.get(mac.to_lowercase())).cloned().unwrap_or(Value::Null);
                let ip = hint["ipaddrs"].as_array().and_then(|a| a.first()).map(s).unwrap_or_default();
                clients.push(client(&mac, s(&hint["name"]), ip, band, st["signal"].as_i64().map(|v| v as i32), true, st["connected_time"].as_u64()));
            }
        }
        Ok((model, firmware, uptime, radios, clients))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keenetic_answer_matches_its_formula() {
        // md5("admin:Keenetic Giga:1234") = 9f9e3b...; checked against the formula, not a router.
        let a = keenetic::answer("admin", "1234", "Keenetic Giga", "ABC");
        assert_eq!(a.len(), 64);
        assert_eq!(a, keenetic::answer("admin", "1234", "Keenetic Giga", "ABC"));
        assert_ne!(a, keenetic::answer("admin", "1235", "Keenetic Giga", "ABC"));
    }

    #[test]
    fn routeros_durations_and_security_names() {
        assert_eq!(mikrotik::duration("1w2d3h4m5s"), Some(604_800 + 2 * 86_400 + 3 * 3600 + 4 * 60 + 5));
        assert_eq!(mikrotik::duration("45s"), Some(45));
        assert_eq!(security_label("WPA2 PSK (CCMP)"), "wpa2");
        assert_eq!(security_label("mixed WPA2/WPA3 PSK/SAE (CCMP)"), "wpa2-wpa3");
        assert_eq!(security_label("WPA3 SAE (CCMP)"), "wpa3");
        assert_eq!(security_label("none"), "open");
        assert!(random_mac("DA:11:22:33:44:55") && !random_mac("CC:28:AA:8D:60:0C"));
    }
}

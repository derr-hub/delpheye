//! The link to DelphEye Companion on the user's Android phone.
//!
//! While the user has pairing open, DelphEye listens on the home network. The phone first proves it
//! was shown the 6-digit code (from the screen or the QR code) and receives a token; with that it
//! sends a frame every second: the Wi-Fi it hears, its compass heading and its step count. Only
//! private (home-network) addresses are answered; five wrong codes replace the code.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, State};

pub const PORT: u16 = 47811;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Heard {
    pub bssid: String,
    #[serde(default)]
    pub ssid: String,
    pub rssi: i32,
    #[serde(default)]
    pub freq: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    /// Phone clock, Unix ms.
    pub t: i64,
    /// Compass heading, degrees clockwise from north, when the phone has one.
    pub heading: Option<f32>,
    /// Steps since the app started.
    #[serde(default)]
    pub steps: u32,
    /// The latest Wi-Fi scan (Android limits how often scans run), and when it was taken.
    #[serde(default)]
    pub scan: Vec<Heard>,
    #[serde(default)]
    pub scan_at: Option<i64>,
    /// The network the phone is on and its live signal.
    pub link_bssid: Option<String>,
    pub link_rssi: Option<i32>,
}

#[derive(Default)]
struct Shared {
    code: String,
    token: Option<String>,
    device: Option<String>,
    wrong: u32,
    last_frame_ms: i64,
}

#[derive(Default)]
pub struct CompanionState {
    running: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub addresses: Vec<String>,
    pub port: u16,
    pub code: String,
    /// What the QR code holds.
    pub link: String,
    pub paired: bool,
    pub device: Option<String>,
}

fn random_digits(n: usize) -> String {
    let mut seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(7) as u64 ^ std::process::id() as u64;
    (0..n)
        .map(|_| {
            // xorshift: plenty for a short-lived pairing code shown on screen.
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            char::from(b'0' + (seed % 10) as u8)
        })
        .collect()
}

fn token() -> String {
    format!("{}{}", random_digits(16), random_digits(16))
}

pub fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local() || v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// The computer's addresses on the home network, Wi-Fi and cable.
fn local_addresses() -> Vec<String> {
    let mut v: Vec<String> = crate::network::lan_ipv4().into_iter().filter(|ip| ip.is_private()).map(|ip| ip.to_string()).collect();
    v.dedup();
    v
}

fn respond(stream: &mut TcpStream, status: u16, body: &Value) {
    let text = body.to_string();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        _ => "Not Found",
    };
    let _ = write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n{text}", text.len());
}

/// One request: the method, the path and the JSON body (at most 256 KB).
fn read_request(stream: &mut TcpStream) -> Option<(String, String, Value)> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next()?.to_string(), parts.next()?.to_string());
    let mut length = 0usize;
    loop {
        let mut h = String::new();
        reader.read_line(&mut h).ok()?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                length = v.trim().parse().unwrap_or(0);
            }
        }
    }
    if length > 256 * 1024 {
        return None;
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    let json = if body.is_empty() { Value::Null } else { serde_json::from_slice(&body).ok()? };
    Some((method, path, json))
}

fn handle(app: &AppHandle, shared: &Arc<Mutex<Shared>>, mut stream: TcpStream, peer: SocketAddr) {
    crate::errlog::write("companion", &format!("connection from {peer}"));
    if !private(peer.ip()) {
        respond(&mut stream, 403, &json!({ "error": "not-home-network" }));
        return;
    }
    let Some((method, path, body)) = read_request(&mut stream) else {
        crate::errlog::write("companion", &format!("unreadable request from {peer}"));
        respond(&mut stream, 400, &json!({ "error": "bad-request" }));
        return;
    };
    // Pairing steps only: frames come every second.
    if path == "/hello" || path == "/pair" {
        crate::errlog::write("companion", &format!("{method} {path} from {peer}"));
    }
    match (method.as_str(), path.as_str()) {
        ("GET", "/hello") => respond(&mut stream, 200, &json!({ "app": "delpheye", "version": env!("CARGO_PKG_VERSION") })),
        ("POST", "/pair") => {
            let mut s = shared.lock().unwrap();
            let code = body["code"].as_str().unwrap_or_default();
            if !s.code.is_empty() && code == s.code {
                let t = token();
                s.token = Some(t.clone());
                s.device = body["device"].as_str().map(|d| d.chars().take(60).collect());
                s.wrong = 0;
                drop(s);
                crate::errlog::write("companion", "phone paired");
                let _ = app.emit("phone:paired", ());
                respond(&mut stream, 200, &json!({ "token": t }));
            } else {
                s.wrong += 1;
                if s.wrong >= 5 {
                    s.code = random_digits(6);
                    s.wrong = 0;
                    let _ = app.emit("phone:code", s.code.clone());
                }
                respond(&mut stream, 401, &json!({ "error": "wrong-code" }));
            }
        }
        ("POST", "/frame") => {
            let ok = {
                let s = shared.lock().unwrap();
                s.token.is_some() && s.token.as_deref() == body["token"].as_str()
            };
            if !ok {
                respond(&mut stream, 401, &json!({ "error": "not-paired" }));
                return;
            }
            match serde_json::from_value::<Frame>(body["frame"].clone()) {
                Ok(frame) => {
                    shared.lock().unwrap().last_frame_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
                    let _ = app.emit("phone:frame", &frame);
                    respond(&mut stream, 200, &json!({}));
                }
                Err(_) => respond(&mut stream, 400, &json!({ "error": "bad-frame" })),
            }
        }
        _ => respond(&mut stream, 404, &json!({ "error": "not-found" })),
    }
}

fn pairing(state: &CompanionState) -> Pairing {
    let s = state.shared.lock().unwrap();
    let addresses = local_addresses();
    let first = addresses.first().cloned().unwrap_or_else(|| Ipv4Addr::LOCALHOST.to_string());
    Pairing {
        link: format!("delpheye://pair?h={}&p={PORT}&c={}", addresses.join(","), s.code),
        addresses: if addresses.is_empty() { vec![first] } else { addresses },
        port: PORT,
        code: s.code.clone(),
        paired: s.token.is_some(),
        device: s.device.clone(),
    }
}

/// Opens the link (if not open yet) and returns what the phone needs to find it.
#[tauri::command]
pub fn companion_start(app: AppHandle, state: State<'_, CompanionState>) -> Result<Pairing, String> {
    {
        let mut s = state.shared.lock().unwrap();
        if s.code.is_empty() {
            s.code = random_digits(6);
        }
    }
    if !state.running.swap(true, Ordering::SeqCst) {
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, PORT)).map_err(|e| {
            state.running.store(false, Ordering::SeqCst);
            format!("port-busy: {e}")
        })?;
        let (running, shared) = (state.running.clone(), state.shared.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                if let Ok(stream) = conn {
                    let peer = stream.peer_addr().unwrap_or_else(|_| SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)));
                    let (app, shared) = (app.clone(), shared.clone());
                    std::thread::spawn(move || handle(&app, &shared, stream, peer));
                }
            }
        });
        crate::errlog::write("companion", "pairing open");
    }
    Ok(pairing(&state))
}

#[tauri::command]
pub fn companion_state(state: State<'_, CompanionState>) -> Pairing {
    pairing(&state)
}

/// Closes the link and forgets the phone's token: it must pair again.
#[tauri::command]
pub fn companion_stop(state: State<'_, CompanionState>) {
    if state.running.swap(false, Ordering::SeqCst) {
        // Wake the listener so it sees it should stop.
        let _ = TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, PORT)), Duration::from_millis(300));
    }
    let mut s = state.shared.lock().unwrap();
    s.token = None;
    s.device = None;
    s.code.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_home_addresses() {
        assert!(private("192.168.50.10".parse().unwrap()));
        assert!(private("10.0.0.5".parse().unwrap()));
        assert!(!private("8.8.8.8".parse().unwrap()));
        assert!(!private("100.64.0.1".parse().unwrap()));
    }

    #[test]
    fn frames_parse() {
        let f: Frame = serde_json::from_value(json!({ "t": 1, "heading": 90.5, "steps": 12, "scan": [{ "bssid": "AA", "rssi": -50 }], "linkBssid": "AA", "linkRssi": -48 })).unwrap();
        assert_eq!((f.steps, f.scan.len(), f.link_rssi), (12, 1, Some(-48)));
        assert_eq!(random_digits(6).len(), 6);
    }
}

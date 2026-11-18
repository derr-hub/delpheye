//! The network in detail: how the machine is connected, which programs talk to which servers,
//! how much each one moves, what is open to the network, and which connections deserve a look.

mod win;

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::State;

use crate::processes::{self, Level};

const LISTEN: u32 = 2;
const ESTABLISHED: u32 = 5;
/// Reverse look-ups started per refresh, so a burst of new servers cannot flood DNS.
const LOOKUPS_PER_CALL: usize = 24;

#[derive(Default)]
pub struct NetworkState {
    /// Bytes counted per connection at the last refresh, for rates.
    last: Mutex<HashMap<String, (u64, u64, Instant)>>,
    /// Host names found for remote addresses; `None` once a look-up found nothing.
    names: Arc<Mutex<HashMap<IpAddr, Option<String>>>>,
    resolving: Arc<Mutex<HashSet<IpAddr>>>,
}

/// Local network, loopback and link-local addresses never leave the building.
pub fn is_private(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() || v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]),
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback() || v6.is_unspecified() || (first & 0xffc0) == 0xfe80 || (first & 0xfe00) == 0xfc00 || v6.to_ipv4_mapped().is_some_and(|v4| is_private(&IpAddr::V4(v4)))
        }
    }
}

/// What a well-known remote port is used for.
pub fn service(port: u16) -> Option<&'static str> {
    Some(match port {
        80 | 8080 => "http",
        443 | 8443 => "https",
        53 | 853 => "dns",
        22 => "ssh",
        21 => "ftp",
        25 | 465 | 587 | 993 | 995 | 143 | 110 => "mail",
        3389 => "rdp",
        445 | 139 => "smb",
        5222 | 5223 | 5228 | 5229 | 5230 => "push",
        3478..=3481 | 19302..=19309 | 50000..=50019 => "voice",
        27015..=27050 => "steam",
        1194 | 51820 => "vpn",
        6881..=6889 => "torrent",
        _ => return None,
    })
}

/// Ports that ordinary software rarely talks to but remote-control tools, IRC bots, Tor and
/// crypto miners do.
pub fn odd_port(port: u16) -> bool {
    matches!(port, 1337 | 31337 | 4444 | 5555 | 6666..=6669 | 6697 | 9001 | 9030 | 9050 | 3333 | 14444 | 5050 | 8333 | 12345 | 54321)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conn {
    pub remote: String,
    pub ip: String,
    pub port: u16,
    pub host: Option<String>,
    pub service: Option<&'static str>,
    pub public: bool,
    /// Bytes per second; `None` without administrator rights.
    pub rx: Option<u64>,
    pub tx: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub pid: u32,
    pub start: u64,
    pub name: String,
    pub exe: Option<String>,
    pub description: Option<String>,
    pub company: Option<String>,
    pub level: Level,
    pub known: Option<&'static str>,
    pub connections: Vec<Conn>,
    pub rx: Option<u64>,
    pub tx: Option<u64>,
    /// Why this program's network use deserves a look, most serious first.
    pub concerns: Vec<&'static str>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Listener {
    pub pid: u32,
    pub name: String,
    pub exe: Option<String>,
    pub port: u16,
    /// Reachable from other machines (bound to every address), not just this one.
    pub exposed: bool,
    pub level: Level,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    elevated: bool,
    adapters: Vec<win::Adapter>,
    wifi: Vec<win::Wifi>,
    apps: Vec<App>,
    listeners: Vec<Listener>,
}

fn rate(last: &mut HashMap<String, (u64, u64, Instant)>, key: &str, now: (u64, u64)) -> (u64, u64) {
    let at = Instant::now();
    let rates = match last.get(key) {
        Some((rx, tx, then)) => {
            let secs = at.duration_since(*then).as_secs_f64().max(0.2);
            ((now.0.saturating_sub(*rx) as f64 / secs) as u64, (now.1.saturating_sub(*tx) as f64 / secs) as u64)
        }
        None => (0, 0),
    };
    last.insert(key.to_string(), (now.0, now.1, at));
    rates
}

/// Why a program's connections deserve a look. Pure, so it can be tested.
pub fn concerns(exe: Option<&str>, level: Level, impostor: bool, signed: Option<bool>, public_ports: &[u16]) -> Vec<&'static str> {
    let mut out = Vec::new();
    if public_ports.is_empty() {
        return out;
    }
    if impostor {
        out.push("impostor");
    }
    let path = exe.unwrap_or_default().to_lowercase();
    if ["\\temp\\", "\\downloads\\", "\\users\\public\\"].iter().any(|p| path.contains(p)) {
        out.push("temp");
    }
    if public_ports.iter().any(|p| odd_port(*p)) {
        out.push("odd-port");
    }
    let installed = path.contains("\\program files") || path.contains("\\windows\\") || path.contains("\\windowsapps\\");
    if signed == Some(false) && !installed && level == Level::App {
        out.push("unsigned");
    }
    out
}

fn lookup_names(state: &NetworkState, wanted: Vec<IpAddr>) {
    let fresh: Vec<IpAddr> = {
        let names = state.names.lock().unwrap();
        let mut resolving = state.resolving.lock().unwrap();
        wanted.into_iter().filter(|ip| !names.contains_key(ip) && resolving.insert(*ip)).take(LOOKUPS_PER_CALL).collect()
    };
    if fresh.is_empty() {
        return;
    }
    let (names, resolving) = (state.names.clone(), state.resolving.clone());
    std::thread::spawn(move || {
        for ip in fresh {
            let name = win::reverse(ip);
            names.lock().unwrap().insert(ip, name);
            resolving.lock().unwrap().remove(&ip);
        }
    });
}

fn snapshot(state: &NetworkState) -> Snapshot {
    let elevated = crate::system::is_elevated();
    let rows = processes::rows();
    let by_pid: HashMap<u32, &processes::Row> = rows.iter().map(|r| (r.pid, r)).collect();
    let sockets = win::tcp();

    let mut apps: HashMap<u32, App> = HashMap::new();
    let mut listeners = Vec::new();
    let mut public_ips = Vec::new();
    let mut last = state.last.lock().unwrap();
    let mut seen_keys = HashSet::new();
    let names = state.names.lock().unwrap().clone();

    for s in &sockets {
        let row = by_pid.get(&s.pid);
        let name = row.map(|r| r.name.clone()).unwrap_or_else(|| if s.pid == 4 { "System".into() } else { format!("PID {}", s.pid) });
        if s.state == LISTEN {
            listeners.push(Listener {
                pid: s.pid,
                name,
                exe: row.and_then(|r| r.exe.clone()),
                port: s.local.port(),
                exposed: s.local.ip().is_unspecified(),
                level: row.map_or(Level::Windows, |r| r.level),
            });
            continue;
        }
        if s.state != ESTABLISHED || s.remote.ip().is_loopback() {
            continue;
        }
        let public = !is_private(&s.remote.ip());
        if public {
            public_ips.push(s.remote.ip());
        }
        let key = format!("{}>{}", s.local, s.remote);
        seen_keys.insert(key.clone());
        let (rx, tx) = if elevated {
            if !last.contains_key(&key) {
                win::enable_counting(s);
            }
            match win::counted(s) {
                Some(bytes) => {
                    let (r, t) = rate(&mut last, &key, bytes);
                    (Some(r), Some(t))
                }
                None => (Some(0), Some(0)),
            }
        } else {
            (None, None)
        };
        let app = apps.entry(s.pid).or_insert_with(|| App {
            pid: s.pid,
            start: row.map_or(0, |r| r.start),
            name: name.clone(),
            exe: row.and_then(|r| r.exe.clone()),
            description: row.and_then(|r| r.description.clone()),
            company: row.and_then(|r| r.company.clone()),
            level: row.map_or(Level::Windows, |r| r.level),
            known: row.and_then(|r| r.known),
            connections: Vec::new(),
            rx: elevated.then_some(0),
            tx: elevated.then_some(0),
            concerns: Vec::new(),
        });
        if let (Some(a), Some(r)) = (app.rx.as_mut(), rx) {
            *a += r;
        }
        if let (Some(a), Some(t)) = (app.tx.as_mut(), tx) {
            *a += t;
        }
        app.connections.push(Conn {
            remote: s.remote.to_string(),
            ip: s.remote.ip().to_string(),
            port: s.remote.port(),
            host: names.get(&s.remote.ip()).cloned().flatten(),
            service: service(s.remote.port()),
            public,
            rx,
            tx,
        });
    }
    last.retain(|k, _| seen_keys.contains(k));
    drop(last);

    for app in apps.values_mut() {
        let row = by_pid.get(&app.pid);
        let ports: Vec<u16> = app.connections.iter().filter(|c| c.public).map(|c| c.port).collect();
        let signed = app.exe.as_deref().filter(|_| !ports.is_empty()).and_then(|e| processes::signed(std::path::Path::new(e)));
        app.concerns = concerns(app.exe.as_deref(), app.level, row.is_some_and(|r| r.impostor), signed, &ports);
        app.connections.sort_by(|a, b| b.rx.unwrap_or(0).cmp(&a.rx.unwrap_or(0)).then(b.public.cmp(&a.public)).then(a.remote.cmp(&b.remote)));
    }
    let mut apps: Vec<App> = apps.into_values().collect();
    apps.sort_by(|a, b| {
        (b.rx.unwrap_or(0) + b.tx.unwrap_or(0))
            .cmp(&(a.rx.unwrap_or(0) + a.tx.unwrap_or(0)))
            .then(b.connections.len().cmp(&a.connections.len()))
    });
    listeners.sort_by(|a, b| b.exposed.cmp(&a.exposed).then(a.port.cmp(&b.port)));
    listeners.dedup_by(|a, b| a.pid == b.pid && a.port == b.port);

    public_ips.sort();
    public_ips.dedup();
    lookup_names(state, public_ips);

    let mut adapters = win::adapters();
    adapters.retain(|a| a.kind != "loopback" && !(a.description.contains("Kernel Debug") || a.description.contains("WAN Miniport")));
    adapters.sort_by(|a, b| b.up.cmp(&a.up).then((b.received + b.sent).cmp(&(a.received + a.sent))));
    Snapshot { elevated, adapters, wifi: win::wifi(), apps, listeners }
}

#[tauri::command]
pub async fn network_snapshot(state: State<'_, Arc<NetworkState>>) -> Result<Snapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || snapshot(&state)).await.map_err(|e| e.to_string())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    target: String,
    /// Average round trip in ms over the answers that came.
    avg_ms: Option<u32>,
    /// Share of probes without an answer, in percent.
    loss: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    gateway: Option<Probe>,
    internet: Vec<Probe>,
    dns_ms: Option<u32>,
    /// "good", "slow-local", "slow-internet", "no-internet", "dns" or "no-network".
    verdict: &'static str,
}

fn probe(target: Ipv4Addr, count: u32) -> Probe {
    let times: Vec<u32> = (0..count).filter_map(|_| win::ping(target, 1000)).collect();
    Probe {
        target: target.to_string(),
        avg_ms: (!times.is_empty()).then(|| times.iter().sum::<u32>() / times.len() as u32),
        loss: (count - times.len() as u32) * 100 / count,
    }
}

pub fn verdict(gateway: Option<&Probe>, internet: &[Probe], dns_ms: Option<u32>) -> &'static str {
    let best = internet.iter().filter_map(|p| p.avg_ms).min();
    let loss = internet.iter().map(|p| p.loss).min().unwrap_or(100);
    match (gateway, best) {
        (None, None) => "no-network",
        (Some(g), _) if g.avg_ms.is_none() => "no-network",
        (_, None) => "no-internet",
        (Some(g), Some(_)) if g.avg_ms.unwrap_or(0) > 30 || g.loss >= 25 => "slow-local",
        (_, Some(ms)) if ms > 120 || loss >= 25 => "slow-internet",
        _ if dns_ms.is_none_or(|d| d > 300) => "dns",
        _ => "good",
    }
}

/// Pings the router and two public resolvers and times a DNS look-up: where is it slow?
#[tauri::command]
pub async fn network_check() -> Result<Check, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let gateway = win::adapters()
            .into_iter()
            .filter(|a| a.up && a.kind != "vpn")
            .flat_map(|a| a.gateways)
            .find_map(|g| g.parse::<Ipv4Addr>().ok())
            .map(|g| probe(g, 4));
        let internet = vec![probe(Ipv4Addr::new(1, 1, 1, 1), 4), probe(Ipv4Addr::new(8, 8, 8, 8), 4)];
        let dns_ms = win::dns_time("www.microsoft.com");
        let verdict = verdict(gateway.as_ref(), &internet, dns_ms);
        Check { gateway, internet, dns_ms, verdict }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_public_addresses() {
        for ip in ["192.168.1.1", "10.0.0.5", "172.20.1.1", "127.0.0.1", "169.254.3.3", "100.64.0.1", "::1", "fe80::1", "fd00::1"] {
            assert!(is_private(&ip.parse().unwrap()), "{ip}");
        }
        for ip in ["140.82.112.4", "8.8.8.8", "2606:4700::1111"] {
            assert!(!is_private(&ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn concerns_need_a_public_connection() {
        assert!(concerns(Some(r"C:\Users\x\Downloads\a.exe"), Level::App, false, Some(false), &[]).is_empty());
        assert_eq!(concerns(Some(r"C:\Users\x\Downloads\a.exe"), Level::App, false, Some(false), &[4444]), vec!["temp", "odd-port", "unsigned"]);
        assert_eq!(concerns(Some(r"C:\Program Files\App\a.exe"), Level::App, false, Some(false), &[443]), Vec::<&str>::new(), "installed programs are not flagged for a missing signature");
        assert_eq!(concerns(Some(r"C:\Users\x\AppData\Local\a.exe"), Level::App, true, Some(true), &[443]), vec!["impostor"]);
    }

    fn p(avg: Option<u32>, loss: u32) -> Probe {
        Probe { target: String::new(), avg_ms: avg, loss }
    }

    #[test]
    fn the_check_says_where_it_is_slow() {
        assert_eq!(verdict(Some(&p(Some(3), 0)), &[p(Some(20), 0), p(Some(25), 0)], Some(30)), "good");
        assert_eq!(verdict(Some(&p(Some(80), 0)), &[p(Some(120), 0)], Some(30)), "slow-local");
        assert_eq!(verdict(Some(&p(Some(3), 0)), &[p(Some(200), 0)], Some(30)), "slow-internet");
        assert_eq!(verdict(Some(&p(Some(3), 0)), &[p(None, 100)], None), "no-internet");
        assert_eq!(verdict(Some(&p(None, 100)), &[p(None, 100)], None), "no-network");
        assert_eq!(verdict(Some(&p(Some(3), 0)), &[p(Some(20), 0)], Some(900)), "dns");
    }

    #[test]
    fn rates_come_from_the_difference() {
        let mut last = HashMap::new();
        assert_eq!(rate(&mut last, "k", (1000, 500)), (0, 0));
        std::thread::sleep(std::time::Duration::from_millis(250));
        let (rx, tx) = rate(&mut last, "k", (2000, 500));
        assert!(rx > 2000 && rx <= 4000, "{rx}");
        assert_eq!(tx, 0);
    }
}

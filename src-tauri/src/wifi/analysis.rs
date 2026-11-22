//! What the list of access points means for the user's own network.
//!
//! Interference on a stretch of spectrum is the summed power (in mW) of every *other* network
//! overlapping it, weighted by how much of the stretch it covers. Only networks with a different
//! name count: the user's own router's other radios and mesh nodes coordinate with each other.

use serde::Serialize;
use serde_json::{Value, json};

use super::{Bss, Link};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChannelLoad {
    /// Primary channel to set on the router.
    pub channel: u32,
    pub width: u32,
    pub low_mhz: u32,
    pub high_mhz: u32,
    /// Summed interference, dBm (−100 when nothing overlaps).
    pub interference: f32,
    /// Networks overlapping it.
    pub networks: u32,
    /// Needs radar detection (DFS): the router may wait a minute before using it.
    pub dfs: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Band {
    pub band: &'static str,
    pub networks: u32,
    /// Candidate channels for a router in this band, quietest first.
    pub candidates: Vec<ChannelLoad>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Own {
    pub ssid: String,
    pub bssid: String,
    pub band: &'static str,
    pub channel: u32,
    pub width: u32,
    pub rssi: i32,
    /// "excellent", "good", "fair", "weak", "bad".
    pub signal: &'static str,
    /// "free", "moderate", "busy", "crowded".
    pub congestion: &'static str,
    pub interference: f32,
    pub overlapping: u32,
    pub best: Option<ChannelLoad>,
    /// How much quieter the best channel is, dB.
    pub gain: f32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Advice {
    pub id: &'static str,
    /// "ok", "info", "warn", "risk".
    pub level: &'static str,
    pub values: Value,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub own: Option<Own>,
    pub bands: Vec<Band>,
    pub advice: Vec<Advice>,
    pub total: u32,
    pub names: u32,
    pub hidden: u32,
    pub open: u32,
    /// Access points of the user's own router (connected network, its guest network, other band).
    pub mine: Vec<String>,
}

const FLOOR: f32 = -100.0;

/// "Home" and "Home_5G" / "Home-5GHz": one network named per band, not an extra one.
fn is_band_twin(a: &str, b: &str) -> bool {
    let strip = |s: &str| {
        let l = s.to_lowercase();
        for suffix in ["_5ghz", "-5ghz", " 5ghz", "_5g", "-5g", " 5g", "_2.4ghz", "-2.4ghz", "_2.4g", "-2.4g", "_2g", "-2g", "_6g", "-6g"] {
            if let Some(x) = l.strip_suffix(suffix) {
                return x.to_string();
            }
        }
        l
    };
    strip(a) == strip(b)
}

/// Two addresses of one router: routers give their extra networks (guest, other band) addresses
/// that differ from the main one in a byte or two, often with the "locally administered" bit
/// set. Different routers — even of one make — differ in at least the last three bytes.
pub fn same_device(a: &str, b: &str) -> bool {
    let bytes = |s: &str| -> Option<Vec<u8>> { s.split(':').map(|x| u8::from_str_radix(x, 16).ok()).collect() };
    let (Some(mut a), Some(mut b)) = (bytes(a), bytes(b)) else { return false };
    if a.len() != 6 || b.len() != 6 {
        return false;
    }
    a[0] &= !0x02;
    b[0] &= !0x02;
    let differ = a.iter().zip(&b).filter(|(x, y)| x != y).count();
    // The last byte alone also differs between neighbouring units of a vendor's batch, so ask
    // that some other byte be the one (or one of two) that changed — or the low nibble only.
    differ == 0 || (differ <= 2 && (a[..5] != b[..5] || (a[5] ^ b[5]) < 0x10))
}

fn mw(dbm: i32) -> f64 {
    10f64.powf(dbm as f64 / 10.0)
}

fn dbm(mw: f64) -> f32 {
    if mw <= 0.0 { FLOOR } else { ((10.0 * mw.log10()) as f32).max(FLOOR) }
}

pub fn signal_level(rssi: i32) -> &'static str {
    match rssi {
        r if r >= -55 => "excellent",
        r if r >= -67 => "good",
        r if r >= -75 => "fair",
        r if r >= -82 => "weak",
        _ => "bad",
    }
}

pub fn congestion_level(interference: f32) -> &'static str {
    match interference {
        i if i < -85.0 => "free",
        i if i < -75.0 => "moderate",
        i if i < -65.0 => "busy",
        _ => "crowded",
    }
}

/// Interference on [low, high] from `others`.
fn load(low: u32, high: u32, others: &[&Bss]) -> (f32, u32) {
    let span = (high - low).max(1) as f64;
    let mut power = 0.0;
    let mut count = 0;
    for b in others {
        let overlap = high.min(b.high_mhz) as i64 - low.max(b.low_mhz) as i64;
        if overlap > 0 {
            power += mw(b.rssi) * (overlap as f64 / span).min(1.0);
            count += 1;
        }
    }
    (dbm(power), count)
}

/// Channel blocks a router could use: (primary channel, centre MHz, width, dfs).
fn blocks(band: &str, width: u32) -> Vec<(u32, u32, u32, bool)> {
    match band {
        // 1, 5, 9, 13 is also a valid plan in Ukraine and Europe, but most routers and neighbours
        // use 1/6/11 — sitting exactly on one of those overlaps least with them.
        "2.4" => [1, 6, 11, 13].iter().map(|&c| (c, 2407 + 5 * c, 20, false)).collect(),
        "5" => {
            let w = width.clamp(20, 80);
            let firsts: &[u32] = &[36, 52, 100, 116, 132, 149];
            let mut v = Vec::new();
            for &first in firsts {
                // Every 20 MHz primary inside an 80 MHz block shares the block's centre.
                let per = (w / 20).max(1);
                for k in 0..(4 / per) {
                    let primary = first + k * 4 * per;
                    let centre = 5000 + 5 * primary + (w / 2) - 10;
                    v.push((primary, centre, w, (52..=144).contains(&primary)));
                }
            }
            v
        }
        _ => (0..14).map(|k| (1 + 16 * k, 5950 + 5 * (7 + 16 * k), 80, false)).collect(),
    }
}

fn candidates(band: &'static str, width: u32, others: &[&Bss]) -> Vec<ChannelLoad> {
    let mut v: Vec<ChannelLoad> = blocks(band, width)
        .into_iter()
        .map(|(channel, centre, w, dfs)| {
            let (low, high) = (centre - w / 2, centre + w / 2);
            let (interference, networks) = load(low, high, others);
            ChannelLoad { channel, width: w, low_mhz: low, high_mhz: high, interference, networks, dfs }
        })
        .collect();
    // Quietest first. Below -85 dBm a channel is effectively free, so past that point quieter
    // does not matter and a channel without radar detection (DFS) wins: a DFS channel makes the
    // router go silent for a minute whenever it hears a radar.
    let score = |c: &ChannelLoad| c.interference.max(-85.0) + if c.dfs { 3.0 } else { 0.0 };
    v.sort_by(|a, b| score(a).total_cmp(&score(b)).then(a.interference.total_cmp(&b.interference)).then(a.channel.cmp(&b.channel)));
    v
}

pub fn analyse(all: &[Bss], link: Option<&Link>) -> Analysis {
    let own_bss = all.iter().find(|b| b.connected);
    let own_ssid = own_bss.map(|b| b.ssid.clone()).or(link.map(|l| l.ssid.clone()));
    // The user's router: every radio named like the connected network, plus its other networks
    // (guest, the other band) — those are the same box and coordinate, they are not neighbours.
    let mut mine: Vec<&Bss> = all.iter().filter(|b| own_ssid.as_deref().is_some_and(|s| !b.hidden && b.ssid == s)).collect();
    let more: Vec<&Bss> = all.iter().filter(|b| !mine.iter().any(|m| m.bssid == b.bssid) && mine.iter().any(|m| same_device(&m.bssid, &b.bssid) && (m.channel == b.channel || m.band != b.band))).collect();
    mine.extend(more);
    let others: Vec<&Bss> = all.iter().filter(|b| !mine.iter().any(|m| m.bssid == b.bssid)).collect();

    let mut bands = Vec::new();
    for band in ["2.4", "5", "6"] {
        let in_band: Vec<&Bss> = others.iter().copied().filter(|b| b.band == band).collect();
        let present = all.iter().any(|b| b.band == band);
        if !present {
            continue;
        }
        let width = match band {
            "2.4" => 20,
            _ => own_bss.filter(|b| b.band == band).map(|b| b.width).unwrap_or(80),
        };
        bands.push(Band { band, networks: all.iter().filter(|b| b.band == band).count() as u32, candidates: candidates(band, width, &in_band) });
    }

    let own = own_bss.map(|b| {
        let in_band: Vec<&Bss> = others.iter().copied().filter(|o| o.band == b.band).collect();
        let (interference, overlapping) = load(b.low_mhz, b.high_mhz, &in_band);
        let rssi = link.map(|l| l.rssi).filter(|&r| r != 0).unwrap_or(b.rssi);
        let best = bands.iter().find(|x| x.band == b.band).and_then(|x| x.candidates.first().cloned());
        let gain = best.as_ref().map(|c| interference - c.interference).unwrap_or(0.0).max(0.0);
        Own {
            ssid: b.ssid.clone(),
            bssid: b.bssid.clone(),
            band: b.band,
            channel: b.channel,
            width: b.width,
            rssi,
            signal: signal_level(rssi),
            congestion: congestion_level(interference),
            interference,
            overlapping,
            best,
            gain,
        }
    });

    let mut advice = Vec::new();
    macro_rules! add {
        ($id:expr, $level:expr, $values:expr) => {
            advice.push(Advice { id: $id, level: $level, values: $values })
        };
    }
    if let (Some(o), Some(b)) = (&own, own_bss) {
        match b.security {
            "open" => add!("own-open", "risk", json!({})),
            "wep" => add!("own-wep", "risk", json!({})),
            "wpa" => add!("own-wpa", "risk", json!({})),
            _ if b.tkip => add!("own-tkip", "warn", json!({})),
            "wpa3" | "wpa2-wpa3" => add!("own-wpa3", "ok", json!({})),
            _ => {}
        }
        if b.wps {
            add!("own-wps", "warn", json!({}));
        }
        // Other networks the same router broadcasts: often a guest network switched on by default.
        let mut extra: Vec<&str> = mine.iter().filter(|m| m.ssid != o.ssid && !m.hidden && !is_band_twin(&m.ssid, &o.ssid)).map(|m| m.ssid.as_str()).collect();
        extra.sort_unstable();
        extra.dedup();
        if !extra.is_empty() {
            add!("own-extra", "info", json!({ "names": extra.join(", "), "count": extra.len() }));
        }
        match o.signal {
            "weak" | "bad" => add!("signal-weak", "warn", json!({ "rssi": o.rssi })),
            "fair" => add!("signal-fair", "info", json!({ "rssi": o.rssi })),
            _ => {}
        }
        // The same network is also on 5/6 GHz and heard well enough there.
        if o.band == "2.4" {
            if let Some(fast) = all.iter().filter(|x| x.ssid == o.ssid && x.band != "2.4" && x.rssi >= -72).max_by_key(|x| x.rssi) {
                add!("use-5ghz", "info", json!({ "band": fast.band, "rssi": fast.rssi }));
            }
        }
        if let Some(best) = &o.best {
            if best.channel != o.channel && o.gain >= 6.0 && o.congestion != "free" {
                add!("change-channel", "warn", json!({ "channel": best.channel, "band": o.band, "gain": o.gain.round(), "dfs": best.dfs, "width": best.width }));
            }
        }
        if o.band == "2.4" && o.width >= 40 && o.overlapping >= 3 {
            add!("narrow-24", "info", json!({ "count": o.overlapping }));
        }
        if !matches!(o.congestion, "busy" | "crowded") && !advice.iter().any(|a| a.level == "warn" || a.level == "risk") {
            add!("all-good", "ok", json!({}));
        }
    } else if link.is_none() {
        add!("not-connected", "info", json!({}));
    }
    let crowded = all.iter().filter(|b| b.band == "2.4").count();
    if crowded >= 15 {
        add!("crowded-24", "info", json!({ "count": crowded }));
    }
    let open = all.iter().filter(|b| b.security == "open" && !b.connected).count() as u32;
    if open > 0 {
        add!("neighbors-open", "info", json!({ "count": open }));
    }

    let mut names: Vec<&str> = all.iter().filter(|b| !b.hidden).map(|b| b.ssid.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    Analysis {
        own,
        bands,
        advice,
        total: all.len() as u32,
        names: names.len() as u32,
        hidden: all.iter().filter(|b| b.hidden).count() as u32,
        open,
        mine: mine.iter().map(|b| b.bssid.clone()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ap(ssid: &str, bssid: &str, mhz: u32, width: u32, rssi: i32, connected: bool) -> Bss {
        let centre = if width == 80 && mhz >= 5000 { 5210 } else { mhz };
        Bss {
            bssid: bssid.into(),
            ssid: ssid.into(),
            hidden: ssid.is_empty(),
            rssi,
            quality: 0,
            mhz,
            band: super::super::band(mhz),
            channel: super::super::channel(mhz),
            width,
            low_mhz: centre - width / 2,
            high_mhz: centre + width / 2,
            generation: 5,
            security: "wpa2",
            tkip: false,
            pmf: false,
            wps: false,
            stations: None,
            utilization: None,
            country: None,
            beacon_ms: 102,
            connected,
            random_mac: false,
            distance_m: 1.0,
        }
    }

    #[test]
    fn crowded_channel_gets_a_quieter_one() {
        let all = vec![
            ap("Home", "A", 2437, 20, -50, true),
            ap("Home", "A5", 5180, 80, -60, false),
            ap("Neighbour1", "B", 2437, 20, -60, false),
            ap("Neighbour2", "C", 2442, 20, -62, false),
            ap("Neighbour3", "D", 2412, 20, -85, false),
        ];
        let a = analyse(&all, None);
        let own = a.own.unwrap();
        assert_eq!((own.channel, own.signal), (6, "excellent"));
        assert_eq!(own.overlapping, 2);
        assert_eq!(own.congestion, "crowded");
        let best = own.best.unwrap();
        assert!(best.channel == 11 || best.channel == 13, "{best:?}");
        assert!(a.advice.iter().any(|x| x.id == "change-channel"));
        assert!(a.advice.iter().any(|x| x.id == "use-5ghz"));
        // The user's own 5 GHz radio is not interference.
        assert_eq!(a.bands.iter().find(|b| b.band == "5").unwrap().candidates[0].networks, 0);
    }

    #[test]
    fn quiet_network_is_all_good() {
        let all = vec![ap("Home", "A", 5180, 80, -48, true), ap("Far", "B", 5745, 80, -88, false)];
        let a = analyse(&all, None);
        assert_eq!(a.own.as_ref().unwrap().congestion, "free");
        assert!(a.advice.iter().any(|x| x.id == "all-good"), "{:?}", a.advice);
        assert!(!a.advice.iter().any(|x| x.id == "change-channel"));
    }

    #[test]
    fn quiet_enough_prefers_a_channel_without_radar_detection() {
        let all = vec![ap("Far", "B", 5745, 20, -84, false), ap("Near", "C", 5500, 20, -57, false)];
        let a = analyse(&all, None);
        let best = &a.bands.iter().find(|b| b.band == "5").unwrap().candidates[0];
        assert!(!best.dfs, "{best:?}");
    }

    #[test]
    fn one_routers_networks_are_recognised() {
        assert!(same_device("0A:BF:B8:D7:40:70", "0A:BF:B8:E7:40:70")); // ASUS guest
        assert!(same_device("B0:BE:76:09:28:EE", "B0:BE:76:09:28:ED")); // TP-Link 2.4 / 5 GHz
        assert!(same_device("50:FF:20:49:D2:45", "50:FF:20:49:D2:47"));
        assert!(!same_device("70:4F:57:CE:98:1C", "7C:8B:CA:86:2C:74"));
        assert!(!same_device("B0:BE:76:09:28:EE", "B0:BE:76:09:28:4E")); // another unit
    }

    #[test]
    fn guest_network_of_own_router_is_not_interference() {
        let all = vec![ap("KARID", "0A:BF:B8:D7:40:70", 5500, 20, -60, true), ap("ASUS_Guest", "0A:BF:B8:E7:40:70", 5500, 20, -60, false)];
        let a = analyse(&all, None);
        let own = a.own.unwrap();
        assert_eq!((own.overlapping, own.congestion), (0, "free"));
        assert_eq!(a.mine.len(), 2);
        assert!(!a.advice.iter().any(|x| x.id == "change-channel"));
        assert!(a.advice.iter().any(|x| x.id == "own-extra"));
        assert!(is_band_twin("TP-Link_28EE", "TP-Link_28EE_5G"));
        // A look-alike address on another channel of the same band is a neighbour after all.
        let all = vec![ap("KARID", "0A:BF:B8:D7:40:70", 5500, 20, -60, true), ap("Other", "0A:BF:B8:E7:40:70", 5180, 20, -60, false)];
        assert_eq!(analyse(&all, None).mine.len(), 1);
    }

    #[test]
    fn five_ghz_blocks_are_well_formed() {
        for (primary, centre, w, _) in blocks("5", 80) {
            assert_eq!(w, 80);
            assert!(centre - 40 >= 5170 && centre + 40 <= 5850, "{primary} {centre}");
        }
        assert_eq!(blocks("5", 20).len(), 24);
        assert_eq!(blocks("5", 20)[1].0, 40);
    }
}

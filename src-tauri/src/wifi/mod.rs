//! Wi-Fi analyzer: every access point around, what it is and how loud, and what that means for
//! the user's own network — which channel is crowded, which would be quieter, whether the signal
//! is strong enough and whether the network is protected properly.
//!
//! Everything comes from the WLAN API (wlanapi.dll) without administrator rights. Since Windows 11
//! 24H2 the list of networks around also needs the location permission for desktop apps.

mod analysis;
mod ies;

use serde::Serialize;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::NetworkManagement::WiFi::{
    WLAN_BSS_LIST, WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO_LIST, WLAN_RADIO_STATE, WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory,
    WlanGetNetworkBssList, WlanOpenHandle, WlanQueryInterface, WlanScan, dot11_BSS_type_any, wlan_intf_opcode_current_connection,
    wlan_intf_opcode_radio_state, wlan_intf_opcode_rssi,
};
use windows::core::GUID;

pub use analysis::Analysis;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Bss {
    pub bssid: String,
    pub ssid: String,
    pub hidden: bool,
    /// dBm.
    pub rssi: i32,
    /// 0–100, Windows' own scale.
    pub quality: u32,
    /// Primary channel centre.
    pub mhz: u32,
    /// "2.4", "5" or "6".
    pub band: &'static str,
    pub channel: u32,
    /// What it occupies, in MHz.
    pub width: u32,
    pub low_mhz: u32,
    pub high_mhz: u32,
    /// 4–7 for Wi-Fi 4–7, 0 for older.
    pub generation: u8,
    pub security: &'static str,
    pub tkip: bool,
    pub pmf: bool,
    pub wps: bool,
    pub stations: Option<u16>,
    pub utilization: Option<u8>,
    pub country: Option<String>,
    pub beacon_ms: u32,
    pub connected: bool,
    /// A locally administered address: a virtual or guest network, or a phone hotspot.
    pub random_mac: bool,
    /// Rough distance estimate from the signal, metres.
    pub distance_m: f32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub interface: String,
    pub ssid: String,
    pub bssid: String,
    pub rssi: i32,
    pub quality: u32,
    pub rx_mbps: u32,
    pub tx_mbps: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// "ok", "off" (radio switched off), "none" (no Wi-Fi adapter), "denied" (no location
    /// permission), "error".
    pub state: &'static str,
    pub interface: Option<String>,
    pub link: Option<Link>,
    pub networks: Vec<Bss>,
    pub analysis: Option<Analysis>,
    /// Unix ms.
    pub at: i64,
}

fn mac(b: &[u8; 6]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect::<Vec<_>>().join(":")
}

/// Channel number for a centre frequency in MHz.
pub fn channel(mhz: u32) -> u32 {
    match mhz {
        2484 => 14,
        m if m < 3000 => (m.saturating_sub(2407)) / 5,
        m if m < 5925 => (m.saturating_sub(5000)) / 5,
        m => (m.saturating_sub(5950)) / 5,
    }
}

pub fn band(mhz: u32) -> &'static str {
    if mhz < 3000 {
        "2.4"
    } else if mhz < 5925 {
        "5"
    } else {
        "6"
    }
}

/// Log-distance path loss: about 1 m at the reference level, ×10 per 30 dB indoors. A guess
/// within a factor of two at best — walls, floors and antennas move it a lot.
pub fn distance(rssi: i32, band: &str) -> f32 {
    let reference = match band {
        "2.4" => -40.0,
        "5" => -46.0,
        _ => -48.0,
    };
    10f32.powf((reference - rssi as f32) / 30.0).clamp(0.5, 150.0)
}

fn generation(f: &ies::Facts, phy: i32) -> u8 {
    if f.eht {
        7
    } else if f.he {
        6
    } else if f.vht {
        5
    } else if f.ht {
        4
    } else {
        match phy {
            7 => 4,
            8 => 5,
            10 => 6,
            11 => 7,
            _ => 0,
        }
    }
}

struct Wlan(HANDLE);

impl Wlan {
    fn open() -> Option<Self> {
        let (mut version, mut handle) = (0u32, HANDLE::default());
        // SAFETY: out-parameters are valid; the handle is closed on drop.
        (unsafe { WlanOpenHandle(2, None, &mut version, &mut handle) } == 0).then_some(Self(handle))
    }

    /// (GUID, description) of every wireless adapter.
    fn interfaces(&self) -> Vec<(GUID, String)> {
        let mut out = Vec::new();
        // SAFETY: the list is read within its reported length and freed.
        unsafe {
            let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
            if WlanEnumInterfaces(self.0, None, &mut list) == 0 && !list.is_null() {
                let items = std::slice::from_raw_parts((*list).InterfaceInfo.as_ptr(), (*list).dwNumberOfItems as usize);
                for item in items {
                    let len = item.strInterfaceDescription.iter().position(|&u| u == 0).unwrap_or(256);
                    out.push((item.InterfaceGuid, String::from_utf16_lossy(&item.strInterfaceDescription[..len])));
                }
                WlanFreeMemory(list as *const _);
            }
        }
        out
    }

    fn radio_on(&self, guid: &GUID) -> bool {
        // SAFETY: the returned block is a WLAN_RADIO_STATE of the reported size, freed after use.
        unsafe {
            let (mut size, mut data) = (0u32, std::ptr::null_mut());
            if WlanQueryInterface(self.0, guid, wlan_intf_opcode_radio_state, None, &mut size, &mut data, None) != 0 || data.is_null() {
                return true;
            }
            let state = &*(data as *const WLAN_RADIO_STATE);
            let n = (state.dwNumberOfPhys as usize).min(64);
            // dot11_radio_state_on = 1
            let on = n == 0 || state.PhyRadioState[..n].iter().any(|p| p.dot11SoftwareRadioState.0 == 1 && p.dot11HardwareRadioState.0 == 1);
            WlanFreeMemory(data);
            on
        }
    }

    fn link(&self, guid: &GUID, interface: &str) -> Option<Link> {
        // SAFETY: as above; each block is freed.
        unsafe {
            let (mut size, mut data) = (0u32, std::ptr::null_mut());
            if WlanQueryInterface(self.0, guid, wlan_intf_opcode_current_connection, None, &mut size, &mut data, None) != 0 || data.is_null() {
                return None;
            }
            let c = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
            let a = &c.wlanAssociationAttributes;
            let ssid_len = (a.dot11Ssid.uSSIDLength as usize).min(32);
            let mut link = Link {
                interface: interface.to_string(),
                ssid: String::from_utf8_lossy(&a.dot11Ssid.ucSSID[..ssid_len]).into_owned(),
                bssid: mac(&a.dot11Bssid),
                rssi: 0,
                quality: a.wlanSignalQuality,
                rx_mbps: a.ulRxRate / 1000,
                tx_mbps: a.ulTxRate / 1000,
            };
            WlanFreeMemory(data);
            // The live RSSI of the connection (refreshed by the driver about every second).
            let (mut size, mut data) = (0u32, std::ptr::null_mut());
            if WlanQueryInterface(self.0, guid, wlan_intf_opcode_rssi, None, &mut size, &mut data, None) == 0 && !data.is_null() {
                link.rssi = *(data as *const i32);
                WlanFreeMemory(data);
            } else {
                // Windows' quality scale is linear from -100 dBm (0) to -50 dBm (100).
                link.rssi = link.quality as i32 / 2 - 100;
            }
            Some(link)
        }
    }

    /// Asks the adapter for a fresh scan; results land in the list a few seconds later.
    fn scan(&self, guid: &GUID) {
        // SAFETY: plain call with a valid handle and GUID.
        unsafe {
            let _ = WlanScan(self.0, guid, None, None, None);
        }
    }

    /// Every access point the adapter last heard. Err(code) on failure (5: no permission).
    fn bss(&self, guid: &GUID, connected: Option<&str>) -> Result<Vec<Bss>, u32> {
        let mut out: Vec<Bss> = Vec::new();
        // SAFETY: entries are read within the reported count; each IE blob within the entry's
        // reported offset and size, inside the same allocation; the list is freed.
        unsafe {
            let mut list: *mut WLAN_BSS_LIST = std::ptr::null_mut();
            let code = WlanGetNetworkBssList(self.0, guid, None, dot11_BSS_type_any, false, None, &mut list);
            if code != 0 || list.is_null() {
                return Err(code);
            }
            let entries = std::slice::from_raw_parts((*list).wlanBssEntries.as_ptr(), (*list).dwNumberOfItems as usize);
            for e in entries {
                let ie = std::slice::from_raw_parts((e as *const _ as *const u8).add(e.ulIeOffset as usize), e.ulIeSize as usize);
                let mhz = e.ulChCenterFrequency / 1000;
                let facts = ies::parse(ie, mhz);
                let ssid_len = (e.dot11Ssid.uSSIDLength as usize).min(32);
                let ssid = String::from_utf8_lossy(&e.dot11Ssid.ucSSID[..ssid_len]).trim_end_matches('\0').to_string();
                let band = band(mhz);
                let width = facts.width.unwrap_or(20);
                let centre = facts.center_mhz.unwrap_or(mhz);
                let bssid = mac(&e.dot11Bssid);
                let item = Bss {
                    hidden: ssid.trim().is_empty(),
                    ssid,
                    rssi: e.lRssi,
                    quality: e.uLinkQuality,
                    mhz,
                    band,
                    channel: channel(mhz),
                    width,
                    low_mhz: centre - width / 2,
                    high_mhz: centre + width / 2,
                    generation: generation(&facts, e.dot11BssPhyType.0),
                    security: facts.security.label(e.usCapabilityInformation & 0x10 != 0),
                    tkip: facts.security.tkip,
                    pmf: facts.security.pmf_required || facts.security.pmf_capable,
                    wps: facts.wps,
                    stations: facts.stations,
                    utilization: facts.utilization,
                    country: facts.country,
                    beacon_ms: (e.usBeaconPeriod as u32 * 1024) / 1000,
                    connected: connected == Some(bssid.as_str()),
                    random_mac: e.dot11Bssid[0] & 0x02 != 0,
                    distance_m: distance(e.lRssi, band),
                    bssid,
                };
                // The same radio can be listed once per PHY: keep the loudest report.
                match out.iter_mut().find(|b| b.bssid == item.bssid) {
                    Some(b) if b.rssi < item.rssi => *b = item,
                    Some(_) => {}
                    None => out.push(item),
                }
            }
            WlanFreeMemory(list as *const _);
        }
        out.sort_by_key(|b| std::cmp::Reverse(b.rssi));
        Ok(out)
    }
}

impl Drop for Wlan {
    fn drop(&mut self) {
        // SAFETY: the handle came from WlanOpenHandle.
        unsafe {
            WlanCloseHandle(self.0, None);
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn snapshot(scan: bool) -> Snapshot {
    let empty = |state| Snapshot { state, interface: None, link: None, networks: Vec::new(), analysis: None, at: now_ms() };
    let Some(wlan) = Wlan::open() else { return empty("none") };
    let interfaces = wlan.interfaces();
    let Some((guid, name)) = interfaces.first().cloned() else { return empty("none") };
    if !wlan.radio_on(&guid) {
        return Snapshot { interface: Some(name), ..empty("off") };
    }
    if scan {
        wlan.scan(&guid);
        std::thread::sleep(std::time::Duration::from_millis(3200));
    }
    let link = wlan.link(&guid, &name);
    match wlan.bss(&guid, link.as_ref().map(|l| l.bssid.as_str())) {
        Ok(networks) => {
            let analysis = analysis::analyse(&networks, link.as_ref());
            Snapshot { state: "ok", interface: Some(name), link, networks, analysis: Some(analysis), at: now_ms() }
        }
        Err(5) => Snapshot { interface: Some(name), link, ..empty("denied") },
        Err(code) => {
            crate::errlog::write("wifi", &format!("WlanGetNetworkBssList failed: {code}"));
            Snapshot { interface: Some(name), link, ..empty("error") }
        }
    }
}

/// Everything around, after a fresh scan when `scan` (takes about 3 s).
#[tauri::command]
pub async fn wifi_snapshot(scan: bool) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot(scan)).await.map_err(|e| e.to_string())
}

/// Just the current connection and its live signal: cheap, for once-a-second updates.
#[tauri::command]
pub async fn wifi_link() -> Result<Option<Link>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let wlan = Wlan::open()?;
        let (guid, name) = wlan.interfaces().into_iter().next()?;
        wlan.link(&guid, &name)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_and_bands() {
        assert_eq!((channel(2412), band(2412)), (1, "2.4"));
        assert_eq!(channel(2484), 14);
        assert_eq!((channel(5180), band(5180)), (36, "5"));
        assert_eq!((channel(5825), band(5825)), (165, "5"));
        assert_eq!((channel(5955), band(5955)), (1, "6"));
    }

    #[test]
    fn distance_is_monotonic_and_bounded() {
        assert!(distance(-40, "2.4") < distance(-70, "2.4"));
        assert!((distance(-70, "2.4") - 10.0).abs() < 0.5);
        assert_eq!(distance(-10, "5"), 0.5);
        assert_eq!(distance(-130, "5"), 150.0);
    }

    #[test]
    fn reads_this_machine() {
        let s = snapshot(false);
        println!("state {} on {:?}, {} networks, link {:?}", s.state, s.interface, s.networks.len(), s.link);
        for b in s.networks.iter().take(30) {
            println!(
                "{:>4} dBm {:>3} ch{:<3} {:>3}MHz wifi{} {:<10} {:<18} {} st={:?} util={:?} {}",
                b.rssi, b.band, b.channel, b.width, b.generation, b.security, b.bssid, b.ssid, b.stations, b.utilization, if b.connected { "<- connected" } else { "" }
            );
        }
        if let Some(a) = &s.analysis {
            println!("{}", serde_json::to_string_pretty(a).unwrap());
        }
    }
}

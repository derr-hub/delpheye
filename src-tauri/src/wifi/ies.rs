//! Reads the Information Elements a Wi-Fi access point puts in its beacons: what standard it
//! speaks, how wide its channel is, how it is protected and how busy it is.
//!
//! Every element is `[id, length, data…]`; element 255 carries an extension id as its first byte.

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Facts {
    pub ht: bool,
    pub vht: bool,
    pub he: bool,
    pub eht: bool,
    /// Occupied width in MHz and its centre, when the elements say (else: 20 MHz at the primary).
    pub width: Option<u32>,
    pub center_mhz: Option<u32>,
    pub security: Security,
    pub wps: bool,
    /// Devices connected to this access point, from the BSS Load element.
    pub stations: Option<u16>,
    /// How busy the channel is, 0–100 %, as the access point itself measures it.
    pub utilization: Option<u8>,
    pub country: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Security {
    pub rsn: bool,
    pub wpa1: bool,
    pub psk: bool,
    pub sae: bool,
    pub owe: bool,
    pub enterprise: bool,
    pub tkip: bool,
    /// Management frames protected: required (or at least offered).
    pub pmf_required: bool,
    pub pmf_capable: bool,
}

impl Security {
    /// One word for the protection, given whether the "privacy" capability bit is set.
    pub fn label(&self, privacy: bool) -> &'static str {
        if self.owe {
            "owe"
        } else if self.enterprise {
            "enterprise"
        } else if self.sae && self.psk {
            "wpa2-wpa3"
        } else if self.sae {
            "wpa3"
        } else if self.rsn {
            "wpa2"
        } else if self.wpa1 {
            "wpa"
        } else if privacy {
            "wep"
        } else {
            "open"
        }
    }
}

const WIDTHS_HE6: [u32; 4] = [20, 40, 80, 160];

/// `primary_mhz` is the channel centre Windows reports; `base` the band's channel-0 frequency.
pub fn parse(data: &[u8], primary_mhz: u32) -> Facts {
    let mut f = Facts::default();
    let base = band_base(primary_mhz);
    let mut i = 0;
    while i + 2 <= data.len() {
        let (id, len) = (data[i], data[i + 1] as usize);
        let Some(body) = data.get(i + 2..i + 2 + len) else { break };
        match id {
            7 if body.len() >= 2 => {
                let c: String = body[..2].iter().map(|&b| b as char).filter(|c| c.is_ascii_alphabetic()).collect();
                if c.len() == 2 {
                    f.country = Some(c);
                }
            }
            11 if body.len() >= 3 => {
                f.stations = Some(u16::from_le_bytes([body[0], body[1]]));
                f.utilization = Some(((body[2] as u32 * 100 + 127) / 255) as u8);
            }
            45 => f.ht = true,
            61 if body.len() >= 2 => {
                f.ht = true;
                let offset = body[1] & 0b11;
                let any_width = body[1] & 0b100 != 0;
                if any_width && (offset == 1 || offset == 3) && f.width.is_none_or(|w| w < 40) {
                    f.width = Some(40);
                    f.center_mhz = Some(if offset == 1 { primary_mhz + 10 } else { primary_mhz - 10 });
                }
            }
            191 => f.vht = true,
            192 if body.len() >= 3 => {
                f.vht = true;
                let (width, seg0, seg1) = (body[0], body[1] as u32, body[2] as u32);
                if width >= 1 && seg0 != 0 {
                    let (w, centre) = if seg1 != 0 && seg1.abs_diff(seg0) == 8 {
                        (160, seg1)
                    } else if seg1 != 0 {
                        (160, seg0) // 80+80: two separate halves; counted as 160 wide.
                    } else if width == 2 {
                        (160, seg0) // deprecated "160" signalling.
                    } else {
                        (80, seg0)
                    };
                    if f.width.is_none_or(|x| x < w) {
                        f.width = Some(w);
                        f.center_mhz = Some(base + 5 * centre);
                    }
                }
            }
            48 => {
                f.security.rsn = true;
                rsn(body, &mut f.security);
            }
            221 if body.len() >= 4 => {
                if body[..3] == [0x00, 0x50, 0xF2] {
                    match body[3] {
                        1 => {
                            f.security.wpa1 = true;
                            if body.windows(4).any(|w| w == [0x00, 0x50, 0xF2, 2]) {
                                f.security.tkip = true;
                            }
                        }
                        4 => f.wps = true,
                        _ => {}
                    }
                }
            }
            255 if !body.is_empty() => match body[0] {
                35 => f.he = true,
                36 => {
                    f.he = true;
                    he_operation(&body[1..], &mut f);
                }
                108 => f.eht = true,
                106 => {
                    f.eht = true;
                    eht_operation(&body[1..], base, &mut f);
                }
                _ => {}
            },
            _ => {}
        }
        i += 2 + len;
    }
    f
}

/// Channel 0's frequency for the band `mhz` is in.
pub fn band_base(mhz: u32) -> u32 {
    if mhz < 3000 {
        2407
    } else if mhz < 5925 {
        5000
    } else {
        5950
    }
}

fn rsn(body: &[u8], s: &mut Security) {
    // version(2) group(4) pairwise count(2) + 4n, AKM count(2) + 4n, capabilities(2)
    let mut at = 6;
    let read_count = |at: usize| body.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize);
    if body.get(2..6).is_some_and(|g| g[..3] == [0x00, 0x0F, 0xAC] && g[3] == 2) {
        s.tkip = true;
    }
    let Some(pairwise) = read_count(at) else { return };
    at += 2;
    for k in 0..pairwise {
        if body.get(at + 4 * k..at + 4 * k + 4).is_some_and(|c| c[..3] == [0x00, 0x0F, 0xAC] && c[3] == 2) {
            s.tkip = true;
        }
    }
    at += 4 * pairwise;
    let Some(akms) = read_count(at) else { return };
    at += 2;
    for k in 0..akms {
        let Some(a) = body.get(at + 4 * k..at + 4 * k + 4) else { return };
        if a[..3] != [0x00, 0x0F, 0xAC] {
            continue;
        }
        match a[3] {
            1 | 3 | 5 | 11 | 12 | 13 => s.enterprise = true,
            2 | 4 | 6 => s.psk = true,
            8 | 9 | 24 | 25 => s.sae = true,
            18 => s.owe = true,
            _ => {}
        }
    }
    at += 4 * akms;
    if let Some(caps) = read_count(at) {
        s.pmf_required = caps & (1 << 6) != 0;
        s.pmf_capable = caps & (1 << 7) != 0;
    }
}

fn he_operation(b: &[u8], f: &mut Facts) {
    // params(3) bss colour(1) basic MCS(2) [VHT info(3)] [co-hosted(1)] [6 GHz info(5)]
    if b.len() < 6 {
        return;
    }
    let params = u32::from_le_bytes([b[0], b[1], b[2], 0]);
    let mut at = 6;
    if params & (1 << 14) != 0 {
        at += 3;
    }
    if params & (1 << 15) != 0 {
        at += 1;
    }
    if params & (1 << 17) != 0 {
        if let Some(info) = b.get(at..at + 5) {
            let width = WIDTHS_HE6[(info[1] & 0b11) as usize];
            let (seg0, seg1) = (info[2] as u32, info[3] as u32);
            let centre = if width == 160 && seg1 != 0 { seg1 } else { seg0 };
            if f.width.is_none_or(|x| x < width) && centre != 0 {
                f.width = Some(width);
                f.center_mhz = Some(5950 + 5 * centre);
            }
        }
    }
}

fn eht_operation(b: &[u8], base: u32, f: &mut Facts) {
    // params(1) basic EHT-MCS(4) [info: control(1) CCFS0(1) CCFS1(1) …]
    if b.first().is_none_or(|p| p & 1 == 0) {
        return;
    }
    let Some(info) = b.get(5..8) else { return };
    let width = match info[0] & 0b111 {
        0 => 20,
        1 => 40,
        2 => 80,
        3 => 160,
        4 => 320,
        _ => return,
    };
    let (ccfs0, ccfs1) = (info[1] as u32, info[2] as u32);
    let centre = if width >= 160 && ccfs1 != 0 { ccfs1 } else { ccfs0 };
    if f.width.is_none_or(|x| x < width) && centre != 0 {
        f.width = Some(width);
        f.center_mhz = Some(base + 5 * centre);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ie(id: u8, body: &[u8]) -> Vec<u8> {
        let mut v = vec![id, body.len() as u8];
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn wifi5_router_on_80_mhz_with_wpa2_and_wpa3() {
        let mut data = Vec::new();
        data.extend(ie(7, b"UA "));
        data.extend(ie(11, &[5, 0, 64, 0, 0])); // 5 stations, 64/255 busy
        data.extend(ie(61, &[36, 0b101, 0, 0, 0])); // HT, secondary above, any width
        data.extend(ie(192, &[1, 42, 0, 0, 0])); // VHT 80 MHz centred on channel 42
        // RSN: v1, group CCMP, 1 pairwise CCMP, 2 AKMs PSK + SAE, caps MFP capable
        data.extend(ie(48, &[1, 0, 0x00, 0x0F, 0xAC, 4, 1, 0, 0x00, 0x0F, 0xAC, 4, 2, 0, 0x00, 0x0F, 0xAC, 2, 0x00, 0x0F, 0xAC, 8, 0x80, 0]));
        data.extend(ie(221, &[0x00, 0x50, 0xF2, 4, 0x10, 0x4A]));
        let f = parse(&data, 5180);
        assert_eq!(f.country.as_deref(), Some("UA"));
        assert_eq!((f.stations, f.utilization), (Some(5), Some(25)));
        assert!(f.ht && f.vht && !f.he);
        assert_eq!((f.width, f.center_mhz), (Some(80), Some(5210)));
        assert_eq!(f.security.label(true), "wpa2-wpa3");
        assert!(f.security.pmf_capable && !f.security.pmf_required && !f.security.tkip);
        assert!(f.wps);
    }

    #[test]
    fn old_and_open_networks() {
        let wpa1 = ie(221, &[0x00, 0x50, 0xF2, 1, 1, 0, 0x00, 0x50, 0xF2, 2]);
        let f = parse(&wpa1, 2437);
        assert_eq!(f.security.label(true), "wpa");
        assert!(f.security.tkip);
        assert_eq!(parse(&[], 2412).security.label(true), "wep");
        assert_eq!(parse(&[], 2412).security.label(false), "open");
        assert_eq!(parse(&[], 2412).width, None);
    }

    #[test]
    fn wifi6e_and_wifi7_widths() {
        // HE operation with 6 GHz info: 160 MHz, seg0 = 7, seg1 = 15 → centre channel 15
        let mut he = vec![36, 0, 0, 0b10, 0, 0, 0];
        he.extend_from_slice(&[37, 0b11, 7, 15, 0]);
        let f = parse(&ie(255, &he), 5975);
        assert!(f.he);
        assert_eq!((f.width, f.center_mhz), (Some(160), Some(5950 + 75)));
        // EHT operation info present: 320 MHz, CCFS1 = 31
        let eht = [106, 1, 0, 0, 0, 0, 4, 15, 31];
        let f = parse(&ie(255, &eht), 5975);
        assert!(f.eht);
        assert_eq!((f.width, f.center_mhz), (Some(320), Some(5950 + 155)));
    }

    #[test]
    fn truncated_elements_do_not_panic() {
        assert_eq!(parse(&[48, 40, 1, 0], 2412).security.rsn, false);
        let _ = parse(&[192, 1, 1], 5180);
        let _ = parse(&[255, 3, 36, 0, 0], 5975);
    }
}

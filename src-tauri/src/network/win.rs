//! What Windows knows about the network: adapters and their counters, the Wi-Fi link, every TCP
//! connection with its owner, per-connection byte counts (administrators only), ping and
//! reverse DNS. Everything here only reads.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Instant;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::NetworkManagement::Dns::{DNS_QUERY_BYPASS_CACHE, DNS_QUERY_STANDARD, DNS_RECORDW, DNS_TYPE_A, DNS_TYPE_PTR, DnsFree, DnsFreeRecordList, DnsQuery_W};
use windows::Win32::NetworkManagement::IpHelper::{
    GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_MULTICAST, GetAdaptersAddresses, GetExtendedTcpTable, GetIfEntry2,
    GetPerTcp6ConnectionEStats, GetPerTcpConnectionEStats, ICMP_ECHO_REPLY, IP_ADAPTER_ADDRESSES_LH, IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho,
    MIB_IF_ROW2, MIB_TCP_STATE, MIB_TCP6ROW, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_LH, MIB_TCPROW_LH_0, MIB_TCPROW_OWNER_PID, SetPerTcp6ConnectionEStats,
    SetPerTcpConnectionEStats, TCP_ESTATS_DATA_ROD_v0, TCP_ESTATS_DATA_RW_v0, TCP_TABLE_OWNER_PID_ALL, TcpConnectionEstatsData,
};
use windows::Win32::NetworkManagement::WiFi::{
    WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO_LIST, WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory, WlanOpenHandle, WlanQueryInterface,
    wlan_intf_opcode_current_connection,
};
use windows::Win32::Networking::WinSock::{IN6_ADDR, IN6_ADDR_0, SOCKET_ADDRESS};
use windows::core::HSTRING;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    pub index: u32,
    pub name: String,
    pub description: String,
    /// "ethernet", "wifi", "vpn", "loopback" or "other".
    pub kind: &'static str,
    pub up: bool,
    /// Link speed in bits per second.
    pub speed: u64,
    pub mac: String,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
    pub gateways: Vec<String>,
    pub dns: Vec<String>,
    /// Bytes received and sent since Windows started.
    pub received: u64,
    pub sent: u64,
}

fn address(a: &SOCKET_ADDRESS) -> Option<IpAddr> {
    if a.lpSockaddr.is_null() || a.iSockaddrLength < 8 {
        return None;
    }
    // SAFETY: the API says the socket address is `iSockaddrLength` bytes long.
    let bytes = unsafe { std::slice::from_raw_parts(a.lpSockaddr as *const u8, a.iSockaddrLength as usize) };
    match u16::from_ne_bytes([bytes[0], bytes[1]]) {
        2 => Some(IpAddr::V4(Ipv4Addr::new(bytes[4], bytes[5], bytes[6], bytes[7]))),
        23 if bytes.len() >= 24 => Some(IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&bytes[8..24]).ok()?))),
        _ => None,
    }
}

fn kind(if_type: u32, description: &str) -> &'static str {
    let d = description.to_lowercase();
    if ["vpn", "wireguard", "wintun", "tap-", "openvpn", "nordlynx", "secureline", "tunnel"].iter().any(|w| d.contains(w)) || matches!(if_type, 23 | 53 | 131) {
        return "vpn";
    }
    match if_type {
        6 => "ethernet",
        71 => "wifi",
        24 => "loopback",
        _ => "other",
    }
}

pub fn adapters() -> Vec<Adapter> {
    let flags = GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_ANYCAST;
    let mut size = 32 * 1024u32;
    let mut buffer: Vec<u64>;
    // SAFETY: the buffer is u64-aligned and sized as the API asks; the linked lists it builds
    // point inside the buffer, which outlives the walk below.
    unsafe {
        loop {
            buffer = vec![0u64; size as usize / 8 + 1];
            match GetAdaptersAddresses(0, flags, None, Some(buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH), &mut size) {
                0 => break,
                111 => continue, // ERROR_BUFFER_OVERFLOW: `size` now says how much is needed.
                _ => return Vec::new(),
            }
        }
        let mut out = Vec::new();
        let mut node = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !node.is_null() {
            let a = &*node;
            let description = a.Description.to_string().unwrap_or_default();
            let index = a.Anonymous1.Anonymous.IfIndex;
            let (mut ipv4, mut ipv6, mut gateways, mut dns) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
            let mut u = a.FirstUnicastAddress;
            while !u.is_null() {
                match address(&(*u).Address) {
                    Some(IpAddr::V4(ip)) => ipv4.push(ip.to_string()),
                    Some(IpAddr::V6(ip)) => ipv6.push(ip.to_string()),
                    None => {}
                }
                u = (*u).Next;
            }
            let mut g = a.FirstGatewayAddress;
            while !g.is_null() {
                gateways.extend(address(&(*g).Address).map(|ip| ip.to_string()));
                g = (*g).Next;
            }
            let mut d = a.FirstDnsServerAddress;
            while !d.is_null() {
                dns.extend(address(&(*d).Address).map(|ip| ip.to_string()).filter(|ip| !ip.starts_with("fec0:")));
                d = (*d).Next;
            }
            let mut row = MIB_IF_ROW2 { InterfaceIndex: index, ..Default::default() };
            let counters = GetIfEntry2(&mut row).0 == 0;
            let mac_len = (a.PhysicalAddressLength as usize).min(8);
            out.push(Adapter {
                index,
                name: a.FriendlyName.to_string().unwrap_or_default(),
                kind: kind(a.IfType, &description),
                description,
                up: a.OperStatus.0 == 1,
                speed: a.TransmitLinkSpeed.min(a.ReceiveLinkSpeed.max(a.TransmitLinkSpeed)),
                mac: a.PhysicalAddress[..mac_len].iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":"),
                ipv4,
                ipv6,
                gateways,
                dns,
                received: if counters { row.InOctets } else { 0 },
                sent: if counters { row.OutOctets } else { 0 },
            });
            node = a.Next;
        }
        out
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wifi {
    pub interface: String,
    pub ssid: String,
    /// 0–100.
    pub signal: u32,
    /// Link rates in Mbit/s.
    pub rx_mbps: u32,
    pub tx_mbps: u32,
    /// "open", "wep", "wpa", "wpa2", "wpa3", "owe" or "other".
    pub security: &'static str,
    /// "4", "5", "6", "7" (Wi-Fi generation) or "".
    pub generation: &'static str,
}

/// The current Wi-Fi connection of every wireless adapter that has one.
pub fn wifi() -> Vec<Wifi> {
    let mut out = Vec::new();
    // SAFETY: every list the API returns is freed with WlanFreeMemory; the handle is closed.
    unsafe {
        let (mut version, mut handle) = (0u32, HANDLE::default());
        if WlanOpenHandle(2, None, &mut version, &mut handle) != 0 {
            return out;
        }
        let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
        if WlanEnumInterfaces(handle, None, &mut list) == 0 && !list.is_null() {
            let count = (*list).dwNumberOfItems as usize;
            let items = std::slice::from_raw_parts((*list).InterfaceInfo.as_ptr(), count);
            for item in items {
                let mut size = 0u32;
                let mut data: *mut core::ffi::c_void = std::ptr::null_mut();
                if WlanQueryInterface(handle, &item.InterfaceGuid, wlan_intf_opcode_current_connection, None, &mut size, &mut data, None) != 0 || data.is_null() {
                    continue;
                }
                let c = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
                let a = &c.wlanAssociationAttributes;
                let ssid_len = (a.dot11Ssid.uSSIDLength as usize).min(32);
                let name_len = item.strInterfaceDescription.iter().position(|&u| u == 0).unwrap_or(256);
                out.push(Wifi {
                    interface: String::from_utf16_lossy(&item.strInterfaceDescription[..name_len]),
                    ssid: String::from_utf8_lossy(&a.dot11Ssid.ucSSID[..ssid_len]).into_owned(),
                    signal: a.wlanSignalQuality,
                    rx_mbps: a.ulRxRate / 1000,
                    tx_mbps: a.ulTxRate / 1000,
                    security: match c.wlanSecurityAttributes.dot11AuthAlgorithm.0 {
                        1 => "open",
                        2 => "wep",
                        3 | 4 => "wpa",
                        6 | 7 => "wpa2",
                        8 | 9 | 11 => "wpa3",
                        10 => "owe",
                        _ => "other",
                    },
                    generation: match a.dot11PhyType.0 {
                        7 => "4",
                        8 => "5",
                        10 => "6",
                        11 => "7",
                        _ => "",
                    },
                });
                WlanFreeMemory(data);
            }
            WlanFreeMemory(list as *const _);
        }
        WlanCloseHandle(handle, None);
    }
    out
}

/// One TCP connection or listening socket, with what is needed to ask for its byte counts.
#[derive(Clone)]
pub struct Tcp {
    pub pid: u32,
    pub local: SocketAddr,
    pub remote: SocketAddr,
    /// 2 = listening, 5 = established; see MIB_TCP_STATE.
    pub state: u32,
    row4: Option<MIB_TCPROW_LH>,
    row6: Option<MIB_TCP6ROW>,
}

fn port(raw: u32) -> u16 {
    u16::from_be((raw & 0xffff) as u16)
}

fn table(family: u32) -> Vec<u8> {
    let mut size = 0u32;
    // SAFETY: the first call reports the size; the second fills a buffer of at least that size.
    unsafe {
        GetExtendedTcpTable(None, &mut size, false, family, TCP_TABLE_OWNER_PID_ALL, 0);
        let mut buffer = vec![0u8; size as usize + 4096];
        size = buffer.len() as u32;
        if GetExtendedTcpTable(Some(buffer.as_mut_ptr().cast()), &mut size, false, family, TCP_TABLE_OWNER_PID_ALL, 0) != 0 {
            return Vec::new();
        }
        buffer
    }
}

pub fn tcp() -> Vec<Tcp> {
    let mut out = Vec::new();
    let v4 = table(2);
    if v4.len() >= 4 {
        let count = u32::from_ne_bytes(v4[..4].try_into().unwrap()) as usize;
        // SAFETY: a count followed by `count` rows, as laid out by the API.
        let rows = unsafe { std::slice::from_raw_parts(v4.as_ptr().add(4) as *const MIB_TCPROW_OWNER_PID, count) };
        for r in rows {
            out.push(Tcp {
                pid: r.dwOwningPid,
                local: SocketAddr::new(IpAddr::V4(Ipv4Addr::from(r.dwLocalAddr.to_ne_bytes())), port(r.dwLocalPort)),
                remote: SocketAddr::new(IpAddr::V4(Ipv4Addr::from(r.dwRemoteAddr.to_ne_bytes())), port(r.dwRemotePort)),
                state: r.dwState,
                row4: Some(MIB_TCPROW_LH { Anonymous: MIB_TCPROW_LH_0 { dwState: r.dwState }, dwLocalAddr: r.dwLocalAddr, dwLocalPort: r.dwLocalPort, dwRemoteAddr: r.dwRemoteAddr, dwRemotePort: r.dwRemotePort }),
                row6: None,
            });
        }
    }
    let v6 = table(23);
    if v6.len() >= 4 {
        let count = u32::from_ne_bytes(v6[..4].try_into().unwrap()) as usize;
        // SAFETY: as above.
        let rows = unsafe { std::slice::from_raw_parts(v6.as_ptr().add(4) as *const MIB_TCP6ROW_OWNER_PID, count) };
        for r in rows {
            out.push(Tcp {
                pid: r.dwOwningPid,
                local: SocketAddr::new(IpAddr::V6(Ipv6Addr::from(r.ucLocalAddr)), port(r.dwLocalPort)),
                remote: SocketAddr::new(IpAddr::V6(Ipv6Addr::from(r.ucRemoteAddr)), port(r.dwRemotePort)),
                state: r.dwState,
                row4: None,
                row6: Some(MIB_TCP6ROW {
                    State: MIB_TCP_STATE(r.dwState as i32),
                    LocalAddr: IN6_ADDR { u: IN6_ADDR_0 { Byte: r.ucLocalAddr } },
                    dwLocalScopeId: r.dwLocalScopeId,
                    dwLocalPort: r.dwLocalPort,
                    RemoteAddr: IN6_ADDR { u: IN6_ADDR_0 { Byte: r.ucRemoteAddr } },
                    dwRemoteScopeId: r.dwRemoteScopeId,
                    dwRemotePort: r.dwRemotePort,
                }),
            });
        }
    }
    out
}

/// Asks Windows to start counting this connection's bytes. Needs administrator rights.
pub fn enable_counting(t: &Tcp) -> bool {
    let rw = TCP_ESTATS_DATA_RW_v0 { EnableCollection: true };
    // SAFETY: `rw` is a plain struct passed as its own bytes; the row describes a live connection.
    unsafe {
        let bytes = std::slice::from_raw_parts((&raw const rw) as *const u8, size_of::<TCP_ESTATS_DATA_RW_v0>());
        match (&t.row4, &t.row6) {
            (Some(r), _) => SetPerTcpConnectionEStats(r, TcpConnectionEstatsData, bytes, 0, 0) == 0,
            (_, Some(r)) => SetPerTcp6ConnectionEStats(r, TcpConnectionEstatsData, bytes, 0, 0) == 0,
            _ => false,
        }
    }
}

/// Bytes received and sent on this connection since counting was enabled.
pub fn counted(t: &Tcp) -> Option<(u64, u64)> {
    let mut rod = vec![0u8; size_of::<TCP_ESTATS_DATA_ROD_v0>()];
    // SAFETY: the output buffer is exactly the size of the structure the API writes.
    unsafe {
        let status = match (&t.row4, &t.row6) {
            (Some(r), _) => GetPerTcpConnectionEStats(r, TcpConnectionEstatsData, None, 0, None, 0, Some(&mut rod), 0),
            (_, Some(r)) => GetPerTcp6ConnectionEStats(r, TcpConnectionEstatsData, None, 0, None, 0, Some(&mut rod), 0),
            _ => return None,
        };
        if status != 0 {
            return None;
        }
        let data = std::ptr::read_unaligned(rod.as_ptr() as *const TCP_ESTATS_DATA_ROD_v0);
        Some((data.DataBytesIn, data.DataBytesOut))
    }
}

/// Round-trip time to an IPv4 host in milliseconds, or `None` if it did not answer.
pub fn ping(to: Ipv4Addr, timeout_ms: u32) -> Option<u32> {
    // SAFETY: the reply buffer is sized for one reply plus its echoed data; the handle is closed.
    unsafe {
        let handle = IcmpCreateFile().ok()?;
        let payload = [0x44u8; 32];
        let mut reply = vec![0u8; size_of::<ICMP_ECHO_REPLY>() + payload.len() + 8];
        let count = IcmpSendEcho(handle, u32::from_ne_bytes(to.octets()), payload.as_ptr().cast(), payload.len() as u16, None, reply.as_mut_ptr().cast(), reply.len() as u32, timeout_ms);
        let _ = IcmpCloseHandle(handle);
        if count == 0 {
            return None;
        }
        let r = std::ptr::read_unaligned(reply.as_ptr() as *const ICMP_ECHO_REPLY);
        (r.Status == 0).then_some(r.RoundTripTime.max(1))
    }
}

/// Like `ping`, but sent from `from` — so it leaves through that adapter (e.g. Wi-Fi while a cable
/// is also plugged in).
pub fn ping_from(from: Ipv4Addr, to: Ipv4Addr, timeout_ms: u32) -> Option<u32> {
    // SAFETY: as in `ping`; no event or callback, so the call waits for the reply itself.
    unsafe {
        let handle = IcmpCreateFile().ok()?;
        let payload = [0x44u8; 32];
        let mut reply = vec![0u8; size_of::<ICMP_ECHO_REPLY>() + payload.len() + 8];
        let count = windows::Win32::NetworkManagement::IpHelper::IcmpSendEcho2Ex(
            handle,
            None,
            None,
            None,
            u32::from_ne_bytes(from.octets()),
            u32::from_ne_bytes(to.octets()),
            payload.as_ptr().cast(),
            payload.len() as u16,
            None,
            reply.as_mut_ptr().cast(),
            reply.len() as u32,
            timeout_ms,
        );
        let _ = IcmpCloseHandle(handle);
        if count == 0 {
            return None;
        }
        let r = std::ptr::read_unaligned(reply.as_ptr() as *const ICMP_ECHO_REPLY);
        (r.Status == 0).then_some(r.RoundTripTime.max(1))
    }
}

fn reverse_name(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0])
        }
        IpAddr::V6(v6) => {
            let nibbles: Vec<String> = v6.octets().iter().rev().flat_map(|b| [format!("{:x}", b & 0xf), format!("{:x}", b >> 4)]).collect();
            format!("{}.ip6.arpa", nibbles.join("."))
        }
    }
}

/// The host name an address says it belongs to (its PTR record), if any.
pub fn reverse(ip: IpAddr) -> Option<String> {
    let mut results: *mut DNS_RECORDW = std::ptr::null_mut();
    // SAFETY: the list the API allocates is read within its records and freed with the matching call.
    unsafe {
        if DnsQuery_W(&HSTRING::from(reverse_name(ip)), DNS_TYPE_PTR, DNS_QUERY_STANDARD, None, (&raw mut results).cast(), None).0 != 0 {
            return None;
        }
        let mut name = None;
        let mut record = results;
        while !record.is_null() {
            if (*record).wType == DNS_TYPE_PTR.0 {
                name = (*record).Data.PTR.pNameHost.to_string().ok();
                break;
            }
            record = (*record).pNext;
        }
        DnsFree(Some(results as *const _), DnsFreeRecordList);
        name.map(|n| n.trim_end_matches('.').to_string())
    }
}

/// How long resolving a name takes right now, skipping Windows' cache, in milliseconds.
pub fn dns_time(name: &str) -> Option<u32> {
    let mut results: *mut DNS_RECORDW = std::ptr::null_mut();
    let started = Instant::now();
    // SAFETY: as in `reverse`.
    unsafe {
        let status = DnsQuery_W(&HSTRING::from(name), DNS_TYPE_A, DNS_QUERY_BYPASS_CACHE, None, (&raw mut results).cast(), None);
        let took = started.elapsed().as_millis() as u32;
        if !results.is_null() {
            DnsFree(Some(results as *const _), DnsFreeRecordList);
        }
        (status.0 == 0).then_some(took.max(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverse_names_are_built_backwards() {
        assert_eq!(reverse_name("140.82.112.4".parse().unwrap()), "4.112.82.140.in-addr.arpa");
        assert!(reverse_name("2001:db8::1".parse().unwrap()).starts_with("1.0.0.0.0.0.0.0"));
        assert!(reverse_name("2001:db8::1".parse().unwrap()).ends_with("8.b.d.0.1.0.0.2.ip6.arpa"));
    }

    #[test]
    fn this_machine_has_adapters_and_connections() {
        let adapters = adapters();
        assert!(adapters.iter().any(|a| a.kind == "loopback" || a.up), "{adapters:?}");
        assert!(!tcp().is_empty());
    }

    #[test]
    fn loopback_answers_ping() {
        assert!(ping(Ipv4Addr::LOCALHOST, 1000).is_some());
    }

    #[test]
    fn adapter_kinds() {
        assert_eq!(kind(71, "Intel Wi-Fi 6E AX211"), "wifi");
        assert_eq!(kind(6, "Avast SecureLine VPN Adapter"), "vpn");
        assert_eq!(kind(6, "Realtek PCIe GbE"), "ethernet");
    }
}

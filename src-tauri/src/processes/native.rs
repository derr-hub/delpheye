//! The Windows-specific facts about processes that sysinfo does not give: which one owns which
//! window, which network connections it holds, its icon, and ending it.

use std::collections::HashMap;
use std::io::Cursor;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::Path;

use base64::Engine;
use serde::Serialize;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{BI_RGB, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC, GetDIBits, ReleaseDC};
use windows::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, EnumWindows, GW_OWNER, GWL_EXSTYLE, GetIconInfo, GetWindow, GetWindowLongW, GetWindowRect, GetWindowTextW,
    GetWindowThreadProcessId, HICON, ICONINFO, IsWindowVisible, PrivateExtractIconsW, WS_EX_TOOLWINDOW,
};
use windows::core::BOOL;

/// The title of each process's main window: visible, not a tool window, not hidden by DWM.
pub fn window_titles() -> HashMap<u32, String> {
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the map passed to `EnumWindows` below, alive for the whole call.
        let titles = unsafe { &mut *(lparam.0 as *mut HashMap<u32, String>) };
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid()) {
                return BOOL(1);
            }
            if GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
                return BOOL(1);
            }
            let mut cloaked = 0u32;
            if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&raw mut cloaked).cast(), 4).is_ok() && cloaked != 0 {
                return BOOL(1);
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() && (rect.right - rect.left < 2 || rect.bottom - rect.top < 2) {
                return BOOL(1);
            }
            let mut buffer = [0u16; 256];
            let len = GetWindowTextW(hwnd, &mut buffer);
            if len <= 0 {
                return BOOL(1);
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            titles.entry(pid).or_insert_with(|| String::from_utf16_lossy(&buffer[..len as usize]));
        }
        BOOL(1)
    }
    let mut titles: HashMap<u32, String> = HashMap::new();
    // SAFETY: the callback only touches `titles` through the pointer, during this call.
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&raw mut titles as isize));
    }
    titles
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub local: String,
    pub remote: String,
    /// "listen", "established" or "other" (closing, waiting…).
    pub state: &'static str,
}

fn state(code: u32) -> &'static str {
    match code {
        2 => "listen",
        5 => "established",
        _ => "other",
    }
}

fn port(raw: u32) -> u16 {
    u16::from_be((raw & 0xffff) as u16)
}

fn table(family: u32) -> Vec<u8> {
    let mut size = 0u32;
    // SAFETY: the first call only reports the size; the second fills a buffer of that size.
    unsafe {
        GetExtendedTcpTable(None, &mut size, false, family, TCP_TABLE_OWNER_PID_ALL, 0);
        let mut buffer = vec![0u8; size as usize + 1024];
        size = buffer.len() as u32;
        if GetExtendedTcpTable(Some(buffer.as_mut_ptr().cast()), &mut size, false, family, TCP_TABLE_OWNER_PID_ALL, 0) != 0 {
            return Vec::new();
        }
        buffer
    }
}

/// Every TCP connection and listening port, by owning process.
pub fn connections() -> HashMap<u32, Vec<Connection>> {
    let mut by_pid: HashMap<u32, Vec<Connection>> = HashMap::new();
    let v4 = table(2);
    if v4.len() >= 4 {
        let count = u32::from_ne_bytes(v4[..4].try_into().unwrap()) as usize;
        // SAFETY: the table is a count followed by `count` rows, laid out by the API.
        let rows = unsafe { std::slice::from_raw_parts(v4.as_ptr().add(4) as *const MIB_TCPROW_OWNER_PID, count) };
        for r in rows {
            by_pid.entry(r.dwOwningPid).or_default().push(Connection {
                local: format!("{}:{}", Ipv4Addr::from(r.dwLocalAddr.to_ne_bytes()), port(r.dwLocalPort)),
                remote: format!("{}:{}", Ipv4Addr::from(r.dwRemoteAddr.to_ne_bytes()), port(r.dwRemotePort)),
                state: state(r.dwState),
            });
        }
    }
    let v6 = table(23);
    if v6.len() >= 4 {
        let count = u32::from_ne_bytes(v6[..4].try_into().unwrap()) as usize;
        // SAFETY: as above; IPv6 rows start after the 4-byte count.
        let rows = unsafe { std::slice::from_raw_parts(v6.as_ptr().add(4) as *const MIB_TCP6ROW_OWNER_PID, count) };
        for r in rows {
            by_pid.entry(r.dwOwningPid).or_default().push(Connection {
                local: format!("[{}]:{}", Ipv6Addr::from(r.ucLocalAddr), port(r.dwLocalPort)),
                remote: format!("[{}]:{}", Ipv6Addr::from(r.ucRemoteAddr), port(r.dwRemotePort)),
                state: state(r.dwState),
            });
        }
    }
    by_pid
}

/// The program's icon as a PNG data URL, 32×32.
pub fn icon(path: &Path) -> Option<String> {
    let wide: Vec<u16> = path.as_os_str().encode_wide_null();
    if wide.len() > 260 {
        return None;
    }
    let mut name = [0u16; 260];
    name[..wide.len()].copy_from_slice(&wide);
    let mut icons = [HICON::default()];
    // SAFETY: every handle obtained here is released before returning; the pixel buffers are
    // sized for the 32×32, 32-bit bitmaps requested.
    unsafe {
        if PrivateExtractIconsW(&name, 0, 32, 32, Some(&mut icons), None, 0) == 0 || icons[0].is_invalid() {
            return None;
        }
        let icon = icons[0];
        let mut info = ICONINFO::default();
        let result = GetIconInfo(icon, &mut info).ok().and_then(|_| {
            let dc = GetDC(None);
            let read = |bitmap| {
                let mut header = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: 32,
                        biHeight: -32,
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                let mut pixels = vec![0u8; 32 * 32 * 4];
                let lines = GetDIBits(dc, bitmap, 0, 32, Some(pixels.as_mut_ptr().cast()), &mut header, DIB_RGB_COLORS);
                (lines == 32).then_some(pixels)
            };
            let color = (!info.hbmColor.is_invalid()).then(|| read(info.hbmColor)).flatten();
            let mask = (!info.hbmMask.is_invalid()).then(|| read(info.hbmMask)).flatten();
            ReleaseDC(None, dc);
            let mut bgra = color?;
            // Old icons carry no alpha; their transparency is in the mask (white = see-through).
            if bgra.chunks(4).all(|p| p[3] == 0) {
                let mask = mask?;
                for (pixel, m) in bgra.chunks_mut(4).zip(mask.chunks(4)) {
                    pixel[3] = if m[0] == 0 { 255 } else { 0 };
                }
            }
            // Files without an icon of their own come back fully transparent.
            if bgra.chunks(4).filter(|p| p[3] > 16).count() < 16 {
                return None;
            }
            for pixel in bgra.chunks_mut(4) {
                pixel.swap(0, 2);
            }
            encode_png(&bgra)
        });
        if !info.hbmColor.is_invalid() {
            let _ = DeleteObject(info.hbmColor.into());
        }
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(info.hbmMask.into());
        }
        let _ = DestroyIcon(icon);
        result
    }
}

fn encode_png(rgba: &[u8]) -> Option<String> {
    let mut bytes = Cursor::new(Vec::new());
    {
        let mut encoder = png::Encoder::new(&mut bytes, 32, 32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())))
}

/// Ends one process. Errors: "denied" (no rights), "gone", "failed".
pub fn terminate(pid: u32) -> Result<(), &'static str> {
    // SAFETY: the handle is closed on every path after it was opened.
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, false, pid).map_err(|e| if e.code().0 as u32 == 0x8007_0005 { "denied" } else { "gone" })?;
        let result = TerminateProcess(handle, 1).map_err(|e| if e.code().0 as u32 == 0x8007_0005 { "denied" } else { "failed" });
        let _ = CloseHandle(handle);
        result
    }
}

trait WideNull {
    fn encode_wide_null(&self) -> Vec<u16>;
}

impl WideNull for std::ffi::OsStr {
    fn encode_wide_null(&self) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        self.encode_wide().chain(std::iter::once(0)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_are_read_in_network_order() {
        // Port 443 arrives as 0x01BB in network byte order inside a little-endian DWORD.
        assert_eq!(port(u32::from(u16::to_be(443))), 443);
    }

    #[test]
    fn this_process_has_a_readable_icon_source_and_explorer_has_an_icon() {
        let windows = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
        let url = icon(&Path::new(&windows).join("explorer.exe")).expect("explorer has an icon");
        assert!(url.starts_with("data:image/png;base64,") && url.len() > 200);
    }

    #[test]
    fn a_missing_process_cannot_be_ended() {
        assert!(terminate(0xFFFF_FFF0).is_err());
    }
}

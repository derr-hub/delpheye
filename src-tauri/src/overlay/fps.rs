//! Frames per second of the app in front, counted from DirectX's own "present" events (ETW):
//! every frame a game shows goes through `Present`, and Windows reports each call. Windows lets
//! only administrators listen, so FPS is there while DelphEye runs as administrator.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HWND};
use windows::Win32::System::Diagnostics::Etw::*;
use windows::Win32::System::Threading::{OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
use windows::core::{GUID, PCWSTR, PWSTR};

const SESSION: &str = "DelphEye-FPS";
/// Microsoft-Windows-DXGI: event 42 is Present_Start (Direct3D 10, 11 and 12 swap chains).
const DXGI: GUID = GUID::from_u128(0xCA11C036_0102_4A2D_A6AD_F03CFED5D3C9);
/// Microsoft-Windows-D3D9: event 1 is Present_Start.
const D3D9: GUID = GUID::from_u128(0x783ACA0A_790E_4D7F_8451_AA850511C6B9);
/// Event timestamps are FILETIME ticks (100 ns).
const SECOND: i64 = 10_000_000;

/// 0 not started, 1 listening, 2 could not start.
static STATE: AtomicU8 = AtomicU8::new(0);
static PRESENTS: OnceLock<Mutex<HashMap<u32, VecDeque<i64>>>> = OnceLock::new();

fn presents() -> &'static Mutex<HashMap<u32, VecDeque<i64>>> {
    PRESENTS.get_or_init(Default::default)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fps {
    pub fps: f64,
    /// The average time between frames, ms.
    pub frame_ms: f64,
    /// The slowest frame of the last second, ms: a stutter shows here first.
    pub worst_ms: f64,
    pub app: String,
}

/// "listening", "off" (needs administrator) or "failed".
pub fn status() -> &'static str {
    match STATE.load(Ordering::SeqCst) {
        1 => "listening",
        2 => "failed",
        _ => "off",
    }
}

unsafe extern "system" fn on_event(record: *mut EVENT_RECORD) {
    let h = unsafe { &(*record).EventHeader };
    let id = h.EventDescriptor.Id;
    if !((h.ProviderId == DXGI && id == 42) || (h.ProviderId == D3D9 && id == 1)) {
        return;
    }
    if let Ok(mut map) = presents().lock() {
        let q = map.entry(h.ProcessId).or_default();
        q.push_back(h.TimeStamp);
        while q.len() > 2000 {
            q.pop_front();
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

/// The session's properties with its name after them, as ETW expects.
fn properties(name: &[u16]) -> Vec<u64> {
    let head = std::mem::size_of::<EVENT_TRACE_PROPERTIES>();
    let size = head + name.len() * 2;
    let mut buf = vec![0u64; size.div_ceil(8)];
    let p = buf.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES;
    unsafe {
        (*p).Wnode.BufferSize = size as u32;
        (*p).Wnode.Flags = WNODE_FLAG_TRACED_GUID;
        // Timestamps as system time.
        (*p).Wnode.ClientContext = 2;
        (*p).LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
        (*p).FlushTimer = 1;
        (*p).LoggerNameOffset = head as u32;
    }
    buf
}

/// Starts listening (once, in its own thread). False when DelphEye is not administrator.
pub fn start() -> bool {
    if !crate::system::is_elevated() {
        return false;
    }
    if STATE.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return STATE.load(Ordering::SeqCst) == 1;
    }
    std::thread::spawn(|| {
        if let Err(e) = unsafe { listen() } {
            STATE.store(2, Ordering::SeqCst);
            crate::errlog::write("overlay", &format!("fps: {e}"));
        }
    });
    true
}

unsafe fn listen() -> Result<(), String> {
    let name = wide(SESSION);
    unsafe {
        // A session left over from an earlier run (after a crash) would block the name.
        let mut old = properties(&name);
        let _ = ControlTraceW(CONTROLTRACE_HANDLE::default(), PCWSTR(name.as_ptr()), old.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES, EVENT_TRACE_CONTROL_STOP);
        let mut props = properties(&name);
        let mut session = CONTROLTRACE_HANDLE::default();
        let e = StartTraceW(&mut session, PCWSTR(name.as_ptr()), props.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES);
        if e != ERROR_SUCCESS {
            return Err(format!("StartTrace {}", e.0));
        }
        for provider in [DXGI, D3D9] {
            let _ = EnableTraceEx2(session, &provider, EVENT_CONTROL_CODE_ENABLE_PROVIDER.0, TRACE_LEVEL_INFORMATION as u8, 0, 0, 0, None);
        }
        let mut log = EVENT_TRACE_LOGFILEW { LoggerName: PWSTR(name.as_ptr() as *mut u16), ..Default::default() };
        log.Anonymous1.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
        log.Anonymous2.EventRecordCallback = Some(on_event);
        let trace = OpenTraceW(&mut log);
        if trace.Value == u64::MAX {
            let mut stop = properties(&name);
            let _ = ControlTraceW(session, PCWSTR::null(), stop.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES, EVENT_TRACE_CONTROL_STOP);
            return Err("OpenTrace".into());
        }
        crate::errlog::write("overlay", "fps listening");
        // Blocks for the life of the app.
        let _ = ProcessTrace(&[trace], None, None);
        let _ = CloseTrace(trace);
    }
    Ok(())
}

fn now_filetime() -> i64 {
    // FILETIME counts from 1601; Unix time from 1970.
    let unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as i64 / 100).unwrap_or(0);
    unix + 116_444_736_000_000_000
}

fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        Some(path.rsplit('\\').next().unwrap_or(&path).trim_end_matches(".exe").to_string())
    }
}

/// The process that owns the window in front.
pub fn foreground_pid() -> Option<u32> {
    unsafe {
        let w: HWND = GetForegroundWindow();
        if w.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(w, Some(&mut pid));
        (pid != 0).then_some(pid)
    }
}

/// Frames of `times` (FILETIME ticks) over the last second before `now`.
pub fn measure(times: &VecDeque<i64>, now: i64) -> Option<(f64, f64, f64)> {
    // Events reach the session up to a second late, so the newest one stands for "now".
    let last = *times.back()?;
    if now - last > 2 * SECOND {
        return None;
    }
    let from = last - SECOND;
    let recent: Vec<i64> = times.iter().copied().filter(|t| *t >= from).collect();
    if recent.len() < 2 {
        return None;
    }
    let gaps: Vec<f64> = recent.windows(2).map(|w| (w[1] - w[0]) as f64 / 10_000.0).collect();
    let span = (recent[recent.len() - 1] - recent[0]) as f64 / SECOND as f64;
    let fps = if span > 0.0 { (recent.len() - 1) as f64 / span } else { 0.0 };
    let avg = gaps.iter().sum::<f64>() / gaps.len() as f64;
    let worst = gaps.iter().copied().fold(0.0, f64::max);
    Some((fps, avg, worst))
}

/// FPS of the app in front, when it is showing frames through DirectX.
pub fn current() -> Option<Fps> {
    if STATE.load(Ordering::SeqCst) != 1 {
        return None;
    }
    let pid = foreground_pid()?;
    let now = now_filetime();
    let result = {
        let mut map = presents().lock().ok()?;
        // Forget apps that stopped showing frames.
        map.retain(|_, q| q.back().is_some_and(|t| now - t < 5 * SECOND));
        measure(map.get(&pid)?, now)
    };
    let (fps, frame_ms, worst_ms) = result?;
    Some(Fps { fps: (fps * 10.0).round() / 10.0, frame_ms: (frame_ms * 10.0).round() / 10.0, worst_ms: (worst_ms * 10.0).round() / 10.0, app: process_name(pid).unwrap_or_default() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sixty_frames_a_second() {
        let now = 1_000 * SECOND;
        let times: VecDeque<i64> = (0..120).map(|i| now - 2 * SECOND + i * SECOND / 60).collect();
        let (fps, avg, worst) = measure(&times, now).unwrap();
        assert!((fps - 60.0).abs() < 1.0, "{fps}");
        assert!((avg - 16.7).abs() < 0.5 && worst < 17.5, "{avg} {worst}");
    }

    #[test]
    fn a_stutter_shows_as_the_worst_frame() {
        let now = 1_000 * SECOND;
        let mut times: VecDeque<i64> = (0..60).map(|i| now - SECOND + i * SECOND / 60).collect();
        times.push_back(now + SECOND / 10);
        let (_, _, worst) = measure(&times, now).unwrap();
        assert!(worst > 90.0, "{worst}");
    }

    #[test]
    fn stopped_apps_have_no_fps() {
        let now = 1_000 * SECOND;
        let times: VecDeque<i64> = (0..60).map(|i| now - 10 * SECOND + i * SECOND / 60).collect();
        assert!(measure(&times, now).is_none());
    }
}

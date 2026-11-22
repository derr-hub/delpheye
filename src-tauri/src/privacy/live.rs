//! Who is using the camera and the microphone at this moment, from Windows' own live sources.
//!
//! Since the 2026 Windows 11 updates the registry records (see `mod.rs`) are no longer written,
//! so "right now" comes from here instead:
//! - camera: Media Foundation's sensor activity monitor, which Windows itself calls whenever a
//!   process starts or stops streaming from a camera;
//! - microphone: the active audio sessions on recording devices, each owned by one process.
//!
//! Neither needs administrator rights.

use std::collections::HashMap;
use std::sync::Mutex;

use windows::Win32::Media::Audio::{
    AudioSessionStateActive, DEVICE_STATE_ACTIVE, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator, eCapture,
};
use windows::Win32::Media::MediaFoundation::{
    IMFSensorActivitiesReport, IMFSensorActivitiesReportCallback, IMFSensorActivitiesReportCallback_Impl, MF_VERSION, MFCreateSensorActivityMonitor,
    MFSTARTUP_LITE, MFStartup,
};
use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx};
use windows::core::{Interface, Ref, implement};

/// Camera device → processes streaming from it, as last reported.
static CAMERA: Mutex<Option<HashMap<String, Vec<u32>>>> = Mutex::new(None);

#[implement(IMFSensorActivitiesReportCallback)]
struct Reports;

impl IMFSensorActivitiesReportCallback_Impl for Reports_Impl {
    fn OnActivitiesReport(&self, report: Ref<IMFSensorActivitiesReport>) -> windows::core::Result<()> {
        let Some(report) = report.as_ref() else { return Ok(()) };
        // SAFETY: plain COM calls on objects Windows hands us for the duration of the callback;
        // the name buffer is passed with its length.
        unsafe {
            let mut state = CAMERA.lock().unwrap();
            let devices = state.get_or_insert_with(HashMap::new);
            for i in 0..report.GetCount()? {
                let activity = report.GetActivityReport(i)?;
                let mut name = [0u16; 512];
                let mut written = 0u32;
                let _ = activity.GetSymbolicLink(&mut name, &mut written);
                let device = String::from_utf16_lossy(&name[..(written as usize).min(name.len())]).trim_end_matches('\0').to_string();
                let mut pids = Vec::new();
                for j in 0..activity.GetProcessCount()? {
                    let process = activity.GetProcessActivity(j)?;
                    if process.GetStreamingState()?.as_bool() {
                        pids.push(process.GetProcessId()?);
                    }
                }
                devices.insert(device, pids);
            }
        }
        Ok(())
    }
}

/// Starts listening for camera use; Windows reports the current state right away, then changes.
pub fn start_camera_monitor() {
    std::thread::spawn(|| {
        // SAFETY: COM and Media Foundation are initialised for this thread, which then keeps the
        // monitor (and so the callback) alive for the life of the app.
        let monitor = unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_LITE) {
                crate::errlog::write("privacy", &format!("MFStartup failed: {e}"));
                return;
            }
            let callback: IMFSensorActivitiesReportCallback = Reports.into();
            match MFCreateSensorActivityMonitor(&callback).and_then(|m| m.Start().map(|_| m)) {
                Ok(m) => m,
                Err(e) => {
                    crate::errlog::write("privacy", &format!("camera monitor unavailable: {e}"));
                    return;
                }
            }
        };
        loop {
            std::thread::park();
            let _ = &monitor;
        }
    });
}

/// Processes streaming from any camera now.
pub fn camera_pids() -> Vec<u32> {
    let state = CAMERA.lock().unwrap();
    let mut pids: Vec<u32> = state.iter().flat_map(|m| m.values().flatten().copied()).collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// Processes recording from any microphone now.
pub fn microphone_pids() -> Vec<u32> {
    let mut pids = Vec::new();
    // SAFETY: plain COM calls; every interface is released when it goes out of scope.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(devices): windows::core::Result<IMMDeviceEnumerator> = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return pids };
        let Ok(list) = devices.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) else { return pids };
        for i in 0..list.GetCount().unwrap_or(0) {
            let Ok(device) = list.Item(i) else { continue };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(sessions) = manager.GetSessionEnumerator() else { continue };
            for j in 0..sessions.GetCount().unwrap_or(0) {
                let Ok(session) = sessions.GetSession(j) else { continue };
                if session.GetState().ok() != Some(AudioSessionStateActive) {
                    continue;
                }
                let Ok(session) = session.cast::<IAudioSessionControl2>() else { continue };
                if session.IsSystemSoundsSession() == windows::Win32::Foundation::S_OK {
                    continue;
                }
                if let Ok(pid) = session.GetProcessId() {
                    if pid != 0 {
                        pids.push(pid);
                    }
                }
            }
        }
    }
    pids.sort_unstable();
    pids.dedup();
    pids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_sources_answer() {
        start_camera_monitor();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        println!("camera: {:?}", camera_pids());
        println!("microphone: {:?}", microphone_pids());
        assert!(CAMERA.lock().unwrap().is_some(), "the camera monitor never reported");
    }
}

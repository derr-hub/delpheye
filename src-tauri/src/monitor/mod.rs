//! Monitoring: live hardware sensors, and checks of how healthy and stable the system is.

pub mod cooling;
pub mod fans;
pub mod gpu;
pub mod ram;
pub mod slowdown;
pub mod health;
pub mod verdict;
pub mod sidecar;
pub mod stress;
pub mod throttle;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::journal::Journal;
use crate::system::{self, Dirs};
use fans::{Level, Sample};
use health::Check;
use sidecar::{Frame, Sensors, Status};

/// How far back fans are judged in the background.
const FAN_WINDOW: usize = 300;

#[derive(Default)]
pub struct MonitorState {
    pub sensors: Arc<Sensors>,
    stress_running: AtomicBool,
    stress_cancel: Arc<AtomicBool>,
}

pub fn spawn(app: AppHandle, state: &MonitorState) {
    sidecar::spawn(app, state.sensors.clone());
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorStatus {
    sensors: Status,
    elevated: bool,
}

#[tauri::command]
pub fn monitor_status(state: State<'_, MonitorState>) -> MonitorStatus {
    MonitorStatus { sensors: state.sensors.status.lock().unwrap().clone(), elevated: system::is_elevated() }
}

/// Recent frames so charts start filled rather than empty. At most five minutes.
#[tauri::command]
pub fn monitor_history(state: State<'_, MonitorState>, seconds: usize) -> Vec<Frame> {
    state.sensors.recent(seconds.min(300))
}

/// Judges every fan on how it behaved over the last few minutes.
fn fan_checks(frames: &[Frame]) -> Vec<Check> {
    let mut series: BTreeMap<String, Vec<Sample>> = BTreeMap::new();
    let start = frames.first().map_or(0, |f| f.at);
    for frame in frames {
        let temp = frame.reference_temp();
        let load = frame.cpu_load();
        for (_, name, rpm) in frame.fans() {
            series.entry(name).or_default().push(Sample { t: (frame.at - start) as f64 / 1000.0, rpm, temp, load });
        }
    }
    series
        .into_iter()
        .map(|(name, samples)| {
            let verdict = fans::analyze(&samples);
            Check::new("fan", Some(name), verdict.level, verdict.reasons.clone(), serde_json::to_value(&verdict).unwrap_or_default())
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickReport {
    elevated: bool,
    sensors: Status,
    /// Days of the crash record that were read.
    log_days: u64,
    checks: Vec<Check>,
}

/// Checks that need no load: crash record, disks, battery, and the fans as they ran lately.
#[tauri::command]
pub async fn health_quick(state: State<'_, MonitorState>) -> Result<QuickReport, String> {
    let dirs = Dirs::real().ok_or("environment")?;
    let log = tauri::async_runtime::spawn_blocking(move || health::read_crash_log(&dirs.windows)).await.map_err(|e| e.to_string())?;

    let mut checks = Vec::new();
    match log {
        Some(log) => checks.extend(health::crash_checks(&log)),
        None => checks.push(Check::new("crashes", None, Level::Unknown, vec!["log-unreadable"], serde_json::Value::Null)),
    }
    let frames = state.sensors.recent(FAN_WINDOW);
    if let Some(frame) = frames.last() {
        checks.extend(health::disk_checks(frame));
        checks.extend(health::battery_check(frame));
        let fans = fan_checks(&frames);
        if fans.is_empty() {
            let reason = if frame.elevated { "no-fan-sensors" } else { "fans-need-admin" };
            checks.push(Check::new("fans", None, Level::Unknown, vec![reason], serde_json::Value::Null));
        }
        checks.extend(fans);
    }
    Ok(QuickReport {
        elevated: system::is_elevated(),
        sensors: state.sensors.status.lock().unwrap().clone(),
        log_days: health::LOG_DAYS,
        checks,
    })
}

/// Runs the three-minute stability test, reporting progress as `stability:progress`.
/// Errors: `"busy"`.
#[tauri::command]
pub async fn stability_run(app: AppHandle, state: State<'_, MonitorState>, journal: State<'_, Journal>, options: Option<stress::Options>) -> Result<stress::Report, String> {
    if state.stress_running.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    state.stress_cancel.store(false, Ordering::SeqCst);
    let (sensors, cancel) = (state.sensors.clone(), state.stress_cancel.clone());
    let report = tauri::async_runtime::spawn_blocking(move || {
        stress::run(options.unwrap_or_default(), &sensors, &cancel, &|point, plan| {
            let _ = app.emit("stability:progress", serde_json::json!({ "point": point, "total": plan.total(), "plan": plan }));
        })
    })
    .await;
    state.stress_running.store(false, Ordering::SeqCst);
    let mut report = report.map_err(|e| e.to_string())?;
    if let Some(profile) = &report.cooling {
        let earlier = cooling::history(&journal);
        report.checks.push(cooling::trend(&earlier, profile));
        if let Err(e) = cooling::save(&journal, profile) {
            eprintln!("cooling: cannot save the run: {e}");
        }
    }
    report.history = cooling::history(&journal);
    Ok(report)
}

/// Watches the machine for a few seconds and says what slows it down, reporting progress as
/// `slowdown:progress`.
#[tauri::command]
pub async fn slowdown_check(app: AppHandle, state: State<'_, MonitorState>) -> Result<slowdown::Diagnosis, String> {
    let sensors = state.sensors.clone();
    tauri::async_runtime::spawn_blocking(move || {
        slowdown::run(&sensors, &|second| {
            let _ = app.emit("slowdown:progress", second);
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// The graphics adapters the stress test can load, discrete cards first.
#[tauri::command]
pub fn gpu_adapters() -> Vec<gpu::GpuInfo> {
    gpu::adapters()
}

/// Every kept cooling profile, oldest first.
#[tauri::command]
pub fn cooling_history(journal: State<'_, Journal>) -> Vec<cooling::Profile> {
    cooling::history(&journal)
}

#[tauri::command]
pub fn stability_cancel(state: State<'_, MonitorState>) {
    state.stress_cancel.store(true, Ordering::SeqCst);
}

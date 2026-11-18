//! Runs the .NET sensor helper and keeps the last few minutes of what it reports.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const HELPER: &str = "DelphEye.Sensors.exe";
/// Ten minutes of one-per-second frames.
pub const HISTORY: usize = 600;
const RESTARTS: u32 = 5;

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Sensor {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub value: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub parent: Option<String>,
    pub sensors: Vec<Sensor>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub name: String,
    pub media: String,
    pub health: String,
    pub size: u64,
}

/// A firmware (ACPI) thermal zone as Windows reports it.
#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Zone {
    pub name: String,
    pub temp: f64,
    /// The firmware's passive-cooling cap in percent; below 100 it is slowing the CPU down.
    #[serde(default)]
    pub passive: Option<f64>,
}

/// What Windows itself measures about the processor — available without drivers or admin rights.
#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WinCpu {
    /// Work done relative to the nominal clock, in percent; above 100 means turbo.
    #[serde(default)]
    pub perf: Option<f64>,
    #[serde(default)]
    pub nominal_mhz: Option<f64>,
    #[serde(default)]
    pub utility: Option<f64>,
    #[serde(default)]
    pub zones: Vec<Zone>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    /// Unix milliseconds.
    pub at: i64,
    pub elevated: bool,
    pub hardware: Vec<Hardware>,
    #[serde(default)]
    pub disks: Vec<Disk>,
    #[serde(default)]
    pub windows: Option<WinCpu>,
    /// Filled in here, not by the helper.
    #[serde(default)]
    pub throttle: Option<super::throttle::Throttle>,
}

impl Frame {
    pub fn sensors(&self) -> impl Iterator<Item = (&Hardware, &Sensor)> {
        self.hardware.iter().flat_map(|h| h.sensors.iter().map(move |s| (h, s)))
    }

    /// The processor's temperature: its own sensor when readable, else the hottest firmware zone.
    pub fn cpu_temp(&self) -> Option<f64> {
        self.sensor_cpu_temp().or_else(|| self.zone_temp())
    }

    /// The hottest ACPI thermal zone; on laptops that is the one next to the processor.
    pub fn zone_temp(&self) -> Option<f64> {
        self.windows.as_ref()?.zones.iter().map(|z| z.temp).reduce(f64::max)
    }

    /// The real average clock of all cores including turbo, as Windows measures it.
    pub fn effective_mhz(&self) -> Option<f64> {
        let w = self.windows.as_ref()?;
        Some(w.nominal_mhz? * w.perf? / 100.0).filter(|m| *m > 0.0)
    }

    /// Whether the machine is running on its battery right now.
    pub fn on_battery(&self) -> bool {
        self.sensors().any(|(h, s)| {
            h.kind == "Battery"
                && s.kind == "Power"
                && ((s.name.contains("Discharge Rate") && !s.name.contains("Charge/") && s.value > 0.1) || (s.name.contains("Charge/Discharge") && s.value < -0.1))
        })
    }

    /// The CPU package temperature, or the hottest core when there is no package reading.
    pub fn sensor_cpu_temp(&self) -> Option<f64> {
        let temps: Vec<&Sensor> = self.sensors().filter(|(h, s)| h.kind == "Cpu" && s.kind == "Temperature").map(|(_, s)| s).collect();
        temps
            .iter()
            .find(|s| s.name.contains("Package"))
            .or_else(|| temps.iter().max_by(|a, b| a.value.total_cmp(&b.value)))
            .map(|s| s.value)
            .filter(|v| *v > 0.0)
    }

    /// The hottest GPU core reading.
    pub fn gpu_temp(&self) -> Option<f64> {
        self.sensors()
            .filter(|(h, s)| h.kind.starts_with("Gpu") && s.kind == "Temperature" && s.name.contains("Core"))
            .map(|(_, s)| s.value)
            .max_by(f64::total_cmp)
    }

    /// What a fan's speed should be compared with: the CPU if it can be read, else the GPU.
    pub fn reference_temp(&self) -> Option<f64> {
        self.cpu_temp().or_else(|| self.gpu_temp())
    }

    /// The average real clock of the CPU cores, in MHz: from the CPU's own sensors when they can
    /// be read (administrator rights and a driver), else Windows' measured clock, turbo included.
    pub fn cpu_clock(&self) -> Option<f64> {
        self.sensor_cpu_clock().or_else(|| self.effective_mhz())
    }

    fn sensor_cpu_clock(&self) -> Option<f64> {
        let clocks: Vec<f64> = self
            .sensors()
            .filter(|(h, s)| h.kind == "Cpu" && s.kind == "Clock" && s.name.contains("Core") && s.value > 0.0)
            .map(|(_, s)| s.value)
            .collect();
        (!clocks.is_empty()).then(|| clocks.iter().sum::<f64>() / clocks.len() as f64)
    }

    pub fn cpu_load(&self) -> Option<f64> {
        self.sensors()
            .find(|(h, s)| h.kind == "Cpu" && s.kind == "Load" && s.name == "CPU Total")
            .map(|(_, s)| s.value)
            .or_else(|| self.windows.as_ref()?.utility.map(|u| u.min(100.0)))
    }

    /// Every fan speed sensor, as (sensor id, readable name, rpm).
    pub fn fans(&self) -> Vec<(String, String, f64)> {
        self.sensors()
            .filter(|(_, s)| s.kind == "Fan")
            .map(|(h, s)| (s.id.clone(), format!("{} · {}", h.name, s.name), s.value))
            .collect()
    }
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The helper is running and has reported at least once.
    pub running: bool,
    /// Why it is not, as a short code: "missing", "failed", "crashed".
    pub problem: Option<String>,
}

#[derive(Default)]
pub struct Sensors {
    pub history: Mutex<VecDeque<Frame>>,
    pub status: Mutex<Status>,
}

impl Sensors {
    pub fn latest(&self) -> Option<Frame> {
        self.history.lock().unwrap().back().cloned()
    }

    /// The frames of the last `seconds` seconds, oldest first.
    pub fn recent(&self, seconds: usize) -> Vec<Frame> {
        let history = self.history.lock().unwrap();
        history.iter().skip(history.len().saturating_sub(seconds)).cloned().collect()
    }
}

/// Where the helper is: next to the app when installed, or in the build folder while developing.
pub fn helper_path() -> Option<PathBuf> {
    // While developing, the helper can be pointed at or taken from its build folder; an
    // installed copy only ever runs the helper that was installed next to it.
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("DELPHEYE_SENSORS").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(path);
    }
    let beside = std::env::current_exe().ok()?.parent()?.join(HELPER);
    if beside.is_file() {
        return Some(beside);
    }
    #[cfg(debug_assertions)]
    {
        let built = PathBuf::from(std::env::var_os("USERPROFILE")?)
            .join(r".cargo-target\delpheye-sensors\bin\Release\net9.0-windows")
            .join(HELPER);
        if built.is_file() {
            return Some(built);
        }
    }
    None
}

/// Starts the helper in the background and keeps it running.
pub fn spawn(app: AppHandle, sensors: Arc<Sensors>) {
    std::thread::spawn(move || {
        let set = |problem: Option<&str>, running: bool| {
            *sensors.status.lock().unwrap() = Status { running, problem: problem.map(str::to_string) };
        };
        let Some(path) = helper_path() else {
            set(Some("missing"), false);
            return;
        };
        for _ in 0..RESTARTS {
            let child = Command::new(&path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
            let Ok(mut child) = child else {
                set(Some("failed"), false);
                return;
            };
            // Keeping stdin open is what keeps the helper alive; it quits when we go away.
            let _stdin = child.stdin.take();
            let Some(stdout) = child.stdout.take() else { break };
            let mut tracker = super::throttle::Tracker::default();
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(mut frame) = serde_json::from_str::<Frame>(&line) else { continue };
                frame.throttle = Some(tracker.update(&frame));
                {
                    let mut history = sensors.history.lock().unwrap();
                    if history.len() == HISTORY {
                        history.pop_front();
                    }
                    history.push_back(frame.clone());
                }
                set(None, true);
                if app.emit("sensors", &frame).is_err() {
                    let _ = child.kill();
                    return;
                }
            }
            let _ = child.wait();
            set(Some("crashed"), false);
            std::thread::sleep(Duration::from_secs(3));
        }
    });
}

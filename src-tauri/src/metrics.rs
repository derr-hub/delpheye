//! Live system metrics: a background thread samples the machine once a second
//! and pushes a snapshot to the UI through the `metrics` event.

use serde::Serialize;
use std::collections::HashMap;
use std::{thread, time::Duration, time::Instant};
use sysinfo::{
    CpuRefreshKind, Disks, MemoryRefreshKind, Networks, ProcessRefreshKind, ProcessesToUpdate,
    RefreshKind, System, UpdateKind,
};
use tauri::{AppHandle, Emitter};

use crate::cpu::CpuSampler;

const TICK: Duration = Duration::from_millis(1000);
const DISK_REFRESH_EVERY: u32 = 10;
const TOP_PROCESSES: usize = 6;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    os_name: String,
    os_version: String,
    host_name: String,
    cpu_brand: String,
    physical_cores: usize,
    logical_cores: usize,
    total_memory: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiskInfo {
    name: String,
    mount: String,
    file_system: String,
    kind: String,
    total: u64,
    available: u64,
    removable: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProcessInfo {
    /// How many processes share this name.
    count: u32,
    name: String,
    cpu: f32,
    memory: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    cpu_usage: f32,
    cpu_frequency: u64,
    per_core: Vec<f32>,
    mem_used: u64,
    mem_total: u64,
    swap_used: u64,
    swap_total: u64,
    disks: Vec<DiskInfo>,
    uptime: u64,
    process_count: usize,
    net_rx: u64,
    net_tx: u64,
    top_processes: Vec<ProcessInfo>,
}

#[tauri::command]
pub fn system_info() -> Result<SystemInfo, String> {
    let sys = System::new_with_specifics(
        RefreshKind::nothing()
            // Not `everything()`: asking for usage would open the PDH query (see cpu.rs).
            .with_cpu(CpuRefreshKind::nothing().with_frequency())
            .with_memory(MemoryRefreshKind::everything()),
    )
    .map_err(|e| e.to_string())?;
    Ok(SystemInfo {
        os_name: System::name().unwrap_or_default(),
        os_version: System::os_version().unwrap_or_default(),
        host_name: System::host_name().unwrap_or_default(),
        cpu_brand: sys
            .cpus()
            .first()
            .map(|c| c.brand().trim().to_string())
            .unwrap_or_default(),
        physical_cores: System::physical_core_count().unwrap_or(0),
        logical_cores: sys.cpus().len(),
        total_memory: sys.total_memory(),
    })
}

fn read_disks(disks: &Disks) -> Vec<DiskInfo> {
    disks
        .iter()
        .map(|d| DiskInfo {
            name: d.name().to_string_lossy().into_owned(),
            mount: d.mount_point().to_string_lossy().into_owned(),
            file_system: d.file_system().to_string_lossy().into_owned(),
            kind: d.kind().to_string(),
            total: d.total_space(),
            available: d.available_space(),
            removable: d.is_removable(),
        })
        .collect()
}

pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let (Ok(mut sys), Ok(mut disks), Ok(mut networks)) = (
            System::new(),
            Disks::new_with_refreshed_list(),
            Networks::new_with_refreshed_list(),
        ) else {
            eprintln!("metrics: failed to initialise system probes");
            return;
        };
        // Executable and command line never change, so they are read once per process.
        let process_kind = ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_disk_usage()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet);

        // Load comes from our own sampler (see cpu.rs); sysinfo only supplies clock speed.
        let frequency_only = CpuRefreshKind::nothing().with_frequency();
        let mut cpu = CpuSampler::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, process_kind);

        let mut tick: u32 = 0;
        let mut last = Instant::now();
        loop {
            thread::sleep(TICK);
            tick = tick.wrapping_add(1);
            let elapsed = last.elapsed().as_secs_f64().max(0.001);
            last = Instant::now();

            let load = cpu.sample();
            sys.refresh_cpu_specifics(frequency_only);
            sys.refresh_memory();
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, process_kind);
            networks.refresh(true);
            if tick % DISK_REFRESH_EVERY == 0 {
                disks.refresh(true);
            }

            let cores = load.per_core.len().max(1) as f32;
            crate::processes::publish(&sys, cores, elapsed);
            // Group by executable name, as Task Manager does, so an app that runs as
            // many processes shows up once with its real total.
            let mut by_name: HashMap<String, ProcessInfo> = HashMap::new();
            for p in sys.processes().values().filter(|p| p.pid().as_u32() != 0) {
                let name = p.name().to_string_lossy().into_owned();
                let entry = by_name.entry(name.clone()).or_insert(ProcessInfo {
                    count: 0,
                    name,
                    cpu: 0.0,
                    memory: 0,
                });
                entry.count += 1;
                // sysinfo reports per-core percentages; normalise to the whole CPU.
                entry.cpu += p.cpu_usage() / cores;
                entry.memory += p.memory();
            }
            let mut top: Vec<ProcessInfo> = by_name.into_values().collect();
            top.sort_by(|a, b| b.memory.cmp(&a.memory));
            top.truncate(TOP_PROCESSES);

            let (rx, tx) = networks
                .values()
                .fold((0u64, 0u64), |(rx, tx), n| {
                    (rx + n.received(), tx + n.transmitted())
                });

            let snapshot = Snapshot {
                cpu_usage: load.total,
                cpu_frequency: sys.cpus().first().map(|c| c.frequency()).unwrap_or(0),
                per_core: load.per_core,
                mem_used: sys.used_memory(),
                mem_total: sys.total_memory(),
                swap_used: sys.used_swap(),
                swap_total: sys.total_swap(),
                disks: read_disks(&disks),
                uptime: System::uptime().unwrap_or(0),
                process_count: sys.processes().len(),
                net_rx: (rx as f64 / elapsed) as u64,
                net_tx: (tx as f64 / elapsed) as u64,
                top_processes: top,
            };

            if let Err(e) = app.emit("metrics", snapshot) {
                eprintln!("metrics: emit failed, stopping sampler: {e}");
                break;
            }
        }
    });
}

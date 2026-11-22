//! "Why is it slow right now?" — watches the machine for a few seconds and names the likely
//! culprits in plain words: a busy processor (and who keeps it busy), memory that has run out,
//! a disk at its limit, heat, a power-saving mode, or simply a computer that has just started.
//!
//! Disk and paging figures come straight from the disk driver and the kernel rather than
//! performance counters, which are broken on some machines.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, GetDiskFreeSpaceExW, OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES};
use windows::Win32::System::IO::DeviceIoControl;
use windows::Win32::System::Power::{GetSystemPowerStatus, PowerGetActiveScheme, SYSTEM_POWER_STATUS};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::core::HSTRING;

use super::fans::Level;
use super::sidecar::Sensors;
use super::throttle::State as ThrottleState;
use crate::cpu::CpuSampler;
use crate::processes;

const SECONDS: u64 = 8;
/// IOCTL_DISK_PERFORMANCE: allowed without any access rights, so no administrator needed.
const IOCTL_DISK_PERFORMANCE: u32 = 0x0007_0020;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct DiskPerformance {
    bytes_read: i64,
    bytes_written: i64,
    read_time: i64,
    write_time: i64,
    idle_time: i64,
    read_count: u32,
    write_count: u32,
    queue_depth: u32,
    split_count: u32,
    query_time: i64,
    storage_device_number: u32,
    storage_manager_name: [u16; 8],
}

/// Opens every physical disk once, for reading its activity statistics.
fn open_disks() -> Vec<HANDLE> {
    (0..16)
        .filter_map(|n| {
            // SAFETY: opening a device for no access at all; the handle is closed by the caller.
            unsafe { CreateFileW(&HSTRING::from(format!(r"\\.\PhysicalDrive{n}")), 0, FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES(0), None).ok() }
        })
        .collect()
}

fn disk_stats(handle: HANDLE) -> Option<DiskPerformance> {
    let mut perf = DiskPerformance::default();
    let mut returned = 0u32;
    // SAFETY: the output buffer is the structure the driver fills.
    unsafe {
        DeviceIoControl(handle, IOCTL_DISK_PERFORMANCE, None, 0, Some((&raw mut perf).cast()), size_of::<DiskPerformance>() as u32, Some(&mut returned), None).ok()?;
    }
    (returned as usize >= 48).then_some(perf)
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQuerySystemInformation(class: u32, info: *mut core::ffi::c_void, length: u32, returned: *mut u32) -> i32;
}

/// Pages read back from disk so far (hard page faults that went to the page file or files).
fn page_reads() -> Option<u32> {
    // SystemPerformanceInformation; PageReadCount sits at offset 80.
    let mut buffer = vec![0u8; 1024];
    let mut returned = 0u32;
    // SAFETY: the buffer is larger than the structure the kernel writes and its size is passed.
    let status = unsafe { NtQuerySystemInformation(2, buffer.as_mut_ptr().cast(), buffer.len() as u32, &mut returned) };
    (status >= 0 && returned >= 88).then(|| u32::from_le_bytes(buffer[80..84].try_into().unwrap()))
}

fn memory() -> Option<(u32, f64)> {
    let mut m = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    // SAFETY: a plain query into a sized struct.
    unsafe { GlobalMemoryStatusEx(&mut m).ok()? };
    let commit = if m.ullTotalPageFile > 0 { (1.0 - m.ullAvailPageFile as f64 / m.ullTotalPageFile as f64) * 100.0 } else { 0.0 };
    Some((m.dwMemoryLoad, commit))
}

/// On mains or battery, battery saver on, and which power plan is active.
fn power() -> (Option<bool>, bool, Option<&'static str>) {
    let mut status = SYSTEM_POWER_STATUS::default();
    // SAFETY: a plain query into a struct.
    let (on_battery, saver) = if unsafe { GetSystemPowerStatus(&mut status) }.is_ok() {
        (match status.ACLineStatus { 0 => Some(true), 1 => Some(false), _ => None }, status.SystemStatusFlag == 1)
    } else {
        (None, false)
    };
    let mut guid = std::ptr::null_mut();
    // SAFETY: the API allocates the GUID, which is freed with LocalFree.
    let plan = unsafe {
        if PowerGetActiveScheme(None, &mut guid).0 == 0 && !guid.is_null() {
            let text = format!("{:?}", *guid).to_lowercase();
            let _ = windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(guid.cast())));
            Some(match text.as_str() {
                t if t.starts_with("a1841308") => "saver",
                t if t.starts_with("381b4222") => "balanced",
                t if t.starts_with("8c5e7fda") => "high",
                t if t.starts_with("e9a42b02") => "ultimate",
                _ => "custom",
            })
        } else {
            None
        }
    };
    (on_battery, saver, plan)
}

/// Free and total bytes of a drive such as "C:".
pub fn drive_free(drive: &str) -> Option<(u64, u64)> {
    let (mut free, mut total) = (0u64, 0u64);
    // SAFETY: plain query.
    unsafe { GetDiskFreeSpaceExW(&HSTRING::from(format!(r"{drive}\")), Some(&mut free), Some(&mut total), None).ok()? };
    Some((free, total))
}

fn system_drive_free() -> Option<(u64, u64)> {
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    let (mut free, mut total) = (0u64, 0u64);
    // SAFETY: plain query.
    unsafe { GetDiskFreeSpaceExW(&HSTRING::from(format!(r"{drive}\")), Some(&mut free), Some(&mut total), None).ok()? };
    Some((free, total))
}

/// A program, as the diagnosis names it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Culprit {
    pub name: String,
    pub description: Option<String>,
    pub exe: Option<String>,
    pub known: Option<&'static str>,
    pub count: u32,
    /// Average share of the whole CPU, in percent.
    pub cpu: f64,
    /// Average bytes read and written per second.
    pub disk: f64,
    pub memory: u64,
    /// The process to open in the Processes page.
    pub pid: u32,
    pub start: u64,
}

/// What the watching saw, averaged over the window.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
    pub cpu: f64,
    pub memory: f64,
    pub commit: f64,
    /// Pages read back from disk per second.
    pub page_reads: f64,
    /// Busiest disk's busy time, in percent.
    pub disk_busy: Option<f64>,
    pub throttle: Option<ThrottleState>,
    pub temp: Option<f64>,
    pub on_battery: Option<bool>,
    pub battery_saver: bool,
    pub plan: Option<&'static str>,
    pub uptime: u64,
    pub drive_free_pct: Option<f64>,
    pub top_cpu: Vec<Culprit>,
    pub top_disk: Vec<Culprit>,
    pub top_memory: Vec<Culprit>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cause {
    pub id: &'static str,
    pub level: Level,
    pub culprit: Option<Culprit>,
    pub values: serde_json::Value,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub measured: Measured,
    pub causes: Vec<Cause>,
}

/// Windows' own heavy background jobs, named so the answer can say what they are.
fn job(c: &Culprit) -> Option<&'static str> {
    match c.known? {
        "update" | "msiexec" => Some("update"),
        "defender" | "eset" => Some("antivirus"),
        "searchindexer" => Some("indexer"),
        "wmiprvse" => Some("wmi"),
        "system" => Some("system"),
        _ => None,
    }
}

/// Turns what was measured into causes, most serious first. Pure, so it can be tested.
pub fn diagnose(m: &Measured) -> Vec<Cause> {
    let mut out = Vec::new();
    let cause = |id, level, culprit: Option<&Culprit>, values| Cause { id, level, culprit: culprit.cloned(), values };

    if m.throttle == Some(ThrottleState::Thermal) {
        out.push(cause("thermal", Level::Bad, None, serde_json::json!({ "temp": m.temp.map(f64::round) })));
    }
    // Memory running out is the most common cause of a sluggish computer. Pages read back from
    // disk only mean that when memory is also full: reading files through memory (downloads,
    // games loading) counts as page reads too.
    let paging = m.page_reads >= 500.0 && (m.memory >= 80.0 || m.commit >= 85.0);
    if m.memory >= 90.0 || m.commit >= 90.0 || paging {
        let id = if paging { "paging" } else { "memory-full" };
        out.push(cause(id, Level::Bad, m.top_memory.first(), serde_json::json!({ "memory": m.memory.round(), "commit": m.commit.round(), "pages": m.page_reads.round() })));
    } else if m.memory >= 80.0 {
        out.push(cause("memory-tight", Level::Warn, m.top_memory.first(), serde_json::json!({ "memory": m.memory.round() })));
    }
    if m.cpu >= 60.0 {
        let top = m.top_cpu.first();
        let id = match top.and_then(job) {
            Some("update") => "busy-update",
            Some("antivirus") => "busy-antivirus",
            Some("indexer") => "busy-indexer",
            _ => "cpu-busy",
        };
        out.push(cause(id, if m.cpu >= 85.0 { Level::Bad } else { Level::Warn }, top, serde_json::json!({ "cpu": m.cpu.round(), "share": top.map(|c| c.cpu.round()) })));
    }
    if let Some(busy) = m.disk_busy.filter(|b| *b >= 60.0) {
        let top = m.top_disk.first();
        let id = match top.and_then(job) {
            Some("update") => "disk-update",
            Some("antivirus") => "disk-antivirus",
            Some("indexer") => "disk-indexer",
            _ => "disk-busy",
        };
        out.push(cause(id, if busy >= 90.0 { Level::Bad } else { Level::Warn }, top, serde_json::json!({ "busy": busy.round() })));
    }
    if m.battery_saver || m.plan == Some("saver") {
        out.push(cause("power-saver", Level::Warn, None, serde_json::Value::Null));
    } else if m.on_battery == Some(true) {
        out.push(cause("on-battery", Level::Ok, None, serde_json::Value::Null));
    }
    if let Some(free) = m.drive_free_pct.filter(|f| *f < 10.0) {
        out.push(cause("drive-full", Level::Warn, None, serde_json::json!({ "free": free.round() })));
    }
    if m.uptime < 300 {
        out.push(cause("just-started", Level::Ok, None, serde_json::json!({ "seconds": m.uptime })));
    } else if m.uptime > 7 * 86_400 {
        out.push(cause("long-uptime", Level::Ok, None, serde_json::json!({ "days": m.uptime / 86_400 })));
    }
    let serious = out.iter().any(|c| matches!(c.level, Level::Bad | Level::Warn));
    if !serious {
        out.insert(0, cause("all-clear", Level::Ok, None, serde_json::json!({ "cpu": m.cpu.round(), "memory": m.memory.round(), "disk": m.disk_busy.map(f64::round) })));
    }
    out.sort_by_key(|c| match c.level {
        Level::Bad => 0,
        Level::Warn => 1,
        _ => 2,
    });
    out
}

/// Watches for a few seconds, then diagnoses. `progress` gets the seconds done so far.
pub fn run(sensors: &Sensors, progress: &dyn Fn(u64)) -> Diagnosis {
    let disks = open_disks();
    let first: Vec<Option<DiskPerformance>> = disks.iter().map(|h| disk_stats(*h)).collect();
    let pages_before = page_reads();
    let started = Instant::now();
    let mut cpu = CpuSampler::new();
    let mut loads = Vec::new();
    let mut mem = Vec::new();
    let mut commit = Vec::new();
    // Per program: (sum of cpu, sum of disk, last memory, samples, the process to show).
    let mut programs: HashMap<String, (f64, f64, u64, u32, processes::Sample, u32)> = HashMap::new();

    for second in 1..=SECONDS {
        std::thread::sleep(Duration::from_secs(1).saturating_sub(started.elapsed().saturating_sub(Duration::from_secs(second - 1))));
        loads.push(cpu.sample().total as f64);
        if let Some((m, c)) = memory() {
            mem.push(m as f64);
            commit.push(c);
        }
        let mut seen: HashMap<String, (f64, f64, u64, u32, processes::Sample)> = HashMap::new();
        for s in processes::samples() {
            let id = s.exe.as_ref().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| s.name.to_lowercase());
            let e = seen.entry(id).or_insert((0.0, 0.0, 0, 0, s.clone()));
            e.0 += s.cpu as f64;
            e.1 += s.disk as f64;
            e.2 += s.memory;
            e.3 += 1;
            if s.cpu as f64 > e.4.cpu as f64 {
                e.4 = s.clone();
            }
        }
        for (id, (c, d, m, count, sample)) in seen {
            let e = programs.entry(id).or_insert((0.0, 0.0, 0, 0, sample.clone(), 0));
            e.0 += c;
            e.1 += d;
            e.2 = m;
            e.3 = count;
            e.5 += 1;
            if sample.cpu > e.4.cpu {
                e.4 = sample;
            }
        }
        progress(second);
    }
    let elapsed = started.elapsed().as_secs_f64().max(1.0);
    let avg = |v: &[f64]| if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 };

    let disk_busy = disks
        .iter()
        .zip(&first)
        .filter_map(|(h, before)| {
            let (before, after) = ((*before)?, disk_stats(*h)?);
            let span = (after.query_time - before.query_time) as f64;
            (span > 0.0).then(|| ((1.0 - (after.idle_time - before.idle_time) as f64 / span) * 100.0).clamp(0.0, 100.0))
        })
        .reduce(f64::max);
    for h in disks {
        // SAFETY: each handle was opened above and is closed once.
        unsafe {
            let _ = CloseHandle(h);
        }
    }
    let page_reads = match (pages_before, page_reads()) {
        (Some(a), Some(b)) => b.wrapping_sub(a) as f64 / elapsed,
        _ => 0.0,
    };

    let culprits: Vec<Culprit> = programs
        .into_values()
        .filter(|(.., s, _)| s.pid != std::process::id())
        .map(|(c, d, m, count, s, seconds)| Culprit {
            known: processes::known_id(&s.name),
            description: s.exe.as_deref().and_then(|e| crate::startup::fileinfo::inspect(e, false).description),
            exe: s.exe.as_ref().map(|e| e.to_string_lossy().into_owned()),
            name: s.name.clone(),
            count,
            cpu: c / seconds.max(1) as f64,
            disk: d / seconds.max(1) as f64,
            memory: m,
            pid: s.pid,
            start: s.start,
        })
        .collect();
    let top = |key: fn(&Culprit) -> f64| {
        let mut v = culprits.clone();
        v.sort_by(|a, b| key(b).total_cmp(&key(a)));
        v.truncate(3);
        v
    };
    let frame = sensors.latest();
    let throttle = frame.as_ref().and_then(|f| f.throttle.clone());
    let (on_battery, battery_saver, plan) = power();
    let measured = Measured {
        cpu: avg(&loads),
        memory: avg(&mem),
        commit: avg(&commit),
        page_reads,
        disk_busy,
        throttle: throttle.as_ref().map(|t| t.state),
        temp: throttle.as_ref().and_then(|t| t.temp),
        on_battery,
        battery_saver,
        plan,
        uptime: sysinfo::System::uptime().unwrap_or(0),
        drive_free_pct: system_drive_free().map(|(free, total)| free as f64 / total.max(1) as f64 * 100.0),
        top_cpu: top(|c| c.cpu),
        top_disk: top(|c| c.disk),
        top_memory: top(|c| c.memory as f64),
    };
    let causes = diagnose(&measured);
    Diagnosis { measured, causes }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quiet() -> Measured {
        Measured { cpu: 8.0, memory: 55.0, commit: 40.0, page_reads: 3.0, disk_busy: Some(4.0), uptime: 3600, drive_free_pct: Some(40.0), plan: Some("balanced"), on_battery: Some(false), ..Default::default() }
    }

    fn program(name: &str, known: Option<&'static str>, cpu: f64, disk: f64) -> Culprit {
        Culprit { name: name.into(), description: None, exe: None, known, count: 1, cpu, disk, memory: 1 << 30, pid: 1, start: 1 }
    }

    #[test]
    fn a_quiet_machine_is_all_clear() {
        let causes = diagnose(&quiet());
        assert_eq!(causes[0].id, "all-clear");
    }

    #[test]
    fn busy_parts_are_named_with_their_cause() {
        let mut m = quiet();
        m.cpu = 92.0;
        m.top_cpu = vec![program("TiWorker.exe", Some("update"), 70.0, 0.0)];
        m.disk_busy = Some(97.0);
        m.top_disk = vec![program("SearchIndexer.exe", Some("searchindexer"), 2.0, 9e6)];
        let ids: Vec<&str> = diagnose(&m).iter().map(|c| c.id).collect();
        assert_eq!(ids, ["busy-update", "disk-indexer"]);
    }

    #[test]
    fn memory_pressure_heat_and_power_settings() {
        let mut m = quiet();
        m.memory = 93.0;
        m.page_reads = 900.0;
        m.throttle = Some(ThrottleState::Thermal);
        m.battery_saver = true;
        m.drive_free_pct = Some(5.0);
        m.uptime = 10 * 86_400;
        let causes = diagnose(&m);
        let ids: Vec<&str> = causes.iter().map(|c| c.id).collect();
        assert_eq!(ids, ["thermal", "paging", "power-saver", "drive-full", "long-uptime"]);
        assert!(!ids.contains(&"all-clear"));
    }

    #[test]
    fn reading_files_through_memory_is_not_a_memory_shortage() {
        let mut m = quiet();
        m.page_reads = 6000.0;
        assert_eq!(diagnose(&m)[0].id, "all-clear", "heavy page reads with memory at 55% are file reads");
        m.memory = 85.0;
        assert_eq!(diagnose(&m)[0].id, "paging");
    }

    #[test]
    fn a_fresh_start_explains_itself_without_alarm() {
        let mut m = quiet();
        m.uptime = 90;
        let ids: Vec<&str> = diagnose(&m).iter().map(|c| c.id).collect();
        assert_eq!(ids, ["all-clear", "just-started"]);
    }

    #[test]
    fn this_machine_can_be_read() {
        assert!(memory().is_some());
        assert!(page_reads().is_some());
        let disks = open_disks();
        assert!(!disks.is_empty(), "no physical disk could be opened");
        assert!(disks.iter().any(|h| disk_stats(*h).is_some()));
        for h in disks {
            unsafe {
                let _ = CloseHandle(h);
            }
        }
    }
}

//! The stability test: idle, then every core under full load, then cooling down — about three
//! minutes. Along the way it checks that the processor computes correctly, how its clock and
//! temperature behave, whether the fans answer, and how well the system cools afterwards.
//!
//! "Computes correctly" is literal: each worker repeats a fixed calculation whose answer is
//! known in advance. Any different answer is a hardware error — the kind an unstable
//! overclock, a failing CPU or bad memory produces long before the machine crashes.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::fans::{self, Level, Sample};
use super::health::Check;
use super::sidecar::Sensors;
use super::throttle::State;
use crate::cpu::CpuSampler;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Plan {
    pub idle: u64,
    pub load: u64,
    pub cool: u64,
}

impl Plan {
    pub const STANDARD: Plan = Plan { idle: 20, load: 120, cool: 40 };

    pub fn total(&self) -> u64 {
        self.idle + self.load + self.cool
    }

    pub fn phase(&self, second: u64) -> &'static str {
        if second < self.idle {
            "idle"
        } else if second < self.idle + self.load {
            "load"
        } else {
            "cool"
        }
    }
}

/// One fixed piece of work: a 256 KB buffer churned with integer and floating-point maths.
/// Same seed, same answer — on healthy hardware, every time.
pub fn work(seed: u64) -> u64 {
    let mut buffer = vec![0u64; 32 * 1024];
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    for _ in 0..6 {
        for cell in buffer.iter_mut() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let f = ((x >> 11) as f64 * 1e-9).sqrt().sin() * 1e6;
            *cell = cell.wrapping_add(x ^ f.to_bits()).rotate_left((x & 31) as u32);
        }
    }
    buffer.iter().fold(0u64, |acc, v| acc.rotate_left(5) ^ v)
}

const SEEDS: u64 = 16;

struct Workers {
    stop: Arc<AtomicBool>,
    rounds: Arc<AtomicU64>,
    errors: Arc<AtomicU64>,
    handles: Vec<std::thread::JoinHandle<()>>,
}

impl Workers {
    fn start(threads: usize, expected: Arc<Vec<u64>>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let rounds = Arc::new(AtomicU64::new(0));
        let errors = Arc::new(AtomicU64::new(0));
        let handles = (0..threads)
            .map(|worker| {
                let (stop, rounds, errors, expected) = (stop.clone(), rounds.clone(), errors.clone(), expected.clone());
                std::thread::spawn(move || {
                    let mut seed = worker as u64 % SEEDS;
                    while !stop.load(Ordering::Relaxed) {
                        if work(seed) != expected[seed as usize] {
                            errors.fetch_add(1, Ordering::Relaxed);
                        }
                        rounds.fetch_add(1, Ordering::Relaxed);
                        seed = (seed + 1) % SEEDS;
                    }
                })
            })
            .collect();
        Self { stop, rounds, errors, handles }
    }

    fn finish(self) {
        self.stop.store(true, Ordering::Relaxed);
        for handle in self.handles {
            let _ = handle.join();
        }
    }
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub t: u64,
    pub phase: &'static str,
    pub load: f64,
    pub mhz: f64,
    pub cpu_temp: Option<f64>,
    pub gpu_temp: Option<f64>,
    pub errors: u64,
    pub fans: Vec<(String, f64)>,
    pub throttle: Option<State>,
    /// The tested graphics card, when there is one: load %, core clock MHz, video memory used
    /// MB and power W, as its driver reports them.
    pub gpu_load: Option<f64>,
    pub gpu_clock: Option<f64>,
    pub gpu_mem: Option<f64>,
    pub gpu_power: Option<f64>,
    /// Errors found so far by the memory and graphics tests.
    pub ram_errors: u64,
    pub gpu_errors: u64,
}

/// What to test and for how long.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub cpu: bool,
    pub ram: bool,
    /// The graphics adapter to test, by its DXGI index.
    pub gpu: Option<u32>,
    /// 3, 10 or 30.
    pub minutes: u32,
}

impl Default for Options {
    fn default() -> Self {
        Self { cpu: true, ram: false, gpu: None, minutes: 3 }
    }
}

impl Options {
    pub fn plan(&self) -> Plan {
        match self.minutes {
            m if m >= 30 => Plan { load: 1740, ..Plan::STANDARD },
            m if m >= 10 => Plan { load: 540, ..Plan::STANDARD },
            _ => Plan::STANDARD,
        }
    }

    /// Only the standard three-minute processor run is comparable from one time to the next.
    pub fn is_standard(&self) -> bool {
        self.cpu && !self.ram && self.gpu.is_none() && self.minutes <= 3
    }
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RamResult {
    pub bytes: u64,
    pub passes: u64,
    pub errors: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GpuResult {
    pub name: String,
    pub vram_bytes: u64,
    pub rounds: u64,
    pub compute_errors: u64,
    pub vram_errors: u64,
    pub lost: bool,
    pub problem: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub completed: bool,
    pub elevated: bool,
    pub threads: usize,
    pub rounds: u64,
    pub points: Vec<Point>,
    pub checks: Vec<Check>,
    /// How the temperature was measured: "sensor", "acpi", or `None` when it could not be.
    pub temp_source: Option<&'static str>,
    pub cooling: Option<super::cooling::Profile>,
    /// Every kept cooling profile, oldest first, this run included.
    pub history: Vec<super::cooling::Profile>,
    pub options: Options,
    pub plan: Plan,
    pub ram: Option<RamResult>,
    pub gpu: Option<GpuResult>,
}

/// A reading of the tested graphics card, found by the adapter's name.
fn gpu_reading(frame: &super::sidecar::Frame, name: &str, kind: &str, sensors: &[&str]) -> Option<f64> {
    let lower = name.to_lowercase();
    let hw = frame.hardware.iter().find(|h| h.kind.starts_with("Gpu") && {
        let n = h.name.to_lowercase();
        !lower.is_empty() && (n.contains(&lower) || lower.contains(&n))
    })?;
    sensors.iter().find_map(|wanted| hw.sensors.iter().find(|s| s.kind == kind && s.name.contains(wanted)).map(|s| s.value))
}

/// Runs the test, calling `progress` once a second. Stops early if `cancel` is set.
pub fn run(options: Options, sensors: &Sensors, cancel: &AtomicBool, progress: &dyn Fn(&Point, &Plan)) -> Report {
    let plan = options.plan();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    // The answers, worked out before any load or heat can disturb them.
    let expected: Arc<Vec<u64>> = Arc::new((0..SEEDS).map(work).collect());
    let mut cpu = CpuSampler::new();
    let elevated = crate::system::is_elevated();

    let started = Instant::now();
    let mut workers: Option<Workers> = None;
    let mut points = Vec::new();
    let (mut rounds, mut errors) = (0u64, 0u64);
    let mut completed = true;
    let mut temp_source = None;

    // Memory and graphics run beside the processor workers, with their own stop switch.
    let side_stop = Arc::new(AtomicBool::new(false));
    let ram_stats = Arc::new(super::ram::RamStats::default());
    let gpu_stats = Arc::new(super::gpu::GpuStats::default());
    let mut side: Vec<std::thread::JoinHandle<()>> = Vec::new();
    let mut side_started = false;
    let gpu_name = options.gpu.and_then(|i| super::gpu::adapters().into_iter().find(|a| a.index == i)).map(|a| a.name).unwrap_or_default();

    let stop_side = |side: &mut Vec<std::thread::JoinHandle<()>>| {
        side_stop.store(true, Ordering::Relaxed);
        for handle in side.drain(..) {
            let _ = handle.join();
        }
    };

    for second in 0..plan.total() {
        if cancel.load(Ordering::Relaxed) {
            completed = false;
            break;
        }
        let phase = plan.phase(second);
        if phase == "load" && !side_started {
            side_started = true;
            if options.cpu {
                workers = Some(Workers::start(threads, expected.clone()));
            }
            if options.ram {
                let available = sysinfo::System::new_with_specifics(sysinfo::RefreshKind::nothing().with_memory(sysinfo::MemoryRefreshKind::everything()))
                    .map(|s| s.available_memory())
                    .unwrap_or(0);
                let ram_threads = if options.cpu { (threads / 4).max(2) } else { threads.min(8) };
                side.extend(super::ram::start(super::ram::target(available), ram_threads, side_stop.clone(), ram_stats.clone()));
            }
            if let Some(index) = options.gpu {
                side.push(super::gpu::start(index, side_stop.clone(), gpu_stats.clone()));
            }
        }
        if phase == "cool" {
            if let Some(w) = workers.take() {
                rounds = w.rounds.load(Ordering::Relaxed);
                errors = w.errors.load(Ordering::Relaxed);
                w.finish();
            }
            stop_side(&mut side);
        }
        // Sleep to the next whole second of the test.
        let next = Duration::from_secs(second + 1);
        if let Some(wait) = next.checked_sub(started.elapsed()) {
            std::thread::sleep(wait);
        }

        if let Some(w) = &workers {
            errors = w.errors.load(Ordering::Relaxed);
            rounds = w.rounds.load(Ordering::Relaxed);
        }
        let frame = sensors.latest();
        if let Some(f) = &frame {
            temp_source = temp_source.or(if f.sensor_cpu_temp().is_some() { Some("sensor") } else if f.zone_temp().is_some() { Some("acpi") } else { None });
        }
        let throttle = frame.as_ref().and_then(|f| f.throttle.as_ref()).map(|t| t.state);
        let mhz = frame.as_ref().and_then(|f| f.cpu_clock()).unwrap_or(0.0);
        let gpu = |kind: &str, names: &[&str]| frame.as_ref().and_then(|f| gpu_reading(f, &gpu_name, kind, names));
        let point = Point {
            t: second + 1,
            phase,
            load: cpu.sample().total as f64,
            mhz,
            cpu_temp: frame.as_ref().and_then(|f| f.cpu_temp()),
            gpu_temp: gpu("Temperature", &["GPU Core"]).or_else(|| frame.as_ref().and_then(|f| f.gpu_temp())),
            errors,
            fans: frame.as_ref().map(|f| f.fans().into_iter().map(|(_, name, rpm)| (name, rpm)).collect()).unwrap_or_default(),
            throttle,
            gpu_load: options.gpu.and(gpu("Load", &["GPU Core", "D3D 3D", "D3D Compute"])),
            gpu_clock: options.gpu.and(gpu("Clock", &["GPU Core"])),
            gpu_mem: options.gpu.and(gpu("SmallData", &["GPU Memory Used", "D3D Dedicated Memory Used"])),
            gpu_power: options.gpu.and(gpu("Power", &["GPU Package", "GPU Power"])),
            ram_errors: ram_stats.errors.load(Ordering::Relaxed),
            gpu_errors: gpu_stats.compute_errors.load(Ordering::Relaxed) + gpu_stats.vram_errors.load(Ordering::Relaxed),
        };
        progress(&point, &plan);
        points.push(point);
    }
    if let Some(w) = workers.take() {
        rounds = w.rounds.load(Ordering::Relaxed);
        errors = w.errors.load(Ordering::Relaxed);
        w.finish();
    }
    stop_side(&mut side);

    let ram = options.ram.then(|| RamResult {
        bytes: ram_stats.bytes.load(Ordering::Relaxed),
        passes: ram_stats.passes.load(Ordering::Relaxed),
        errors: ram_stats.errors.load(Ordering::Relaxed),
    });
    let gpu = options.gpu.map(|_| GpuResult {
        name: gpu_stats.name.lock().unwrap().clone(),
        vram_bytes: gpu_stats.tested_bytes.load(Ordering::Relaxed),
        rounds: gpu_stats.rounds.load(Ordering::Relaxed),
        compute_errors: gpu_stats.compute_errors.load(Ordering::Relaxed),
        vram_errors: gpu_stats.vram_errors.load(Ordering::Relaxed),
        lost: gpu_stats.lost.load(Ordering::Relaxed),
        problem: gpu_stats.problem.lock().unwrap().clone(),
    });

    let mut checks = if options.cpu { judge(&plan, &points, rounds, errors, threads, elevated, completed) } else { Vec::new() };
    checks.extend(judge_parts(&plan, &points, ram.as_ref(), gpu.as_ref(), completed));
    let cooling = if completed && options.is_standard() { temp_source.and_then(|s| super::cooling::profile(&plan, &points, s, super::cooling::now())) } else { None };
    Report { completed, elevated, threads, rounds, points, checks, temp_source, cooling, history: Vec::new(), options, plan, ram, gpu }
}

/// Verdicts on memory and the graphics card.
pub fn judge_parts(plan: &Plan, points: &[Point], ram: Option<&RamResult>, gpu: Option<&GpuResult>, completed: bool) -> Vec<Check> {
    let mut checks = Vec::new();
    let gb = |b: u64| (b as f64 / 1_073_741_824.0 * 10.0).round() / 10.0;
    if let Some(r) = ram {
        let (level, reason) = if r.errors > 0 {
            (Level::Bad, "ram-errors")
        } else if r.bytes == 0 {
            (Level::Unknown, "ram-no-memory")
        } else if r.passes == 0 || !completed {
            (Level::Unknown, "ram-incomplete")
        } else {
            (Level::Ok, "ram-clean")
        };
        checks.push(Check::new("ram-test", None, level, vec![reason], serde_json::json!({ "gb": gb(r.bytes), "passes": r.passes, "errors": r.errors })));
    }
    if let Some(g) = gpu {
        let subject = (!g.name.is_empty()).then(|| g.name.clone());
        let values = serde_json::json!({ "rounds": g.rounds, "gb": gb(g.vram_bytes), "computeErrors": g.compute_errors, "vramErrors": g.vram_errors, "problem": g.problem });
        let (level, reasons) = if let Some(_) = &g.problem {
            (Level::Unknown, vec!["gpu-unavailable"])
        } else if g.lost {
            (Level::Bad, vec!["gpu-lost"])
        } else if g.compute_errors > 0 || g.vram_errors > 0 {
            let mut r = Vec::new();
            if g.compute_errors > 0 {
                r.push("gpu-compute-errors");
            }
            if g.vram_errors > 0 {
                r.push("gpu-vram-errors");
            }
            (Level::Bad, r)
        } else if g.rounds == 0 || !completed {
            (Level::Unknown, vec!["gpu-incomplete"])
        } else {
            (Level::Ok, vec!["gpu-clean"])
        };
        checks.push(Check::new("gpu-test", subject.clone(), level, reasons, values));

        let loaded: Vec<&Point> = points.iter().filter(|p| p.phase == "load").collect();
        if let Some(load) = avg(loaded.iter().skip(10).filter_map(|p| p.gpu_load)) {
            let level = if load >= 85.0 { Level::Ok } else { Level::Warn };
            checks.push(Check::new("gpu-load", subject.clone(), level, vec![if level == Level::Ok { "gpu-load-reached" } else { "gpu-load-low" }], serde_json::json!({ "load": load })));
        }
        let peak = loaded.iter().filter_map(|p| p.gpu_temp).reduce(f64::max);
        if let Some(peak) = peak {
            let (level, reason) = if peak >= 90.0 { (Level::Bad, "gpu-temp-critical") } else if peak >= 85.0 { (Level::Warn, "gpu-temp-high") } else { (Level::Ok, "gpu-temp-fine") };
            checks.push(Check::new("gpu-temp", subject.clone(), level, vec![reason], serde_json::json!({ "peak": peak })));
        }
        let early = avg(loaded.iter().skip(5).take(15).filter_map(|p| p.gpu_clock));
        let late = avg(loaded.iter().rev().take(30).filter_map(|p| p.gpu_clock));
        if let (Some(early), Some(late)) = (early, late) {
            let drop = ((early - late) / early.max(1.0) * 100.0).max(0.0);
            let hot = peak.is_some_and(|t| t >= 83.0);
            let (level, reason) = if drop > 20.0 && hot { (Level::Warn, "gpu-throttle") } else { (Level::Ok, "gpu-clock-steady") };
            checks.push(Check::new("gpu-clock", subject, level, vec![reason], serde_json::json!({ "early": early, "late": late, "drop": drop })));
        }
    }
    let _ = plan;
    checks
}

fn avg(values: impl Iterator<Item = f64>) -> Option<f64> {
    let (sum, n) = values.fold((0.0, 0usize), |(s, n), v| (s + v, n + 1));
    (n > 0).then(|| sum / n as f64)
}

/// Turns the recorded points into verdicts.
pub fn judge(plan: &Plan, points: &[Point], rounds: u64, errors: u64, threads: usize, elevated: bool, completed: bool) -> Vec<Check> {
    let mut checks = Vec::new();
    let loaded: Vec<&Point> = points.iter().filter(|p| p.phase == "load").collect();

    // 1. Correct results.
    let compute_level = if errors > 0 { Level::Bad } else if completed && rounds > 0 { Level::Ok } else { Level::Unknown };
    checks.push(Check::new(
        "cpu-compute",
        None,
        compute_level,
        vec![if errors > 0 { "compute-errors" } else if compute_level == Level::Ok { "compute-clean" } else { "compute-incomplete" }],
        serde_json::json!({ "rounds": rounds, "errors": errors, "threads": threads }),
    ));

    // 2. Did the processor actually get to full load?
    let load = avg(loaded.iter().skip(5).map(|p| p.load));
    if let Some(load) = load {
        let level = if load >= 85.0 { Level::Ok } else { Level::Warn };
        checks.push(Check::new("cpu-load", None, level, vec![if level == Level::Ok { "load-reached" } else { "load-not-reached" }], serde_json::json!({ "load": load })));
    }

    // 3. Clock: the first seconds of boost against the sustained pace at the end.
    let early = avg(loaded.iter().take(15).map(|p| p.mhz).filter(|v| *v > 0.0));
    let late = avg(loaded.iter().rev().take(60).map(|p| p.mhz).filter(|v| *v > 0.0));
    let peak_temp = points.iter().filter_map(|p| p.cpu_temp).fold(None, |m: Option<f64>, t| Some(m.map_or(t, |m| m.max(t))));
    if let (Some(early), Some(late)) = (early, late) {
        let drop = ((early - late) / early * 100.0).max(0.0);
        let hot = peak_temp.is_some_and(|t| t >= 95.0);
        let (level, reason) = if drop > 25.0 && hot {
            (Level::Warn, "thermal-throttle")
        } else if drop > 50.0 {
            (Level::Warn, "clock-collapse")
        } else if drop > 15.0 {
            (Level::Ok, "clock-settles")
        } else {
            (Level::Ok, "clock-steady")
        };
        checks.push(Check::new("cpu-clock", None, level, vec![reason], serde_json::json!({ "early": early, "late": late, "drop": drop })));
    } else {
        let reason = if elevated { "no-clock-sensor" } else { "clock-needs-admin" };
        checks.push(Check::new("cpu-clock", None, Level::Unknown, vec![reason], serde_json::Value::Null));
    }

    // 4. Temperature under load, and how fast it falls afterwards.
    match peak_temp {
        Some(peak) => {
            // Thin laptops run hot by design; what matters is whether the heat costs speed.
            let held = matches!((early, late), (Some(e), Some(l)) if e > 0.0 && l / e >= 0.9);
            let (level, reason) = if peak >= 98.0 {
                (Level::Bad, "temp-critical")
            } else if peak >= 90.0 && held {
                (Level::Ok, "temp-high-held")
            } else if peak >= 90.0 {
                (Level::Warn, "temp-high")
            } else {
                (Level::Ok, "temp-fine")
            };
            checks.push(Check::new("cpu-temp", None, level, vec![reason], serde_json::json!({ "peak": peak })));
            let end = points.iter().rev().take(5).filter_map(|p| p.cpu_temp).fold(f64::MAX, f64::min);
            if completed && end < f64::MAX {
                let fell = peak - end;
                let level = if fell < 5.0 && peak >= 70.0 { Level::Warn } else { Level::Ok };
                checks.push(Check::new(
                    "cooling",
                    None,
                    level,
                    vec![if level == Level::Ok { "cools-down" } else { "slow-cooldown" }],
                    serde_json::json!({ "peak": peak, "end": end, "seconds": plan.cool }),
                ));
            }
        }
        None => checks.push(Check::new("cpu-temp", None, Level::Unknown, vec![if elevated { "no-temp-sensor" } else { "temp-needs-admin" }], serde_json::Value::Null)),
    }

    // 5. Fans, each judged on the whole test: steadiness and whether they answered the heat.
    let mut series: BTreeMap<String, Vec<Sample>> = BTreeMap::new();
    for p in points {
        for (name, rpm) in &p.fans {
            series.entry(name.clone()).or_default().push(Sample { t: p.t as f64, rpm: *rpm, temp: p.cpu_temp.or(p.gpu_temp), load: Some(p.load) });
        }
    }
    if series.is_empty() {
        checks.push(Check::new("fans", None, Level::Unknown, vec![if elevated { "no-fan-sensors" } else { "fans-need-admin" }], serde_json::Value::Null));
    }
    for (name, samples) in series {
        let verdict = fans::analyze(&samples);
        let idle_rpm = avg(samples.iter().filter(|s| s.t <= plan.idle as f64).map(|s| s.rpm));
        let load_rpm = samples.iter().filter(|s| s.t > (plan.idle + plan.load / 2) as f64 && s.t <= (plan.idle + plan.load) as f64).map(|s| s.rpm).fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v))));
        let mut reasons = verdict.reasons.clone();
        let mut level = verdict.level;
        // Under two minutes of full load a working fan speeds up noticeably.
        if let (Some(idle), Some(peak)) = (idle_rpm, load_rpm) {
            if peak < idle * 1.1 && peak_temp.is_some_and(|t| t >= 75.0) {
                reasons.push("no-ramp");
                level = level.max(Level::Warn);
            }
        }
        checks.push(Check::new("fan", Some(name), level, reasons, serde_json::to_value(&verdict).unwrap_or_default()));
    }
    checks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workload_is_deterministic_and_seed_dependent() {
        assert_eq!(work(3), work(3));
        assert_ne!(work(3), work(4));
    }

    #[test]
    fn workers_find_no_errors_on_healthy_hardware() {
        let expected = Arc::new((0..SEEDS).map(work).collect::<Vec<_>>());
        let workers = Workers::start(2, expected);
        std::thread::sleep(Duration::from_millis(300));
        let (rounds, errors) = (workers.rounds.load(Ordering::Relaxed), workers.errors.load(Ordering::Relaxed));
        workers.finish();
        assert!(rounds > 0);
        assert_eq!(errors, 0);
    }

    #[test]
    fn workers_count_a_wrong_answer_as_an_error() {
        let mut wrong: Vec<u64> = (0..SEEDS).map(work).collect();
        wrong[0] ^= 1;
        let workers = Workers::start(1, Arc::new(wrong));
        while workers.rounds.load(Ordering::Relaxed) < SEEDS {
            std::thread::sleep(Duration::from_millis(10));
        }
        let errors = workers.errors.load(Ordering::Relaxed);
        workers.finish();
        assert!(errors >= 1);
    }

    fn point(t: u64, plan: &Plan, mhz: f64, temp: Option<f64>, fan: Option<f64>) -> Point {
        Point {
            t,
            phase: plan.phase(t - 1),
            load: if plan.phase(t - 1) == "load" { 99.0 } else { 3.0 },
            mhz,
            cpu_temp: temp,
            gpu_temp: None,
            errors: 0,
            fans: fan.map(|rpm| vec![("CPU Fan".to_string(), rpm)]).unwrap_or_default(),
            throttle: None,
            ..Default::default()
        }
    }

    #[test]
    fn a_healthy_run_is_all_green() {
        let plan = Plan { idle: 20, load: 120, cool: 40 };
        let points: Vec<Point> = (1..=plan.total())
            .map(|t| {
                let heating = t > plan.idle && t <= plan.idle + plan.load;
                let temp = if heating { 50.0 + ((t - plan.idle) as f64).min(30.0) } else if t <= plan.idle { 48.0 } else { 55.0 };
                let rpm = 1500.0 + (temp - 48.0) * 80.0;
                point(t, &plan, if heating { 3600.0 } else { 1400.0 }, Some(temp), Some(rpm))
            })
            .collect();
        let checks = judge(&plan, &points, 5000, 0, 16, true, true);
        let by_id = |id: &str| checks.iter().find(|c| c.id == id).unwrap();
        assert_eq!(by_id("cpu-compute").level, Level::Ok);
        assert_eq!(by_id("cpu-load").level, Level::Ok);
        assert_eq!((by_id("cpu-clock").level, by_id("cpu-clock").reasons[0]), (Level::Ok, "clock-steady"));
        assert_eq!(by_id("cpu-temp").level, Level::Ok);
        assert_eq!(by_id("cooling").level, Level::Ok);
        assert_eq!(by_id("fan").level, Level::Ok, "{:?}", by_id("fan"));
    }

    #[test]
    fn errors_heat_and_a_lazy_fan_are_reported() {
        let plan = Plan { idle: 20, load: 120, cool: 40 };
        let points: Vec<Point> = (1..=plan.total())
            .map(|t| {
                let heating = t > plan.idle && t <= plan.idle + plan.load;
                let temp = if heating { 60.0 + ((t - plan.idle) as f64 * 0.5).min(39.0) } else if t <= plan.idle { 55.0 } else { 97.0 };
                // Boosts, then the clock collapses once it is hot.
                let mhz = if !heating { 1400.0 } else if t < plan.idle + 30 { 4200.0 } else { 2400.0 };
                point(t, &plan, mhz, Some(temp), Some(1600.0))
            })
            .collect();
        let checks = judge(&plan, &points, 5000, 2, 16, true, true);
        let by_id = |id: &str| checks.iter().find(|c| c.id == id).unwrap();
        assert_eq!((by_id("cpu-compute").level, by_id("cpu-compute").reasons[0]), (Level::Bad, "compute-errors"));
        assert_eq!(by_id("cpu-clock").reasons[0], "thermal-throttle");
        assert_eq!(by_id("cpu-temp").level, Level::Bad);
        assert_eq!(by_id("cooling").level, Level::Warn);
        assert!(by_id("fan").reasons.contains(&"no-ramp"));
    }

    #[test]
    fn parts_are_judged() {
        let plan = Plan { idle: 2, load: 40, cool: 2 };
        let points: Vec<Point> = (1..=plan.total())
            .map(|t| Point { t, phase: plan.phase(t - 1), gpu_load: Some(98.0), gpu_temp: Some(80.0), gpu_clock: Some(2400.0), ..Default::default() })
            .collect();
        let ram = RamResult { bytes: 8 << 30, passes: 3, errors: 0 };
        let gpu = GpuResult { name: "RTX".into(), vram_bytes: 4 << 30, rounds: 100, ..Default::default() };
        let checks = judge_parts(&plan, &points, Some(&ram), Some(&gpu), true);
        let by_id = |id: &str| checks.iter().find(|c| c.id == id).unwrap();
        assert_eq!((by_id("ram-test").level, by_id("ram-test").reasons[0]), (Level::Ok, "ram-clean"));
        assert_eq!((by_id("gpu-test").level, by_id("gpu-test").reasons[0]), (Level::Ok, "gpu-clean"));
        assert_eq!(by_id("gpu-load").level, Level::Ok);
        assert_eq!(by_id("gpu-temp").reasons[0], "gpu-temp-fine");

        let bad_ram = RamResult { errors: 2, ..ram };
        let lost = GpuResult { lost: true, ..gpu.clone() };
        let checks = judge_parts(&plan, &points, Some(&bad_ram), Some(&lost), true);
        assert_eq!(checks[0].reasons[0], "ram-errors");
        assert_eq!((checks[1].level, checks[1].reasons[0]), (Level::Bad, "gpu-lost"));
        let missing = GpuResult { problem: Some("device".into()), ..gpu };
        assert_eq!(judge_parts(&plan, &[], None, Some(&missing), true)[0].reasons[0], "gpu-unavailable");
    }

    #[test]
    fn durations_and_comparable_runs() {
        assert_eq!(Options::default().plan(), Plan::STANDARD);
        assert_eq!(Options { minutes: 10, ..Default::default() }.plan().total(), 600);
        assert_eq!(Options { minutes: 30, ..Default::default() }.plan().total(), 1800);
        assert!(Options::default().is_standard());
        assert!(!Options { ram: true, ..Default::default() }.is_standard());
    }

    #[test]
    fn missing_sensors_are_unknown_not_failures() {
        let plan = Plan { idle: 2, load: 10, cool: 2 };
        let points: Vec<Point> = (1..=plan.total()).map(|t| point(t, &plan, 0.0, None, None)).collect();
        let checks = judge(&plan, &points, 100, 0, 4, false, true);
        let by_id = |id: &str| checks.iter().find(|c| c.id == id).unwrap();
        assert_eq!((by_id("cpu-temp").level, by_id("cpu-temp").reasons[0]), (Level::Unknown, "temp-needs-admin"));
        assert_eq!((by_id("fans").level, by_id("fans").reasons[0]), (Level::Unknown, "fans-need-admin"));
        assert_eq!((by_id("cpu-clock").level, by_id("cpu-clock").reasons[0]), (Level::Unknown, "clock-needs-admin"), "no readings, no made-up verdict");
    }
}

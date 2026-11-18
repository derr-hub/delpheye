//! CPU load sampled straight from the kernel's per-processor time counters.
//!
//! sysinfo measures CPU load through PDH performance counters. On machines where
//! the performance-counter registry is unhealthy that call blocks indefinitely,
//! so load is computed here from `NtQuerySystemInformation` instead: it is cheap,
//! needs no elevation and cannot stall.

use std::ffi::c_void;

const SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION: u32 = 8;
const MAX_CPUS: usize = 256;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ProcessorTimes {
    idle: i64,
    /// Kernel time *includes* idle time.
    kernel: i64,
    user: i64,
    dpc: i64,
    interrupt: i64,
    interrupt_count: u32,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQuerySystemInformation(
        class: u32,
        info: *mut c_void,
        length: u32,
        return_length: *mut u32,
    ) -> i32;
}

fn read_times() -> Vec<ProcessorTimes> {
    let mut buf = vec![ProcessorTimes::default(); MAX_CPUS];
    let mut written: u32 = 0;
    // SAFETY: `buf` is a valid, writable buffer of the size passed in, and the
    // kernel reports how many bytes it filled through `written`.
    let status = unsafe {
        NtQuerySystemInformation(
            SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION,
            buf.as_mut_ptr().cast(),
            (buf.len() * size_of::<ProcessorTimes>()) as u32,
            &mut written,
        )
    };
    if status < 0 {
        return Vec::new();
    }
    buf.truncate(written as usize / size_of::<ProcessorTimes>());
    buf
}

pub struct CpuLoad {
    pub total: f32,
    pub per_core: Vec<f32>,
}

/// Keeps the previous reading so each `sample` returns load over the interval since the last one.
pub struct CpuSampler {
    prev: Vec<ProcessorTimes>,
}

impl CpuSampler {
    pub fn new() -> Self {
        Self { prev: read_times() }
    }

    pub fn sample(&mut self) -> CpuLoad {
        let now = read_times();
        let mut per_core = Vec::with_capacity(now.len());
        let (mut busy_sum, mut all_sum) = (0i64, 0i64);

        for (i, cur) in now.iter().enumerate() {
            let Some(old) = self.prev.get(i) else {
                per_core.push(0.0);
                continue;
            };
            let idle = cur.idle - old.idle;
            let all = (cur.kernel - old.kernel) + (cur.user - old.user);
            let busy = (all - idle).max(0);
            busy_sum += busy;
            all_sum += all;
            per_core.push(if all > 0 { (busy as f32 / all as f32) * 100.0 } else { 0.0 });
        }

        self.prev = now;
        CpuLoad {
            total: if all_sum > 0 { (busy_sum as f32 / all_sum as f32) * 100.0 } else { 0.0 },
            per_core,
        }
    }
}

//! What happens under the programs: how hard the Windows kernel and the hardware worked each minute.
//! Every number is a difference between two plain counter reads; nothing is traced or hooked.

use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde::Serialize;
use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION};
use windows::Win32::System::Threading::GetSystemTimes;

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQuerySystemInformation(class: u32, info: *mut core::ffi::c_void, length: u32, returned: *mut u32) -> i32;
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deep {
    pub t: i64,
    /// Share of the processor spent inside Windows itself, and in programs, percent.
    pub kernel: Option<f64>,
    pub user: Option<f64>,
    /// Per second: switches between threads, calls into Windows, pages fetched from disk, pages handed out.
    pub switches: Option<i64>,
    pub calls: Option<i64>,
    pub hard: Option<i64>,
    pub soft: Option<i64>,
    /// Bytes per second through every file and device.
    pub read: Option<i64>,
    pub write: Option<i64>,
    pub processes: Option<i64>,
    pub threads: Option<i64>,
    pub handles: Option<i64>,
    /// Memory promised to programs, percent of what can be promised.
    pub commit: Option<f64>,
    /// On mains power; a desktop always is.
    pub mains: Option<bool>,
    /// Charge, percent; none on a desktop.
    pub battery: Option<i64>,
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Counters {
    idle: u64,
    kernel: u64,
    user: u64,
    read: u64,
    write: u64,
    faults: u32,
    hard: u32,
    switches: u32,
    calls: u32,
    at: i64,
}

fn counters(at: i64) -> Option<Counters> {
    let mut b = [0u8; 1024];
    let mut returned = 0u32;
    // SAFETY: the buffer is larger than SYSTEM_PERFORMANCE_INFORMATION and its size is passed.
    let status = unsafe { NtQuerySystemInformation(2, b.as_mut_ptr().cast(), b.len() as u32, &mut returned) };
    if status < 0 || returned < 312 {
        return None;
    }
    let u32_at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let u64_at = |o: usize| u64::from_le_bytes(b[o..o + 8].try_into().unwrap());
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    // SAFETY: three out-parameters.
    unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).ok()? };
    let ft = |f: FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
    Some(Counters { idle: ft(idle), kernel: ft(kernel), user: ft(user), read: u64_at(8), write: u64_at(16), faults: u32_at(60), hard: u32_at(80), switches: u32_at(296), calls: u32_at(308), at })
}

/// The time between two reads. The kernel's 32-bit counters wrap around; differences still hold.
pub fn between(a: &Counters, b: &Counters) -> Deep {
    let s = (b.at - a.at).max(1) as f64;
    let rate = |x: u32, y: u32| Some((y.wrapping_sub(x) as f64 / s) as i64);
    let kernel = b.kernel.saturating_sub(a.kernel);
    let user = b.user.saturating_sub(a.user);
    let all = (kernel + user).max(1) as f64;
    // Windows counts idle time as kernel time.
    let own = kernel.saturating_sub(b.idle.saturating_sub(a.idle)) as f64;
    let tenth = |v: f64| (v * 10.0).round() / 10.0;
    Deep {
        t: b.at / 60 * 60,
        kernel: Some(tenth(own * 100.0 / all)),
        user: Some(tenth(user as f64 * 100.0 / all)),
        switches: rate(a.switches, b.switches),
        calls: rate(a.calls, b.calls),
        hard: rate(a.hard, b.hard),
        soft: rate(a.faults, b.faults),
        read: Some((b.read.saturating_sub(a.read) as f64 / s) as i64),
        write: Some((b.write.saturating_sub(a.write) as f64 / s) as i64),
        ..Default::default()
    }
}

static LAST: Mutex<Option<Counters>> = Mutex::new(None);

pub fn sample(at: i64) -> Option<Deep> {
    let now = counters(at)?;
    let before = LAST.lock().unwrap().replace(now)?;
    // After sleep the minute is not a minute.
    if now.at - before.at > 180 {
        return None;
    }
    let mut d = between(&before, &now);
    let mut p = PERFORMANCE_INFORMATION { cb: size_of::<PERFORMANCE_INFORMATION>() as u32, ..Default::default() };
    // SAFETY: sized struct.
    if unsafe { GetPerformanceInfo(&mut p, size_of::<PERFORMANCE_INFORMATION>() as u32) }.is_ok() {
        d.processes = Some(p.ProcessCount as i64);
        d.threads = Some(p.ThreadCount as i64);
        d.handles = Some(p.HandleCount as i64);
        d.commit = Some((p.CommitTotal as f64 * 1000.0 / p.CommitLimit.max(1) as f64).round() / 10.0);
    }
    let mut s = SYSTEM_POWER_STATUS::default();
    // SAFETY: plain query into a struct.
    if unsafe { GetSystemPowerStatus(&mut s) }.is_ok() {
        d.mains = match s.ACLineStatus {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        };
        // 128: no battery at all (a desktop); 255: unknown.
        d.battery = (s.BatteryFlag & 128 == 0 && s.BatteryLifePercent <= 100).then_some(s.BatteryLifePercent as i64);
    }
    Some(d)
}

pub fn save(db: &Connection, rows: &[Deep]) -> rusqlite::Result<()> {
    let tx = db.unchecked_transaction()?;
    for d in rows {
        tx.execute(
            "INSERT OR REPLACE INTO deep (t, kernel, user, switches, calls, hard, soft, read, write, processes, threads, handles, commit_pct, mains, battery)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![d.t, d.kernel, d.user, d.switches, d.calls, d.hard, d.soft, d.read, d.write, d.processes, d.threads, d.handles, d.commit, d.mains, d.battery],
        )?;
    }
    tx.commit()
}

pub fn load(db: &Connection, from: i64, to: i64) -> rusqlite::Result<Vec<Deep>> {
    db.prepare("SELECT t, kernel, user, switches, calls, hard, soft, read, write, processes, threads, handles, commit_pct, mains, battery FROM deep WHERE t >= ?1 AND t < ?2 ORDER BY t")?
        .query_map([from, to], |r| {
            Ok(Deep {
                t: r.get(0)?,
                kernel: r.get(1)?,
                user: r.get(2)?,
                switches: r.get(3)?,
                calls: r.get(4)?,
                hard: r.get(5)?,
                soft: r.get(6)?,
                read: r.get(7)?,
                write: r.get(8)?,
                processes: r.get(9)?,
                threads: r.get(10)?,
                handles: r.get(11)?,
                commit: r.get(12)?,
                mains: r.get(13)?,
                battery: r.get(14)?,
            })
        })?
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_come_from_differences_even_across_a_wrap() {
        let a = Counters { calls: u32::MAX - 99, switches: 100, ..Default::default() };
        let b = Counters { idle: 500, kernel: 700, user: 300, calls: 500, switches: 700, read: 6000, at: 60, ..Default::default() };
        let d = between(&a, &b);
        assert_eq!((d.calls, d.switches, d.read, d.kernel, d.user), (Some(10), Some(10), Some(100), Some(20.0), Some(30.0)));
    }

    /// The offsets are right if a busy second on this machine gives plausible numbers.
    #[test]
    fn this_machine_gives_plausible_counters() {
        let a = counters(0).unwrap();
        let t = std::time::Instant::now();
        let mut n = 0u64;
        while t.elapsed().as_millis() < 1000 {
            // Each of these is at least one call into Windows.
            let _ = std::fs::metadata("C:\\Windows");
            n += 1;
        }
        let d = between(&a, &counters(1).unwrap());
        eprintln!("{n} file checks: {d:?}");
        assert!(d.calls.unwrap() as u64 >= n, "calls {:?} for {n}", d.calls);
        assert!(d.switches.unwrap() > 50 && d.switches.unwrap() < 10_000_000);
        assert!(d.kernel.unwrap() >= 0.0 && d.kernel.unwrap() + d.user.unwrap() <= 100.1);
    }
}

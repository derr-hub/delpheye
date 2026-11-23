//! The computer's health over months: once a minute, while DelphEye runs (window or tray), the
//! load, memory, temperatures and free disk space go into one row per day. Crashes come from
//! Windows' own event log, so they reach back before DelphEye was installed.

use std::sync::Mutex;
use std::time::Duration;

use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::journal::Journal;

pub const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS health_daily (
        day            TEXT PRIMARY KEY,
        minutes        INTEGER NOT NULL DEFAULT 0,
        cpu_sum        REAL    NOT NULL DEFAULT 0,
        cpu_max        REAL    NOT NULL DEFAULT 0,
        ram_sum        REAL    NOT NULL DEFAULT 0,
        ram_max        REAL    NOT NULL DEFAULT 0,
        cpu_temp_sum   REAL    NOT NULL DEFAULT 0,
        cpu_temp_n     INTEGER NOT NULL DEFAULT 0,
        cpu_temp_max   REAL,
        gpu_temp_sum   REAL    NOT NULL DEFAULT 0,
        gpu_temp_n     INTEGER NOT NULL DEFAULT 0,
        gpu_temp_max   REAL,
        hot_minutes    INTEGER NOT NULL DEFAULT 0,
        disk_free      INTEGER,
        disk_total     INTEGER
    );
";

/// The newest CPU load and memory use, kept by the metrics sampler.
static LATEST: Mutex<Option<(f32, f64)>> = Mutex::new(None);

pub fn note_metrics(cpu: f32, mem_used: u64, mem_total: u64) {
    *LATEST.lock().unwrap() = Some((cpu, mem_used as f64 * 100.0 / mem_total.max(1) as f64));
}

/// Today's date on this computer, "2026-11-23".
pub fn local_day() -> String {
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    format!("{:04}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay)
}

fn sample(app: &AppHandle) {
    let Some((cpu, ram)) = *LATEST.lock().unwrap() else { return };
    let frame = app.state::<crate::monitor::MonitorState>().sensors.latest();
    let cpu_temp = frame.as_ref().and_then(|f| f.cpu_temp()).filter(|t| *t > 0.0 && *t < 130.0);
    let gpu_temp = frame.as_ref().and_then(|f| f.gpu_temp()).filter(|t| *t > 0.0 && *t < 130.0);
    let hot = frame.as_ref().and_then(|f| f.throttle.as_ref()).is_some_and(|t| matches!(t.state, crate::monitor::throttle::State::Thermal)) || cpu_temp.is_some_and(|t| t >= 92.0);
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    let disk = crate::monitor::slowdown::drive_free(&drive);
    let battery = frame.as_ref().and_then(|f| f.sensors().find(|(h, s)| h.kind == "Battery" && s.kind == "Level" && s.name.contains("Charge")).map(|(_, s)| s.value));
    crate::monitor::verdict::record(crate::monitor::verdict::Beat {
        t: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0),
        cpu_temp,
        gpu_temp,
        cpu,
        on_battery: frame.as_ref().is_some_and(|f| f.on_battery()),
        battery,
    });
    let day = local_day();
    let _ = app.state::<Journal>().with(|db| {
        db.execute_batch(SCHEMA)?;
        db.execute(
            "INSERT INTO health_daily (day) VALUES (?1) ON CONFLICT(day) DO NOTHING",
            params![day],
        )?;
        db.execute(
            "UPDATE health_daily SET
                minutes = minutes + 1,
                cpu_sum = cpu_sum + ?2, cpu_max = MAX(cpu_max, ?2),
                ram_sum = ram_sum + ?3, ram_max = MAX(ram_max, ?3),
                cpu_temp_sum = cpu_temp_sum + COALESCE(?4, 0), cpu_temp_n = cpu_temp_n + (?4 IS NOT NULL),
                cpu_temp_max = CASE WHEN ?4 IS NULL THEN cpu_temp_max ELSE MAX(COALESCE(cpu_temp_max, 0), ?4) END,
                gpu_temp_sum = gpu_temp_sum + COALESCE(?5, 0), gpu_temp_n = gpu_temp_n + (?5 IS NOT NULL),
                gpu_temp_max = CASE WHEN ?5 IS NULL THEN gpu_temp_max ELSE MAX(COALESCE(gpu_temp_max, 0), ?5) END,
                hot_minutes = hot_minutes + ?6,
                disk_free = COALESCE(?7, disk_free), disk_total = COALESCE(?8, disk_total)
             WHERE day = ?1",
            params![day, cpu as f64, ram, cpu_temp, gpu_temp, hot as i64, disk.map(|d| d.0 as i64), disk.map(|d| d.1 as i64)],
        )
    });
}

/// Starts the once-a-minute sampler for the life of the app.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        // Let the sensors start first.
        std::thread::sleep(Duration::from_secs(30));
        loop {
            sample(&app);
            std::thread::sleep(Duration::from_secs(60));
        }
    });
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    pub day: String,
    /// Minutes DelphEye watched the computer that day.
    pub minutes: i64,
    pub cpu_avg: Option<f64>,
    pub cpu_max: Option<f64>,
    pub ram_avg: Option<f64>,
    pub ram_max: Option<f64>,
    pub cpu_temp_avg: Option<f64>,
    pub cpu_temp_max: Option<f64>,
    pub gpu_temp_avg: Option<f64>,
    pub gpu_temp_max: Option<f64>,
    pub hot_minutes: i64,
    pub disk_free: Option<i64>,
    pub disk_total: Option<i64>,
    /// From Windows' event log.
    pub bluescreens: u32,
    pub shutdowns: u32,
    pub hardware: u32,
    pub gpu_resets: u32,
}

fn round(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

pub fn days(j: &Journal, since: &str) -> Vec<Day> {
    j.with(|db| {
        db.execute_batch(SCHEMA)?;
        let mut s = db.prepare(
            "SELECT day, minutes, cpu_sum, cpu_max, ram_sum, ram_max, cpu_temp_sum, cpu_temp_n, cpu_temp_max,
                    gpu_temp_sum, gpu_temp_n, gpu_temp_max, hot_minutes, disk_free, disk_total
             FROM health_daily WHERE day >= ?1 ORDER BY day",
        )?;
        let v = s
            .query_map(params![since], |r| {
                let minutes: i64 = r.get(1)?;
                let n = minutes.max(1) as f64;
                let (ct, cn): (f64, i64) = (r.get(6)?, r.get(7)?);
                let (gt, gn): (f64, i64) = (r.get(9)?, r.get(10)?);
                Ok(Day {
                    day: r.get(0)?,
                    minutes,
                    cpu_avg: (minutes > 0).then(|| round(r.get::<_, f64>(2).unwrap_or(0.0) / n)),
                    cpu_max: (minutes > 0).then(|| round(r.get::<_, f64>(3).unwrap_or(0.0))),
                    ram_avg: (minutes > 0).then(|| round(r.get::<_, f64>(4).unwrap_or(0.0) / n)),
                    ram_max: (minutes > 0).then(|| round(r.get::<_, f64>(5).unwrap_or(0.0))),
                    cpu_temp_avg: (cn > 0).then(|| round(ct / cn as f64)),
                    cpu_temp_max: r.get::<_, Option<f64>>(8)?.map(round),
                    gpu_temp_avg: (gn > 0).then(|| round(gt / gn as f64)),
                    gpu_temp_max: r.get::<_, Option<f64>>(11)?.map(round),
                    hot_minutes: r.get(12)?,
                    disk_free: r.get(13)?,
                    disk_total: r.get(14)?,
                    ..Default::default()
                })
            })?
            .filter_map(|x| x.ok())
            .collect();
        Ok(v)
    })
    .unwrap_or_default()
}

/// Adds the event log's crashes to the days (creating days DelphEye did not see).
pub fn merge_crashes(mut days: Vec<Day>, incidents: &[(String, &str, Option<&str>)], since: &str) -> Vec<Day> {
    for (at, kind, cause) in incidents {
        let day = at.get(..10).unwrap_or_default().to_string();
        if day.as_str() < since {
            continue;
        }
        let i = match days.iter().position(|d| d.day == day) {
            Some(i) => i,
            None => {
                days.push(Day { day: day.clone(), ..Default::default() });
                days.len() - 1
            }
        };
        let d = &mut days[i];
        match *kind {
            "bluescreen" => d.bluescreens += 1,
            "shutdown" if *cause == Some("bluescreen") => d.bluescreens += 1,
            "shutdown" => d.shutdowns += 1,
            "whea" => d.hardware += 1,
            "gpu" => d.gpu_resets += 1,
            _ => {}
        }
    }
    days.sort_by(|a, b| a.day.cmp(&b.day));
    days
}

/// The days from `since` (inclusive), oldest first.
#[tauri::command]
pub async fn health_history(app: AppHandle, since: String) -> Result<Vec<Day>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let days = days(&app.state::<Journal>(), &since);
        let log = crate::system::Dirs::real().and_then(|d| crate::monitor::health::read_crash_log(&d.windows));
        let incidents: Vec<(String, &str, Option<&str>)> = log.map(|l| l.incidents.iter().map(|i| (i.at.clone(), i.kind, i.cause)).collect()).unwrap_or_default();
        merge_crashes(days, &incidents, &since)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_average_their_minutes() {
        let j = Journal::in_memory();
        j.with(|db| {
            db.execute_batch(SCHEMA)?;
            db.execute("INSERT INTO health_daily (day, minutes, cpu_sum, cpu_max, ram_sum, ram_max, cpu_temp_sum, cpu_temp_n, cpu_temp_max) VALUES ('2026-11-20', 4, 200, 90, 280, 75, 300, 4, 81)", [])
        })
        .unwrap();
        let d = &days(&j, "2026-11-01")[0];
        assert_eq!((d.cpu_avg, d.ram_avg, d.cpu_temp_avg, d.cpu_temp_max, d.gpu_temp_avg), (Some(50.0), Some(70.0), Some(75.0), Some(81.0), None));
        assert!(days(&j, "2026-11-21").is_empty());
    }

    #[test]
    fn crashes_land_on_their_day() {
        let seen = vec![Day { day: "2026-11-20".into(), minutes: 10, ..Default::default() }];
        let incidents = vec![
            ("2026-11-20T10:00:00Z".to_string(), "shutdown", Some("power-loss")),
            ("2026-11-02T08:00:00Z".to_string(), "bluescreen", None),
            ("2026-10-01T08:00:00Z".to_string(), "gpu", None),
        ];
        let d = merge_crashes(seen, &incidents, "2026-11-01");
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].day.as_str(), d[0].bluescreens), ("2026-11-02", 1));
        assert_eq!((d[1].shutdowns, d[1].minutes), (1, 10));
    }
}

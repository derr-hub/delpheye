//! The cooling profile: what a stability test says about how well the machine gets rid of heat,
//! kept run after run so a slow decline (dust, dried-out thermal paste, a tired fan) shows up
//! long before it turns into crashes.
//!
//! Fan speed is not needed for any of it: cooling that works shows in how high the temperature
//! climbs, how fast it gets there, how long the processor keeps its pace, and how fast it
//! recovers afterwards.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::fans::Level;
use super::health::Check;
use super::stress::{Plan, Point};
use super::throttle::State;
use crate::journal::Journal;

/// Earlier runs kept for comparison.
const KEEP: usize = 50;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Unix seconds.
    pub at: i64,
    /// Average temperature before the load.
    pub idle: f64,
    /// Average temperature over the last 30 seconds of load: where the cooling holds it.
    pub plateau: f64,
    pub peak: f64,
    /// Degrees gained in the first 30 seconds of load, per minute.
    pub heat_rate: f64,
    /// The clock at the end of the load as a share of the clock at its start, in percent.
    pub sustained: Option<f64>,
    /// Seconds of the load spent slowed down by heat.
    pub thermal_seconds: u64,
    /// Degrees lost in the cool-down phase.
    pub cooled: f64,
    /// "sensor" or "acpi"; runs are only compared with runs measured the same way.
    pub source: String,
}

fn avg(values: impl Iterator<Item = f64>) -> Option<f64> {
    let (sum, n) = values.fold((0.0, 0usize), |(s, n), v| (s + v, n + 1));
    (n > 0).then(|| sum / n as f64)
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// Works the profile out from a completed run. `None` without temperatures.
pub fn profile(plan: &Plan, points: &[Point], source: &str, at: i64) -> Option<Profile> {
    let idle = avg(points.iter().filter(|p| p.phase == "idle").filter_map(|p| p.cpu_temp))?;
    let load: Vec<&Point> = points.iter().filter(|p| p.phase == "load").collect();
    let plateau = avg(load.iter().rev().take(30).filter_map(|p| p.cpu_temp))?;
    let peak = points.iter().filter_map(|p| p.cpu_temp).reduce(f64::max)?;
    let at_30 = load.iter().take(30).filter_map(|p| p.cpu_temp).last()?;
    let heat_rate = (at_30 - idle).max(0.0) * 2.0;
    let early = avg(load.iter().take(15).map(|p| p.mhz).filter(|m| *m > 0.0));
    let late = avg(load.iter().rev().take(30).map(|p| p.mhz).filter(|m| *m > 0.0));
    let sustained = match (early, late) {
        (Some(e), Some(l)) if e > 0.0 => Some(round1((l / e * 100.0).min(100.0))),
        _ => None,
    };
    let end = avg(points.iter().filter(|p| p.phase == "cool").rev().take(5).filter_map(|p| p.cpu_temp)).unwrap_or(peak);
    let _ = plan;
    Some(Profile {
        at,
        idle: round1(idle),
        plateau: round1(plateau),
        peak: round1(peak),
        heat_rate: round1(heat_rate),
        sustained,
        thermal_seconds: load.iter().filter(|p| p.throttle == Some(State::Thermal)).count() as u64,
        cooled: round1((peak - end).max(0.0)),
        source: source.to_string(),
    })
}

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

pub fn save(journal: &Journal, profile: &Profile) -> rusqlite::Result<()> {
    journal.with(|db| {
        db.execute("INSERT INTO cooling_runs (at, data) VALUES (?1, ?2)", params![profile.at, serde_json::to_string(profile).unwrap_or_default()])?;
        db.execute("DELETE FROM cooling_runs WHERE id NOT IN (SELECT id FROM cooling_runs ORDER BY at DESC LIMIT ?1)", params![KEEP as i64])?;
        Ok(())
    })
}

/// Every kept run, oldest first.
pub fn history(journal: &Journal) -> Vec<Profile> {
    journal
        .with(|db| {
            let mut stmt = db.prepare("SELECT data FROM cooling_runs ORDER BY at ASC")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.filter_map(|r| r.ok()).filter_map(|data| serde_json::from_str(&data).ok()).collect())
        })
        .unwrap_or_default()
}

/// Compares this run with the first one measured the same way (the machine at its best) and
/// with the one just before it.
pub fn trend(earlier: &[Profile], current: &Profile) -> Check {
    let same: Vec<&Profile> = earlier.iter().filter(|p| p.source == current.source && p.at < current.at).collect();
    let Some(first) = same.first() else {
        return Check::new("cooling-trend", None, Level::Ok, vec!["trend-baseline"], serde_json::Value::Null);
    };
    // Room temperature moves the plateau too, so the climb above idle is compared as well.
    let warmer = current.plateau - first.plateau;
    let climb = (current.plateau - current.idle) - (first.plateau - first.idle);
    let slower = match (first.sustained, current.sustained) {
        (Some(a), Some(b)) => a - b,
        _ => 0.0,
    };
    let more_heat_limit = current.thermal_seconds as f64 - first.thermal_seconds as f64;
    let worse = (warmer >= 5.0 && climb >= 4.0) || slower >= 8.0 || more_heat_limit >= 30.0;
    let better = warmer <= -4.0 && slower <= 0.0;
    let (level, reason) = if worse {
        (Level::Warn, "trend-worse")
    } else if better {
        (Level::Ok, "trend-better")
    } else {
        (Level::Ok, "trend-same")
    };
    let days = ((current.at - first.at) as f64 / 86_400.0).round();
    Check::new(
        "cooling-trend",
        None,
        level,
        vec![reason],
        serde_json::json!({
            "runs": same.len() + 1,
            "days": days,
            "warmer": round1(warmer),
            "slower": round1(slower),
            "since": first.at,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(plan: &Plan, idle: f64, plateau: f64, early_mhz: f64, late_mhz: f64, hot_tail: bool) -> Vec<Point> {
        (1..=plan.total())
            .map(|t| {
                let phase = plan.phase(t - 1);
                let into = t.saturating_sub(plan.idle) as f64;
                let temp = match phase {
                    "idle" => idle,
                    "load" => (idle + into * 1.5).min(plateau),
                    _ => plateau - (t - plan.idle - plan.load) as f64 * 0.5,
                };
                let mhz = if phase != "load" { 1200.0 } else if into <= 20.0 { early_mhz } else { late_mhz };
                let throttle = (phase == "load" && hot_tail && into > 60.0).then_some(State::Thermal);
                Point { t, phase, load: if phase == "load" { 99.0 } else { 3.0 }, mhz, cpu_temp: Some(temp), throttle, ..Default::default() }
            })
            .collect()
    }

    #[test]
    fn the_profile_reads_the_curve() {
        let plan = Plan::STANDARD;
        let p = profile(&plan, &run(&plan, 50.0, 90.0, 3000.0, 2700.0, true), "acpi", 100).unwrap();
        assert_eq!((p.idle, p.plateau, p.peak), (50.0, 90.0, 90.0));
        assert_eq!(p.heat_rate, 80.0, "40 degrees in the first 30 s is 80 per minute");
        assert_eq!(p.sustained, Some(90.0));
        assert_eq!(p.thermal_seconds, 60);
        assert_eq!(p.cooled, 19.0, "the last five seconds average 71 degrees");
    }

    #[test]
    fn no_temperatures_no_profile() {
        let plan = Plan { idle: 2, load: 40, cool: 5 };
        let mut points = run(&plan, 50.0, 80.0, 3000.0, 3000.0, false);
        points.iter_mut().for_each(|p| p.cpu_temp = None);
        assert!(profile(&plan, &points, "acpi", 1).is_none());
    }

    #[test]
    fn the_trend_compares_with_the_first_run_of_the_same_kind() {
        let plan = Plan::STANDARD;
        let first = profile(&plan, &run(&plan, 45.0, 85.0, 3000.0, 2900.0, false), "acpi", 0).unwrap();
        let other_kind = Profile { source: "sensor".into(), plateau: 60.0, ..first.clone() };
        assert_eq!(trend(&[], &first).reasons, vec!["trend-baseline"]);

        let same = profile(&plan, &run(&plan, 46.0, 86.0, 3000.0, 2880.0, false), "acpi", 86_400 * 30).unwrap();
        assert_eq!(trend(&[first.clone(), other_kind.clone()], &same).reasons, vec!["trend-same"]);

        let dusty = profile(&plan, &run(&plan, 45.0, 94.0, 3000.0, 2500.0, true), "acpi", 86_400 * 200).unwrap();
        let check = trend(&[other_kind, first], &dusty);
        assert_eq!((check.level, check.reasons[0]), (Level::Warn, "trend-worse"));
        assert_eq!(check.values["days"], 200.0);
    }

    #[test]
    fn runs_are_saved_and_trimmed() {
        let journal = Journal::in_memory();
        let plan = Plan::STANDARD;
        let base = profile(&plan, &run(&plan, 45.0, 85.0, 3000.0, 2900.0, false), "acpi", 0).unwrap();
        for i in 0..(KEEP as i64 + 3) {
            save(&journal, &Profile { at: i, ..base.clone() }).unwrap();
        }
        let kept = history(&journal);
        assert_eq!((kept.len(), kept[0].at, kept.last().unwrap().at), (KEEP, 3, KEEP as i64 + 2));
    }
}

//! Fan stability: is a fan spinning evenly, and does it answer to heat?
//!
//! Works on a series of one-per-second samples. The checks, each tied to a real failure:
//!
//! * **wobble** — speed spread while nothing else changes (worn bearing, loose blade, bad PWM);
//! * **hunting** — the speed keeps swinging up and down at a steady temperature (fan curve or
//!   controller fighting itself), which is also the audible "whoosh-whoosh";
//! * **dropouts** — the fan stalls or nearly stops while the system is warm (sticking bearing,
//!   failing connector);
//! * **drift** — speed slowly sinks at a steady temperature (wear, dust build-up);
//! * **no response** — temperature climbs, the fan does not (stuck curve, broken sensor).
//!
//! A fan standing still while everything is cool is "fan-stop" mode, which is by design.

use serde::Serialize;

#[derive(Clone, Copy, Debug)]
pub struct Sample {
    /// Seconds since the series began.
    pub t: f64,
    pub rpm: f64,
    pub temp: Option<f64>,
    /// CPU load, 0–100.
    pub load: Option<f64>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Unknown,
    Ok,
    Warn,
    Bad,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub level: Level,
    /// 0–100, higher is healthier.
    pub score: u8,
    pub samples: usize,
    pub mean: f64,
    pub min: f64,
    pub max: f64,
    /// Typical spread at steady conditions, in % of the speed.
    pub wobble_pct: f64,
    /// Up-and-down swings per minute at steady conditions.
    pub swings_per_min: f64,
    pub dropouts: u32,
    /// Speed change per minute at steady conditions, in %.
    pub drift_pct_per_min: f64,
    /// How closely speed follows temperature (Pearson r), when temperature moved enough to tell.
    pub response: Option<f64>,
    pub reasons: Vec<&'static str>,
}

/// Fewer samples than this say nothing reliable.
pub const MIN_SAMPLES: usize = 30;
const WINDOW: usize = 10;
/// A fan this slow is effectively stopped.
const STOPPED_RPM: f64 = 150.0;
/// Below this the system is cool enough for a fan to stop on purpose.
const COOL: f64 = 55.0;

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() { 0.0 } else { values.iter().sum::<f64>() / values.len() as f64 }
}

fn std_dev(values: &[f64]) -> f64 {
    let m = mean(values);
    (values.iter().map(|v| (v - m).powi(2)).sum::<f64>() / values.len().max(1) as f64).sqrt()
}

fn pearson(xs: &[f64], ys: &[f64]) -> Option<f64> {
    let (mx, my) = (mean(xs), mean(ys));
    let cov: f64 = xs.iter().zip(ys).map(|(x, y)| (x - mx) * (y - my)).sum();
    let (sx, sy) = (std_dev(xs) * (xs.len() as f64).sqrt(), std_dev(ys) * (ys.len() as f64).sqrt());
    (sx > 0.0 && sy > 0.0).then(|| cov / (sx * sy))
}

/// Least-squares slope of `ys` over `xs`.
fn slope(xs: &[f64], ys: &[f64]) -> f64 {
    let (mx, my) = (mean(xs), mean(ys));
    let num: f64 = xs.iter().zip(ys).map(|(x, y)| (x - mx) * (y - my)).sum();
    let den: f64 = xs.iter().map(|x| (x - mx).powi(2)).sum();
    if den > 0.0 { num / den } else { 0.0 }
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    sorted.get(sorted.len() / 2).copied().unwrap_or(0.0)
}

/// Stretches where temperature and load hardly move: the only fair place to judge evenness.
fn steady_windows(samples: &[Sample]) -> Vec<&[Sample]> {
    samples
        .chunks_exact(WINDOW)
        .filter(|w| {
            let spread = |f: fn(&Sample) -> Option<f64>, limit: f64| {
                let values: Vec<f64> = w.iter().filter_map(f).collect();
                values.len() < w.len() / 2 || {
                    let (lo, hi) = values.iter().fold((f64::MAX, f64::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
                    hi - lo <= limit
                }
            };
            spread(|s| s.temp, 2.5) && spread(|s| s.load, 15.0)
        })
        .collect()
}

pub fn analyze(samples: &[Sample]) -> Verdict {
    let rpms: Vec<f64> = samples.iter().map(|s| s.rpm).collect();
    let (min, max) = rpms.iter().fold((f64::MAX, f64::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
    let mut verdict = Verdict {
        level: Level::Unknown,
        score: 0,
        samples: samples.len(),
        mean: mean(&rpms),
        min: if samples.is_empty() { 0.0 } else { min },
        max: if samples.is_empty() { 0.0 } else { max },
        wobble_pct: 0.0,
        swings_per_min: 0.0,
        dropouts: 0,
        drift_pct_per_min: 0.0,
        response: None,
        reasons: Vec::new(),
    };
    if samples.len() < MIN_SAMPLES {
        verdict.reasons.push("too-few-samples");
        return verdict;
    }

    let hottest = samples.iter().filter_map(|s| s.temp).fold(f64::MIN, f64::max);
    if verdict.max < STOPPED_RPM {
        // Standing still the whole time: fine when cool, alarming when hot.
        let (level, reason, score) = if hottest == f64::MIN || hottest < COOL { (Level::Ok, "fan-stop", 100) } else { (Level::Bad, "stopped-while-hot", 10) };
        verdict.level = level;
        verdict.score = score;
        verdict.reasons.push(reason);
        return verdict;
    }

    let mut penalty: f64 = 0.0;

    // Dropouts: a running fan suddenly (almost) stopping while the system is warm.
    let typical = median(&rpms);
    for pair in samples.windows(2) {
        let warm = pair[1].temp.is_none_or(|t| t >= COOL);
        if pair[0].rpm >= typical * 0.5 && pair[1].rpm < typical * 0.15 && warm {
            verdict.dropouts += 1;
        }
    }
    if verdict.dropouts > 0 {
        verdict.reasons.push("dropouts");
        penalty += if verdict.dropouts >= 3 { 45.0 } else { 25.0 };
    }

    let steady = steady_windows(samples);
    if steady.len() >= 2 {
        // Wobble: relative spread inside each steady stretch.
        let spreads: Vec<f64> = steady
            .iter()
            .filter_map(|w| {
                let values: Vec<f64> = w.iter().map(|s| s.rpm).collect();
                let m = mean(&values);
                (m >= STOPPED_RPM).then(|| std_dev(&values) / m * 100.0)
            })
            .collect();
        verdict.wobble_pct = mean(&spreads);
        if verdict.wobble_pct > 10.0 {
            verdict.reasons.push("wobble-strong");
            penalty += 35.0;
        } else if verdict.wobble_pct > 4.0 {
            verdict.reasons.push("wobble");
            penalty += 25.0;
        }

        // Hunting: direction changes bigger than 3% of the speed.
        let mut swings = 0usize;
        let mut minutes = 0.0;
        for w in &steady {
            let m = mean(&w.iter().map(|s| s.rpm).collect::<Vec<_>>()).max(1.0);
            let steps: Vec<f64> = w.windows(2).map(|p| p[1].rpm - p[0].rpm).filter(|d| d.abs() > m * 0.03).collect();
            swings += steps.windows(2).filter(|d| d[0].signum() != d[1].signum()).count();
            minutes += (w[w.len() - 1].t - w[0].t).max(1.0) / 60.0;
        }
        verdict.swings_per_min = swings as f64 / minutes.max(1e-9);
        if verdict.swings_per_min > 12.0 {
            verdict.reasons.push("hunting");
            penalty += 20.0;
        }

        // Drift: the trend across steady stretches at the *same* temperature (within 5 °C),
        // as % of the mean per minute. Comparing idle with full load would only measure the curve.
        let mut by_temp: std::collections::BTreeMap<i64, Vec<&Sample>> = std::collections::BTreeMap::new();
        for w in &steady {
            let temps: Vec<f64> = w.iter().filter_map(|s| s.temp).collect();
            let bucket = if temps.is_empty() { 0 } else { (mean(&temps) / 5.0).round() as i64 };
            by_temp.entry(bucket).or_default().extend(w.iter());
        }
        if let Some(group) = by_temp.values().filter(|g| g.len() >= 3 * WINDOW).max_by_key(|g| g.len()) {
            let (ts, rs): (Vec<f64>, Vec<f64>) = group.iter().map(|s| (s.t / 60.0, s.rpm)).unzip();
            verdict.drift_pct_per_min = slope(&ts, &rs) / mean(&rs).max(1.0) * 100.0;
        }
        if verdict.drift_pct_per_min < -3.0 {
            verdict.reasons.push("drift-down");
            penalty += 15.0;
        }
    } else {
        verdict.reasons.push("never-steady");
    }

    // Response to heat, judged only when temperature actually moved.
    let paired: Vec<(f64, f64)> = samples.iter().filter_map(|s| Some((s.temp?, s.rpm))).collect();
    if paired.len() >= MIN_SAMPLES {
        let (temps, rpm): (Vec<f64>, Vec<f64>) = paired.into_iter().unzip();
        let (lo, hi) = temps.iter().fold((f64::MAX, f64::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
        if hi - lo >= 8.0 {
            verdict.response = pearson(&temps, &rpm);
            let flat = verdict.max < verdict.min.max(1.0) * 1.15;
            if hi >= 85.0 && flat {
                verdict.reasons.push("no-response-hot");
                penalty += 55.0;
            } else if verdict.response.is_some_and(|r| r < 0.3) {
                verdict.reasons.push("weak-response");
                penalty += 15.0;
            }
        }
    }

    verdict.score = (100.0 - penalty).clamp(0.0, 100.0) as u8;
    verdict.level = match verdict.score {
        80.. => Level::Ok,
        50..=79 => Level::Warn,
        _ => Level::Bad,
    };
    if verdict.reasons.is_empty() {
        verdict.reasons.push("steady");
    }
    verdict
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny deterministic noise source, so tests never depend on luck.
    fn noise(i: usize) -> f64 {
        let x = (i as u64).wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407) >> 33;
        (x % 1000) as f64 / 1000.0 - 0.5
    }

    fn series(n: usize, f: impl Fn(usize) -> (f64, Option<f64>)) -> Vec<Sample> {
        (0..n).map(|i| {
            let (rpm, temp) = f(i);
            Sample { t: i as f64, rpm, temp, load: Some(20.0) }
        }).collect()
    }

    #[test]
    fn a_healthy_fan_is_steady_and_follows_heat() {
        // 2 minutes cool and steady, then heat rises and the fan follows.
        let samples = series(240, |i| {
            let temp = if i < 120 { 50.0 } else { 50.0 + (i - 120) as f64 * 0.3 };
            (1800.0 + (temp - 50.0) * 60.0 + noise(i) * 30.0, Some(temp))
        });
        let v = analyze(&samples);
        assert_eq!(v.level, Level::Ok, "{v:?}");
        assert!(v.wobble_pct < 2.0 && v.dropouts == 0);
        assert!(v.response.unwrap() > 0.9);
    }

    #[test]
    fn a_wobbling_fan_is_flagged() {
        let samples = series(180, |i| (2000.0 + noise(i) * 600.0, Some(60.0)));
        let v = analyze(&samples);
        assert!(v.reasons.contains(&"wobble-strong") || v.reasons.contains(&"wobble"), "{v:?}");
        assert!(v.level >= Level::Warn);
    }

    #[test]
    fn a_hunting_fan_is_flagged() {
        // Swinging ±300 rpm every other second at a steady temperature.
        let samples = series(180, |i| (2000.0 + if i % 2 == 0 { 300.0 } else { -300.0 }, Some(60.0)));
        let v = analyze(&samples);
        assert!(v.reasons.contains(&"hunting"), "{v:?}");
    }

    #[test]
    fn stalls_while_warm_are_dropouts() {
        let samples = series(120, |i| (if i == 40 || i == 80 || i == 100 { 0.0 } else { 2100.0 + noise(i) * 20.0 }, Some(70.0)));
        let v = analyze(&samples);
        assert_eq!(v.dropouts, 3);
        assert_eq!(v.level, Level::Bad, "{v:?}");
    }

    #[test]
    fn a_fan_stopped_while_cool_is_by_design_but_not_while_hot() {
        let cool = series(60, |_| (0.0, Some(42.0)));
        let v = analyze(&cool);
        assert_eq!((v.level, v.reasons[0]), (Level::Ok, "fan-stop"));

        let hot = series(60, |_| (0.0, Some(88.0)));
        assert_eq!(analyze(&hot).level, Level::Bad);
    }

    #[test]
    fn a_fan_that_ignores_heat_is_flagged() {
        let samples = series(180, |i| (1500.0 + noise(i) * 10.0, Some(60.0 + i as f64 * 0.17)));
        let v = analyze(&samples);
        assert!(v.reasons.contains(&"no-response-hot"), "{v:?}");
        assert_eq!(v.level, Level::Bad);
    }

    #[test]
    fn slow_sinking_at_steady_temperature_is_drift() {
        let samples = series(300, |i| (2400.0 - i as f64 * 1.6 + noise(i) * 10.0, Some(60.0)));
        let v = analyze(&samples);
        assert!(v.reasons.contains(&"drift-down"), "{v:?}");
        assert!(v.drift_pct_per_min < -3.0);
    }

    #[test]
    fn too_little_data_says_so() {
        let v = analyze(&series(10, |_| (2000.0, None)));
        assert_eq!((v.level, v.reasons[0]), (Level::Unknown, "too-few-samples"));
    }
}

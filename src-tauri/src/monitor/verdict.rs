//! Why the computer went down, as surely as the evidence allows. Windows' own records (the stop
//! code of a blue screen, a held power button, hardware errors, graphics driver resets) are put
//! next to DelphEye's minute-by-minute "pulse" from just before — temperatures, battery, power —
//! and each incident gets one cause, a confidence and the facts behind it.

use serde::{Deserialize, Serialize};

use super::health::{CrashLog, Incident};

/// One minute of the machine's state, as DelphEye saw it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Beat {
    /// Unix seconds.
    pub t: i64,
    pub cpu_temp: Option<f64>,
    pub gpu_temp: Option<f64>,
    pub cpu: f32,
    pub on_battery: bool,
    pub battery: Option<f64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    /// "bluescreen-driver", "bluescreen-hardware", "bluescreen-memory", "bluescreen-disk",
    /// "bluescreen-gpu", "bluescreen", "hardware", "overheat", "battery", "freeze", "sleep",
    /// "gpu-driver", "power-cut", "firmware-reset", "unknown".
    pub cause: &'static str,
    /// "certain", "likely", "possible".
    pub confidence: &'static str,
    /// What points there, as (fact, value) pairs for the interface to word.
    pub facts: Vec<(&'static str, String)>,
}

const HEARTBEAT: &str = "heartbeat.json";
const KEEP: usize = 240;

fn file() -> Option<std::path::PathBuf> {
    Some(std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("com.delpheye.app").join(HEARTBEAT))
}

pub fn load_beats() -> Vec<Beat> {
    file().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Adds a minute to the pulse, keeping the last four hours.
pub fn record(beat: Beat) {
    let Some(f) = file() else { return };
    let mut beats = load_beats();
    beats.push(beat);
    if beats.len() > KEEP {
        beats.drain(..beats.len() - KEEP);
    }
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(f, serde_json::to_string(&beats).unwrap_or_default());
}

/// What a blue screen's stop code usually points at.
pub fn stop_family(code: &str) -> &'static str {
    match code {
        "0x124" | "0x101" | "0x9C" | "0x117" => "bluescreen-hardware",
        "0x1A" | "0x50" | "0x4E" | "0xC2" | "0x19" | "0x139" => "bluescreen-memory",
        "0x7A" | "0x77" | "0xF4" | "0x154" | "0x24" | "0x7B" | "0xED" => "bluescreen-disk",
        "0x116" | "0x119" | "0x10E" | "0x113" => "bluescreen-gpu",
        "0x9F" | "0xD1" | "0xA" | "0x133" | "0x3B" | "0x7E" | "0x1E" | "0xC4" | "0xD5" | "0x1000007E" => "bluescreen-driver",
        _ => "bluescreen",
    }
}

fn secs(iso: &str) -> Option<i64> {
    super::health::iso_seconds(iso)
}

/// The cause of one incident. `others` are the log's other incidents, `beats` the pulse.
pub fn judge(i: &Incident, others: &[Incident], beats: &[Beat]) -> Verdict {
    let at = secs(&i.at);
    let mut facts: Vec<(&'static str, String)> = Vec::new();
    // Blue screens explain themselves by their stop code.
    if let Some(code) = i.code.as_deref().filter(|c| c.starts_with("0x")) {
        facts.push(("stop", code.to_string()));
        return Verdict { cause: stop_family(code), confidence: "certain", facts };
    }
    if i.kind == "bluescreen" {
        return Verdict { cause: "bluescreen", confidence: "likely", facts };
    }
    if i.cause == Some("hardware-reset") {
        return Verdict { cause: "firmware-reset", confidence: "certain", facts };
    }
    // The last minutes DelphEye saw before this boot: within four hours before it.
    let last = at.and_then(|t| beats.iter().filter(|b| b.t <= t && t - b.t < 4 * 3600).max_by_key(|b| b.t));
    let near = |kind: &str, window: i64| -> Option<&Incident> {
        let t = at?;
        others.iter().find(|o| o.kind == kind && secs(&o.at).is_some_and(|x| x <= t && t - x <= window) && (kind != "whea" || o.code.as_deref() == Some("fatal")))
    };
    if let Some(w) = near("whea", 4 * 3600) {
        facts.push(("whea", w.cause.unwrap_or("other").to_string()));
        return Verdict { cause: "hardware", confidence: "likely", facts };
    }
    if let Some(b) = last {
        facts.push(("lastSeen", b.t.to_string()));
        let hot = b.cpu_temp.into_iter().chain(b.gpu_temp).fold(0.0f64, f64::max);
        if hot >= 95.0 {
            facts.push(("temp", format!("{hot:.0}")));
            return Verdict { cause: "overheat", confidence: "likely", facts };
        }
        if b.on_battery && b.battery.is_some_and(|p| p <= 6.0) {
            facts.push(("battery", format!("{:.0}", b.battery.unwrap_or(0.0))));
            return Verdict { cause: "battery", confidence: "likely", facts };
        }
    }
    match i.cause {
        Some("power-button") => {
            if let Some(b) = last {
                if let Some(t) = b.cpu_temp.filter(|t| *t >= 90.0) {
                    facts.push(("temp", format!("{t:.0}")));
                }
            }
            return Verdict { cause: "freeze", confidence: "certain", facts };
        }
        Some("sleep") => return Verdict { cause: "sleep", confidence: "likely", facts },
        _ => {}
    }
    if let Some(g) = near("gpu", 30 * 60) {
        facts.push(("gpu", g.detail.clone().unwrap_or_default()));
        return Verdict { cause: "gpu-driver", confidence: "possible", facts };
    }
    if let Some(b) = last {
        if b.on_battery {
            facts.push(("battery", b.battery.map(|p| format!("{p:.0}")).unwrap_or_default()));
            return Verdict { cause: "battery", confidence: "possible", facts };
        }
        if i.cause == Some("power-loss") {
            return Verdict { cause: "power-cut", confidence: "possible", facts };
        }
    }
    Verdict { cause: if i.cause == Some("power-loss") { "power-cut" } else { "unknown" }, confidence: "possible", facts }
}

/// Gives every shutdown and blue screen in the log its verdict.
pub fn judge_all(log: &mut CrashLog, beats: &[Beat]) {
    let all = log.incidents.clone();
    for i in log.incidents.iter_mut().filter(|i| i.kind == "shutdown" || i.kind == "bluescreen") {
        i.verdict = Some(judge(i, &all, beats));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inc(kind: &'static str, at: &str, cause: Option<&'static str>, code: Option<&str>) -> Incident {
        Incident { at: at.into(), kind, cause, code: code.map(String::from), detail: None, verdict: None }
    }

    #[test]
    fn the_evidence_decides() {
        let t = super::super::health::iso_seconds("2026-11-20T10:00:00Z").unwrap();
        let hot = vec![Beat { t: t - 120, cpu_temp: Some(99.0), ..Default::default() }];
        let flat = vec![Beat { t: t - 120, on_battery: true, battery: Some(3.0), cpu_temp: Some(60.0), ..Default::default() }];
        let crash = inc("shutdown", "2026-11-20T10:00:00Z", Some("power-loss"), None);
        assert_eq!(judge(&crash, &[], &hot).cause, "overheat");
        assert_eq!(judge(&crash, &[], &flat).cause, "battery");
        assert_eq!(judge(&inc("shutdown", "2026-11-20T10:00:00Z", Some("power-loss"), Some("0x124")), &[], &[]).cause, "bluescreen-hardware");
        assert_eq!(judge(&inc("shutdown", "2026-11-20T10:00:00Z", Some("power-button"), None), &[], &[]).cause, "freeze");
        let whea = inc("whea", "2026-11-20T09:58:00Z", Some("cpu"), Some("fatal"));
        assert_eq!(judge(&crash, &[whea], &[]).cause, "hardware");
        assert_eq!(judge(&crash, &[], &[]).cause, "power-cut");
    }
}

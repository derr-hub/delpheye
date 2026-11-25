//! Readings that crossed a line worth remembering: overheating, throttling, full memory, a full disk.

use std::collections::HashMap;
use std::sync::Mutex;

use super::{Event, Reading};

/// (name, minutes in a row before it counts, quiet seconds afterwards)
const RULES: [(&str, u32, i64); 5] = [("cpu-hot", 2, 1800), ("gpu-hot", 2, 1800), ("throttled", 2, 1800), ("ram-full", 3, 1800), ("disk-full", 2, 3 * 86_400)];

#[derive(Default)]
pub struct Watch(HashMap<&'static str, (u32, i64)>);

/// The value that crossed the line, if it did.
fn crossed(name: &str, r: &Reading) -> Option<f64> {
    let over = |v: Option<f64>, line: f64| v.filter(|v| *v >= line);
    match name {
        "cpu-hot" => over(r.cpu_temp, 95.0),
        "gpu-hot" => over(r.gpu_temp, 87.0),
        "throttled" => (r.hot > 0).then(|| r.cpu_temp.unwrap_or(0.0)),
        "ram-full" => over(r.ram, 93.0),
        _ => r.free_mb.filter(|m| *m < 10_240).map(|m| m as f64),
    }
}

impl Watch {
    pub fn check(&mut self, r: &Reading, at: i64) -> Vec<Event> {
        let mut out = Vec::new();
        for (name, minutes, quiet) in RULES {
            let state = self.0.entry(name).or_insert((0, i64::MIN / 2));
            match crossed(name, r) {
                None => state.0 = 0,
                Some(v) => {
                    state.0 += 1;
                    if state.0 >= minutes && at - state.1 >= quiet {
                        let mut e = Event::seen("alert", "happened", name, None, Some(format!("{v:.0}")));
                        e.t = at;
                        e.uniq = format!("alert|{name}|{at}");
                        out.push(e);
                    }
                    // Still over the line: the quiet time starts when it ends.
                    if state.0 >= minutes {
                        state.1 = at;
                    }
                }
            }
        }
        // Throttling from heat says more than the temperature alone.
        if out.iter().any(|e| e.name == "throttled") {
            out.retain(|e| e.name != "cpu-hot");
        }
        out
    }
}

static WATCH: Mutex<Option<Watch>> = Mutex::new(None);

pub fn check(r: &Reading, at: i64) -> Vec<Event> {
    WATCH.lock().unwrap().get_or_insert_with(Watch::default).check(r, at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_episode_is_one_event() {
        let mut w = Watch::default();
        let hot = |t: f64| Reading { cpu_temp: Some(t), n: 1, ..Default::default() };
        let mut seen = 0;
        for i in 0..60 {
            seen += w.check(&hot(97.0), i * 60).len();
        }
        assert_eq!(seen, 1, "an hour of heat is one episode");
        for i in 60..70 {
            seen += w.check(&hot(70.0), i * 60).len();
        }
        seen += w.check(&hot(97.0), 71 * 60).len() + w.check(&hot(97.0), 72 * 60).len();
        assert_eq!(seen, 1, "soon after: still quiet");
        for i in [200, 201] {
            seen += w.check(&hot(97.0), i * 60).len();
        }
        assert_eq!(seen, 2);
        assert!(w.check(&hot(97.0), 400 * 60).len() <= 1);
    }

    #[test]
    fn a_single_spike_is_not_news() {
        let mut w = Watch::default();
        let r = |t: f64| Reading { cpu_temp: Some(t), ..Default::default() };
        assert!(w.check(&r(99.0), 0).is_empty());
        assert!(w.check(&r(60.0), 60).is_empty());
        assert!(w.check(&r(99.0), 120).is_empty());
    }
}

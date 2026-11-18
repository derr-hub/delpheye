//! Throttling, judged the honest way: by how fast the processor actually runs under load
//! compared with the best it managed lately — no driver needed.
//!
//! Every laptop slows down a little after the first seconds of load: the short boost ends and
//! the long-term power limit takes over. That is by design and is reported as a power limit.
//! Only a slowdown that comes with heat (or that the firmware itself admits to) counts as
//! thermal throttling.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use super::sidecar::Frame;

/// Below this share of the recent best clock, the processor is being held back.
const HELD_BACK: f64 = 0.88;
/// Loads below this tell nothing about limits: an idle CPU is slow on purpose.
const BUSY: f64 = 50.0;
/// At or above this the processor is at its thermal ceiling on almost every laptop.
const HOT: f64 = 95.0;
/// How far back the best clock is remembered, in seconds.
const WINDOW: i64 = 15 * 60;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// No clock reading at all.
    #[default]
    Unknown,
    /// Not busy enough to judge.
    Idle,
    /// Running as fast as it recently could.
    Full,
    /// Held back by a power limit (normal for laptops, stronger on battery).
    Power,
    /// Held back because it is too hot.
    Thermal,
}

/// Seconds since the app started, by what the processor was doing while busy.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub busy: u64,
    pub full: u64,
    pub power: u64,
    pub thermal: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Throttle {
    pub state: State,
    /// Current clock as a share of the recent best under load, in percent.
    pub speed: Option<f64>,
    pub mhz: Option<f64>,
    pub peak_mhz: Option<f64>,
    pub load: Option<f64>,
    pub temp: Option<f64>,
    /// "sensor" (the CPU's own) or "acpi" (the firmware's thermal zone).
    pub temp_source: Option<String>,
    /// The firmware's own passive-cooling cap, when it is below 100 %.
    pub firmware_cap: Option<f64>,
    pub on_battery: bool,
    pub session: Session,
}

#[derive(Default)]
pub struct Tracker {
    /// (unix seconds, MHz) of recent busy moments.
    busy: VecDeque<(i64, f64)>,
    session: Session,
}

impl Tracker {
    pub fn update(&mut self, frame: &Frame) -> Throttle {
        let now = frame.at / 1000;
        let mhz = frame.cpu_clock();
        let load = frame.cpu_load();
        let (temp, temp_source) = match frame.sensor_cpu_temp() {
            Some(t) => (Some(t), Some("sensor")),
            None => (frame.zone_temp(), frame.zone_temp().map(|_| "acpi")),
        };
        let firmware_cap = frame.windows.as_ref().and_then(|w| w.zones.iter().filter_map(|z| z.passive).filter(|p| *p < 100.0).reduce(f64::min));
        let busy = load.is_some_and(|l| l >= BUSY);

        while self.busy.front().is_some_and(|(at, _)| now - at > WINDOW) {
            self.busy.pop_front();
        }
        if let (true, Some(mhz)) = (busy, mhz) {
            self.busy.push_back((now, mhz));
        }
        let peak = self.busy.iter().map(|(_, m)| *m).reduce(f64::max);
        let speed = match (mhz, peak) {
            (Some(m), Some(p)) if p > 0.0 => Some((m / p * 100.0).min(100.0)),
            _ => None,
        };

        let held = speed.is_some_and(|s| s < HELD_BACK * 100.0);
        let hot = temp.is_some_and(|t| t >= HOT);
        let state = if mhz.is_none() && firmware_cap.is_none() {
            State::Unknown
        } else if firmware_cap.is_some() || (busy && held && hot) {
            State::Thermal
        } else if !busy {
            State::Idle
        } else if held {
            State::Power
        } else {
            State::Full
        };

        if busy {
            self.session.busy += 1;
            match state {
                State::Full => self.session.full += 1,
                State::Power => self.session.power += 1,
                State::Thermal => self.session.thermal += 1,
                _ => {}
            }
        }
        Throttle {
            state,
            speed: speed.map(|s| s.round()),
            mhz: mhz.map(f64::round),
            peak_mhz: peak.map(f64::round),
            load,
            temp,
            temp_source: temp_source.map(str::to_string),
            firmware_cap,
            on_battery: frame.on_battery(),
            session: self.session.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::sidecar::{Frame, WinCpu, Zone};

    fn frame(second: i64, perf: f64, utility: f64, zone: f64) -> Frame {
        Frame {
            at: second * 1000,
            elevated: false,
            hardware: vec![],
            disks: vec![],
            windows: Some(WinCpu { perf: Some(perf), nominal_mhz: Some(1000.0), utility: Some(utility), zones: vec![Zone { name: "THRM".into(), temp: zone, passive: Some(100.0) }] }),
            throttle: None,
        }
    }

    #[test]
    fn idle_is_not_judged() {
        let mut t = Tracker::default();
        let r = t.update(&frame(1, 140.0, 5.0, 60.0));
        assert_eq!((r.state, r.mhz, r.temp_source.as_deref()), (State::Idle, Some(1400.0), Some("acpi")));
        assert_eq!(r.session.busy, 0);
    }

    #[test]
    fn boost_then_cool_settling_is_a_power_limit() {
        let mut t = Tracker::default();
        assert_eq!(t.update(&frame(1, 300.0, 100.0, 80.0)).state, State::Full);
        let r = t.update(&frame(2, 220.0, 100.0, 82.0));
        assert_eq!((r.state, r.speed), (State::Power, Some(73.0)));
    }

    #[test]
    fn slowing_down_while_hot_is_thermal() {
        let mut t = Tracker::default();
        t.update(&frame(1, 300.0, 100.0, 85.0));
        let r = t.update(&frame(2, 220.0, 100.0, 96.0));
        assert_eq!(r.state, State::Thermal);
        assert_eq!(r.session, Session { busy: 2, full: 1, power: 0, thermal: 1 });
    }

    #[test]
    fn hot_but_full_speed_is_fine_and_firmware_caps_always_count() {
        let mut t = Tracker::default();
        t.update(&frame(1, 300.0, 100.0, 96.0));
        assert_eq!(t.update(&frame(2, 295.0, 100.0, 97.0)).state, State::Full);
        let mut capped = frame(3, 100.0, 10.0, 70.0);
        capped.windows.as_mut().unwrap().zones[0].passive = Some(60.0);
        let r = t.update(&capped);
        assert_eq!((r.state, r.firmware_cap), (State::Thermal, Some(60.0)));
    }

    #[test]
    fn the_best_clock_is_forgotten_after_the_window() {
        let mut t = Tracker::default();
        t.update(&frame(1, 400.0, 100.0, 70.0));
        let r = t.update(&frame(1 + WINDOW + 5, 250.0, 100.0, 70.0));
        assert_eq!((r.state, r.peak_mhz), (State::Full, Some(2500.0)));
    }

    #[test]
    fn no_clock_means_unknown() {
        let mut t = Tracker::default();
        let mut f = frame(1, 0.0, 90.0, 70.0);
        f.windows = None;
        assert_eq!(t.update(&f).state, State::Unknown);
    }
}

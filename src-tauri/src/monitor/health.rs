//! Quick health checks that need no load: the crash record, disks, battery and the fans
//! as they have behaved lately.

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

use super::fans::Level;
use super::sidecar::Frame;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// How far back the crash record is read.
pub const LOG_DAYS: u64 = 90;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// What was checked, e.g. "crashes", "disk", "battery", "fan", "cpu-compute".
    pub id: String,
    /// The thing it is about, when there are several (a disk, a fan).
    pub subject: Option<String>,
    pub level: Level,
    /// Reason codes, translated by the UI.
    pub reasons: Vec<&'static str>,
    /// Numbers the UI shows next to the verdict.
    pub values: serde_json::Value,
}

impl Check {
    pub fn new(id: &str, subject: Option<String>, level: Level, reasons: Vec<&'static str>, values: serde_json::Value) -> Self {
        Self { id: id.into(), subject, level, reasons, values }
    }
}

#[derive(Default, Debug, PartialEq, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CrashLog {
    pub bluescreens: u32,
    pub unexpected_shutdowns: u32,
    pub hardware_errors: u32,
    pub hardware_warnings: u32,
    /// Error records the firmware kept from a reset it caused (BERT), read at the next boot.
    pub hardware_resets: u32,
    pub gpu_resets: u32,
    /// ISO time of the most recent event of any kind.
    pub last: Option<String>,
    /// What happened each time, newest first.
    #[serde(skip)]
    pub incidents: Vec<Incident>,
}

/// One crash-related event, read closely enough to say what probably happened.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Incident {
    /// ISO time.
    pub at: String,
    /// "shutdown", "bluescreen", "whea" or "gpu".
    pub kind: &'static str,
    /// Shutdowns: "bluescreen", "power-button", "sleep", "power-loss" or "unknown".
    /// Hardware errors: "cpu", "pcie", "memory" or "other".
    pub cause: Option<&'static str>,
    /// The stop code of a blue screen ("0x9F"), or "fatal"/"corrected" for hardware errors.
    pub code: Option<String>,
    /// A crash dump, a device or a driver.
    pub detail: Option<String>,
    /// The cause, weighed against everything else known (shutdowns and blue screens).
    pub verdict: Option<super::verdict::Verdict>,
}

/// Incidents kept per kind.
const INCIDENTS: usize = 30;

/// What a Common Platform Error Record (the "CPER" blob WHEA logs as raw data) says.
#[derive(Debug, PartialEq)]
pub struct Cper {
    /// "fatal", "recoverable", "corrected" or "info".
    pub severity: &'static str,
    /// "boot" (BERT: recorded by firmware before the last reset), "cpu", "pcie", "nmi" or "other".
    pub source: &'static str,
    /// When the error happened, by the firmware clock (local time), "YYYY-MM-DD HH:MM:SS".
    pub at: Option<String>,
}

/// Reads the header of a CPER record given as hex, as WHEA's RawData field carries it.
pub fn cper(hex: &str) -> Option<Cper> {
    let bytes: Vec<u8> = (0..hex.len() / 2).filter_map(|i| u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()).collect();
    if bytes.len() < 96 || &bytes[..4] != b"CPER" {
        return None;
    }
    let severity = match u32::from_le_bytes(bytes[12..16].try_into().ok()?) {
        0 => "recoverable",
        1 => "fatal",
        2 => "corrected",
        _ => "info",
    };
    // Notification type GUID, as stored (little-endian first three fields).
    let source = match &bytes[80..96] {
        n if n.starts_with(&[0x66, 0xA4, 0x61, 0x3D]) => "boot",
        n if n.starts_with(&[0xB1, 0x8B, 0xCE, 0x2D]) || n.starts_with(&[0xFE, 0x6F, 0xF5, 0xE8]) => "cpu",
        n if n.starts_with(&[0x1F, 0xC0, 0x93, 0xCF]) => "pcie",
        n if n.starts_with(&[0xFF, 0x89, 0xAD, 0x5B]) => "nmi",
        _ => "other",
    };
    // Header: signature, revision, end marker, section count, severity, validation bits, record
    // length (4 bytes each mostly), then the timestamp: seconds, minutes, hours, flags, day,
    // month, year, century — valid if bit 0 of the validation bits is set.
    let valid = u32::from_le_bytes(bytes[16..20].try_into().ok()?) & 1 == 1;
    let t = &bytes[24..32];
    let at = (valid && t[5] >= 1 && t[5] <= 12 && t[4] >= 1 && t[4] <= 31)
        .then(|| {
            // Firmware writes the century either as "20" or as "21st"; both mean 20xx today.
            let century = if t[7] > 20 { t[7] as u32 - 1 } else { t[7] as u32 };
            format!("{}-{:02}-{:02} {:02}:{:02}:{:02}", century * 100 + t[6] as u32, t[5], t[4], t[2], t[1], t[0])
        });
    Some(Cper { severity, source, at })
}

/// "0x0000009f (0x3, ...)" or "159" -> "0x9F".
fn stop_code(text: &str) -> Option<String> {
    let first = text.split_whitespace().next()?.trim_matches(|c| c == '(' || c == ',');
    let value = match first.strip_prefix("0x").or_else(|| first.strip_prefix("0X")) {
        Some(hex) => u64::from_str_radix(hex, 16).ok()?,
        None => first.parse::<u64>().ok()?,
    };
    (value != 0).then(|| format!("0x{value:X}"))
}

/// Counts crash-related events in the XML `wevtutil` prints.
pub fn parse_crash_log(xml: &str) -> CrashLog {
    let wrapped = format!("<Events>{xml}</Events>");
    let Ok(doc) = roxmltree::Document::parse(&wrapped) else { return CrashLog::default() };
    let mut log = CrashLog::default();
    let mut shutdown_times: Vec<i64> = Vec::new();
    for event in doc.root_element().children().filter(|n| n.has_tag_name("Event")) {
        let Some(system) = event.children().find(|n| n.has_tag_name("System")) else { continue };
        let field = |name: &str| system.children().find(|n| n.has_tag_name(name));
        let provider = field("Provider").and_then(|n| n.attribute("Name")).unwrap_or_default();
        let id: u32 = field("EventID").and_then(|n| n.text()).and_then(|t| t.trim().parse().ok()).unwrap_or(0);
        let level: u32 = field("Level").and_then(|n| n.text()).and_then(|t| t.trim().parse().ok()).unwrap_or(4);
        let at = field("TimeCreated").and_then(|n| n.attribute("SystemTime")).map(str::to_string);
        // The event's own fields: named ones by name, unnamed ones with an empty name.
        let mut data: Vec<(String, String)> = Vec::new();
        if let Some(event_data) = event.children().find(|n| n.has_tag_name("EventData")) {
            for d in event_data.children().filter(|n| n.has_tag_name("Data")) {
                data.push((d.attribute("Name").unwrap_or_default().to_string(), d.text().unwrap_or_default().trim().to_string()));
            }
        }
        let get = |name: &str| data.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
        let truthy = |name: &str| get(name).is_some_and(|v| v != "0" && !v.eq_ignore_ascii_case("false") && !v.is_empty());
        let incident = |kind, cause, code, detail| Incident { at: at.clone().unwrap_or_default(), kind, cause, code, detail, verdict: None };
        let counted = match (provider, id) {
            ("Microsoft-Windows-Kernel-Power", 41) => {
                shutdown_times.extend(at.as_deref().and_then(seconds));
                let code = get("BugcheckCode").and_then(stop_code);
                // Why the machine went down without saying goodbye, as far as Windows knows.
                let cause = if code.is_some() {
                    "bluescreen"
                } else if truthy("LongPowerButtonPressDetected") || truthy("PowerButtonTimestamp") {
                    "power-button"
                } else if truthy("SleepInProgress") {
                    "sleep"
                } else if data.is_empty() {
                    "unknown"
                } else {
                    "power-loss"
                };
                log.incidents.push(incident("shutdown", Some(cause), code, None));
                true
            }
            ("EventLog", 6008) => {
                shutdown_times.extend(at.as_deref().and_then(seconds));
                log.incidents.push(incident("shutdown", Some("unknown"), None, None));
                true
            }
            ("Microsoft-Windows-WER-SystemErrorReporting" | "BugCheck", 1001) => {
                log.bluescreens += 1;
                let code = get("param1").or_else(|| data.first().map(|(_, v)| v.as_str())).and_then(stop_code);
                let dump = get("param2").filter(|p| p.to_lowercase().ends_with(".dmp")).map(str::to_string);
                log.incidents.push(incident("bluescreen", None, code, dump));
                true
            }
            ("Microsoft-Windows-WHEA-Logger", _) if get("RawData").and_then(cper).is_some_and(|c| c.source == "boot") => {
                // Not an error Windows saw: a record the firmware kept from a reset it caused
                // itself, handed over at the next boot.
                let record = get("RawData").and_then(cper).unwrap();
                log.hardware_resets += 1;
                log.incidents.push(incident("whea", Some("boot-record"), Some(record.severity.to_string()), record.at));
                true
            }
            ("Microsoft-Windows-WHEA-Logger", _) => {
                // Level 1–2 are errors the hardware could not fix; 3 are ones it corrected.
                if level <= 2 { log.hardware_errors += 1 } else { log.hardware_warnings += 1 }
                let component = match id {
                    16 | 17 | 20 => "pcie",
                    18 | 19 => "cpu",
                    46 | 47 => "memory",
                    _ => "other",
                };
                let device = data.iter().find(|(_, v)| v.contains("VEN_")).map(|(_, v)| v.clone()).or_else(|| get("ApicId").map(|core| format!("APIC {core}")));
                log.incidents.push(incident("whea", Some(component), Some(if level <= 2 { "fatal" } else { "corrected" }.to_string()), device));
                true
            }
            ("Display", 4101) => {
                log.gpu_resets += 1;
                let driver = data.iter().map(|(_, v)| v.as_str()).find(|v| !v.is_empty()).map(str::to_string);
                log.incidents.push(incident("gpu", None, None, driver));
                true
            }
            _ => false,
        };
        if counted && log.last.as_deref() < at.as_deref() {
            log.last = at;
        }
    }
    // Windows records one unexpected shutdown twice (Kernel-Power 41 at the next boot and
    // EventLog 6008); entries within ten minutes of each other are one incident.
    shutdown_times.sort_unstable();
    log.unexpected_shutdowns = shutdown_times.iter().enumerate().filter(|(i, t)| *i == 0 || **t - shutdown_times[i - 1] > 600).count() as u32;

    // The same shutdown, recorded twice: keep Kernel-Power's account, which knows the cause.
    // A shutdown Windows knows nothing about, logged within minutes of a firmware reset record,
    // was that reset.
    let resets: Vec<(i64, Option<String>)> = log.incidents.iter().filter(|i| i.cause == Some("boot-record")).filter_map(|i| Some((seconds(&i.at)?, i.detail.clone()))).collect();
    for i in log.incidents.iter_mut().filter(|i| i.kind == "shutdown" && i.cause == Some("unknown")) {
        if let Some((_, when)) = seconds(&i.at).and_then(|t| resets.iter().find(|(r, _)| (r - t).abs() <= 600)) {
            i.cause = Some("hardware-reset");
            i.detail = when.clone();
        }
    }
    let (mut shutdowns, others): (Vec<Incident>, Vec<Incident>) = log.incidents.drain(..).partition(|i| i.kind == "shutdown");
    shutdowns.sort_by(|a, b| a.at.cmp(&b.at));
    let mut merged: Vec<Incident> = Vec::new();
    for incident in shutdowns {
        let close = merged.last().is_some_and(|last| matches!((seconds(&last.at), seconds(&incident.at)), (Some(a), Some(b)) if b - a <= 600));
        match merged.last_mut() {
            Some(last) if close => {
                if last.cause == Some("unknown") && incident.cause != Some("unknown") {
                    *last = incident;
                }
            }
            _ => merged.push(incident),
        }
    }
    log.incidents = merged.into_iter().chain(others).collect();
    log.incidents.sort_by(|a, b| b.at.cmp(&a.at));
    let mut kept: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    log.incidents.retain(|i| {
        let n = kept.entry(i.kind).or_default();
        *n += 1;
        *n <= INCIDENTS
    });
    log
}

/// Seconds since 1970 from an event time like `2026-10-01T10:00:00.1234567Z`.
pub fn iso_seconds(iso: &str) -> Option<i64> {
    seconds(iso)
}

fn seconds(iso: &str) -> Option<i64> {
    let number = |range: std::ops::Range<usize>| iso.get(range)?.parse::<i64>().ok();
    let (y, m, d) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hh, mm, ss) = (number(11..13)?, number(14..16)?, number(17..19)?);
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

pub fn read_crash_log(windows: &Path) -> Option<CrashLog> {
    let ms = LOG_DAYS * 24 * 3600 * 1000;
    let query = format!(
        "*[System[TimeCreated[timediff(@SystemTime) <= {ms}] and (\
         (Provider[@Name='Microsoft-Windows-Kernel-Power'] and EventID=41) or \
         (Provider[@Name='EventLog'] and EventID=6008) or \
         ((Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting'] or Provider[@Name='BugCheck']) and EventID=1001) or \
         (Provider[@Name='Microsoft-Windows-WHEA-Logger']) or \
         (Provider[@Name='Display'] and EventID=4101))]]"
    );
    let output = Command::new(windows.join("System32").join("wevtutil.exe"))
        .args(["qe", "System", &format!("/q:{query}"), "/f:xml", "/c:2000"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    output.status.success().then(|| {
        let mut log = parse_crash_log(&String::from_utf8_lossy(&output.stdout));
        super::verdict::judge_all(&mut log, &super::verdict::load_beats());
        log
    })
}

pub fn crash_checks(log: &CrashLog) -> Vec<Check> {
    let grade = |count: u32, warn_from: u32, bad_from: u32| {
        if count >= bad_from { Level::Bad } else if count >= warn_from { Level::Warn } else { Level::Ok }
    };
    let with = |kind: &str| {
        let mut v = serde_json::to_value(log).unwrap_or_default();
        v["events"] = serde_json::to_value(log.incidents.iter().filter(|i| i.kind == kind).collect::<Vec<_>>()).unwrap_or_default();
        v
    };
    let hardware = if log.hardware_errors > 0 {
        Level::Bad
    } else if log.hardware_resets > 0 {
        Level::Warn
    } else {
        grade(log.hardware_warnings, 1, 20)
    };
    let mut hardware_reasons = vec![if log.hardware_errors > 0 { "whea-errors" } else if log.hardware_warnings > 0 { "whea-corrected" } else if log.hardware_resets > 0 { "whea-only-resets" } else { "no-whea" }];
    if log.hardware_resets > 0 {
        hardware_reasons.push("whea-resets");
    }
    vec![
        Check::new("bluescreens", None, grade(log.bluescreens, 1, 3), vec![if log.bluescreens > 0 { "bluescreens" } else { "no-bluescreens" }], with("bluescreen")),
        Check::new(
            "shutdowns",
            None,
            grade(log.unexpected_shutdowns, 1, 4),
            vec![if log.unexpected_shutdowns > 0 { "shutdowns" } else { "no-shutdowns" }],
            with("shutdown"),
        ),
        Check::new(
            "hardware-errors",
            None,
            hardware,
            hardware_reasons,
            with("whea"),
        ),
        Check::new("gpu-resets", None, grade(log.gpu_resets, 1, 3), vec![if log.gpu_resets > 0 { "gpu-resets" } else { "no-gpu-resets" }], with("gpu")),
    ]
}

/// Disk health: Windows' own verdict, plus wear and temperature where the drive reports them.
pub fn disk_checks(frame: &Frame) -> Vec<Check> {
    let mut checks = Vec::new();
    for disk in &frame.disks {
        let level = match disk.health.as_str() {
            "healthy" => Level::Ok,
            "warning" => Level::Warn,
            "unhealthy" => Level::Bad,
            _ => Level::Unknown,
        };
        // Sensor names vary by drive; look for the usual wear and temperature readings.
        let storage = frame.hardware.iter().find(|h| h.kind == "Storage" && (h.name.contains(&disk.name) || disk.name.contains(&h.name)));
        let reading = |kind: &str, names: &[&str]| {
            storage.and_then(|h| h.sensors.iter().find(|s| s.kind == kind && names.iter().any(|n| s.name.contains(n)))).map(|s| s.value)
        };
        // Drives report either what is left ("Life", "Remaining Life") or what is used up
        // ("Percentage Used"); the two run in opposite directions.
        let exact = |kind: &str, name: &str| storage.and_then(|h| h.sensors.iter().find(|s| s.kind == kind && s.name == name)).map(|s| s.value);
        let life = exact("Level", "Life")
            .or_else(|| exact("Level", "Remaining Life"))
            .or_else(|| exact("Level", "Percentage Used").map(|used| 100.0 - used))
            .map(|v| v.clamp(0.0, 100.0));
        // The drive's own temperature, not its warning or critical limits.
        let temp = exact("Temperature", "Composite Temperature").or_else(|| exact("Temperature", "Temperature")).or_else(|| reading("Temperature", &["Temperature #1"]));
        let mut reasons = vec![match level {
            Level::Ok => "disk-healthy",
            Level::Warn => "disk-warning",
            Level::Bad => "disk-unhealthy",
            Level::Unknown => "disk-unknown",
        }];
        let mut level = level;
        if temp.is_some_and(|t| t >= 70.0) {
            reasons.push("disk-hot");
            level = level.max(Level::Warn);
        }
        if let Some(life) = life {
            if life < 10.0 {
                reasons.push("disk-worn-out");
                level = level.max(Level::Bad);
            } else if life < 30.0 {
                reasons.push("disk-wearing");
                level = level.max(Level::Warn);
            } else {
                reasons.push("disk-life");
            }
        }
        checks.push(Check::new(
            "disk",
            Some(disk.name.clone()),
            level,
            reasons,
            serde_json::json!({ "media": disk.media, "size": disk.size, "life": life, "temp": temp }),
        ));
    }
    checks
}

/// Battery wear: how much of its original capacity the battery has lost.
pub fn battery_check(frame: &Frame) -> Option<Check> {
    let battery = frame.hardware.iter().find(|h| h.kind == "Battery")?;
    let energy = |name: &str| battery.sensors.iter().find(|s| s.kind == "Energy" && s.name.contains(name)).map(|s| s.value);
    let (design, full) = (energy("Designed")?, energy("Full")?);
    if design <= 0.0 {
        return None;
    }
    let wear = ((1.0 - full / design) * 100.0).clamp(0.0, 100.0);
    let level = if wear >= 40.0 { Level::Bad } else if wear >= 20.0 { Level::Warn } else { Level::Ok };
    let reason = match level {
        Level::Ok => "battery-good",
        Level::Warn => "battery-worn",
        _ => "battery-very-worn",
    };
    Some(Check::new("battery", Some(battery.name.clone()), level, vec![reason], serde_json::json!({ "design": design, "full": full, "wear": wear })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(provider: &str, id: u32, level: u32, at: &str) -> String {
        format!(
            "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='{provider}'/><EventID>{id}</EventID><Level>{level}</Level><TimeCreated SystemTime='{at}'/></System></Event>"
        )
    }

    #[test]
    fn crash_events_are_counted_by_kind() {
        let xml = [
            event("Microsoft-Windows-Kernel-Power", 41, 1, "2026-10-01T10:00:00Z"),
            // The same incident, recorded again by the event log a minute later.
            event("EventLog", 6008, 2, "2026-10-01T10:01:10Z"),
            event("EventLog", 6008, 2, "2026-10-02T10:00:00Z"),
            event("Microsoft-Windows-WER-SystemErrorReporting", 1001, 2, "2026-11-05T10:00:00Z"),
            event("Microsoft-Windows-WHEA-Logger", 19, 3, "2026-10-03T10:00:00Z"),
            event("Microsoft-Windows-WHEA-Logger", 18, 2, "2026-10-04T10:00:00Z"),
            event("Display", 4101, 3, "2026-10-05T10:00:00Z"),
            event("Microsoft-Windows-WindowsUpdateClient", 19, 4, "2026-11-10T10:00:00Z"),
        ]
        .concat();
        let log = parse_crash_log(&xml);
        assert_eq!(
            CrashLog { incidents: Vec::new(), ..log.clone() },
            CrashLog {
                bluescreens: 1,
                unexpected_shutdowns: 2,
                hardware_errors: 1,
                hardware_warnings: 1,
                hardware_resets: 0,
                gpu_resets: 1,
                last: Some("2026-11-05T10:00:00Z".into()),
                incidents: Vec::new(),
            }
        );
        // The doubled shutdown is one incident; the lone 6008 stays as "unknown".
        assert_eq!(log.incidents.iter().filter(|i| i.kind == "shutdown").count(), 2);
        let levels: Vec<Level> = crash_checks(&log).iter().map(|c| c.level).collect();
        assert_eq!(levels, [Level::Warn, Level::Warn, Level::Bad, Level::Warn]);
    }

    fn with_data(provider: &str, id: u32, level: u32, at: &str, data: &[(&str, &str)]) -> String {
        let fields: String = data.iter().map(|(n, v)| if n.is_empty() { format!("<Data>{v}</Data>") } else { format!("<Data Name='{n}'>{v}</Data>") }).collect();
        event(provider, id, level, at).replace("</System></Event>", &format!("</System><EventData>{fields}</EventData></Event>"))
    }

    #[test]
    fn incidents_say_what_probably_happened() {
        let xml = [
            with_data("Microsoft-Windows-Kernel-Power", 41, 1, "2026-10-01T10:00:00Z", &[("BugcheckCode", "0"), ("PowerButtonTimestamp", "133000000000"), ("SleepInProgress", "0")]),
            with_data("Microsoft-Windows-Kernel-Power", 41, 1, "2026-10-02T10:00:00Z", &[("BugcheckCode", "0"), ("PowerButtonTimestamp", "0"), ("SleepInProgress", "4")]),
            with_data("Microsoft-Windows-Kernel-Power", 41, 1, "2026-10-03T10:00:00Z", &[("BugcheckCode", "0"), ("PowerButtonTimestamp", "0"), ("SleepInProgress", "0")]),
            with_data("Microsoft-Windows-Kernel-Power", 41, 1, "2026-10-04T10:00:00Z", &[("BugcheckCode", "159"), ("PowerButtonTimestamp", "0")]),
            with_data("BugCheck", 1001, 2, "2026-10-04T10:01:00Z", &[("param1", "0x0000009f (0x3, 0xffff)"), ("param2", r"C:\WINDOWS\Minidump\100426-1.dmp")]),
            with_data("Microsoft-Windows-WHEA-Logger", 17, 3, "2026-10-05T10:00:00Z", &[("ErrorSource", "4"), ("PrimaryDeviceName", r"PCI\VEN_8086&amp;DEV_7E4D")]),
            with_data("Display", 4101, 3, "2026-10-06T10:00:00Z", &[("", "nvlddmkm"), ("", "")]),
        ]
        .concat();
        let log = parse_crash_log(&xml);
        let shutdown = |day: &str| log.incidents.iter().find(|i| i.kind == "shutdown" && i.at.starts_with(day)).unwrap();
        assert_eq!(shutdown("2026-10-01").cause, Some("power-button"));
        assert_eq!(shutdown("2026-10-02").cause, Some("sleep"));
        assert_eq!(shutdown("2026-10-03").cause, Some("power-loss"));
        assert_eq!((shutdown("2026-10-04").cause, shutdown("2026-10-04").code.as_deref()), (Some("bluescreen"), Some("0x9F")));
        let bsod = log.incidents.iter().find(|i| i.kind == "bluescreen").unwrap();
        assert_eq!((bsod.code.as_deref(), bsod.detail.as_deref()), (Some("0x9F"), Some(r"C:\WINDOWS\Minidump\100426-1.dmp")));
        let whea = log.incidents.iter().find(|i| i.kind == "whea").unwrap();
        assert_eq!((whea.cause, whea.code.as_deref(), whea.detail.as_deref()), (Some("pcie"), Some("corrected"), Some(r"PCI\VEN_8086&DEV_7E4D")));
        assert_eq!(log.incidents.iter().find(|i| i.kind == "gpu").unwrap().detail.as_deref(), Some("nvlddmkm"));
        assert_eq!(log.incidents[0].kind, "gpu", "newest first");
        let checks = crash_checks(&log);
        assert_eq!(checks[1].values["events"].as_array().unwrap().len(), 4);
    }

    /// A real boot error record from this kind of laptop (WHEA event 3).
    const BERT: &str = "435045520101FFFFFFFF010003000000010000003C010000283213001B091A152DBD25AC378148538D496D31DEE79564000000000000000000000000000000002DBD25AC378148538D496D31DEE7956466A4613D40AB9A40A698F362D464B38F0000000000000000000000000000000000000000000000000000000000000000C80000007400000000010000010000002F1CA4939FA0C2E7AC1FF2488F03EEC3000000000000000000000000000000000300000000000000000000000000";

    #[test]
    fn boot_error_records_are_decoded() {
        assert_eq!(cper(BERT), Some(Cper { severity: "info", source: "boot", at: Some("2026-09-27 19:50:40".into()) }));
        assert_eq!(cper("00112233"), None);
    }

    #[test]
    fn a_shutdown_next_to_a_firmware_reset_record_was_that_reset() {
        let xml = [
            event("EventLog", 6008, 2, "2026-09-27T16:51:21Z"),
            with_data("Microsoft-Windows-WHEA-Logger", 3, 4, "2026-09-27T16:51:23Z", &[("Length", "316"), ("RawData", BERT)]),
            event("EventLog", 6008, 2, "2026-10-09T15:46:46Z"),
        ]
        .concat();
        let log = parse_crash_log(&xml);
        assert_eq!((log.hardware_resets, log.hardware_warnings), (1, 0));
        let causes: Vec<(&str, Option<&str>)> = log.incidents.iter().filter(|i| i.kind == "shutdown").map(|i| (i.cause.unwrap(), i.detail.as_deref())).collect();
        assert_eq!(causes, [("unknown", None), ("hardware-reset", Some("2026-09-27 19:50:40"))]);
        let whea = &crash_checks(&log)[2];
        assert_eq!((whea.level, whea.reasons.clone()), (Level::Warn, vec!["whea-only-resets", "whea-resets"]));
    }

    #[test]
    fn stop_codes_are_normalised() {
        assert_eq!(stop_code("0x0000009f (0x3, 0x1)").as_deref(), Some("0x9F"));
        assert_eq!(stop_code("159").as_deref(), Some("0x9F"));
        assert_eq!(stop_code("0"), None);
    }

    #[test]
    fn event_times_convert_to_unix_seconds() {
        assert_eq!(seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(seconds("2026-10-01T10:00:00.1234567Z"), Some(1_790_848_800));
        assert_eq!(seconds("garbage"), None);
    }

    #[test]
    fn a_clean_record_is_all_ok() {
        let checks = crash_checks(&parse_crash_log(""));
        assert!(checks.iter().all(|c| c.level == Level::Ok));
        assert_eq!(checks[0].reasons, ["no-bluescreens"]);
    }

    #[test]
    fn drive_life_is_read_the_right_way_round() {
        let frame: Frame = serde_json::from_value(serde_json::json!({
            "at": 0, "elevated": true,
            "disks": [{ "name": "MTFDKBA1T0QFM", "media": "ssd", "health": "healthy", "size": 1 }],
            "hardware": [{ "id": "/nvme/0", "name": "MTFDKBA1T0QFM-1BD1AABGB", "type": "Storage", "sensors": [
                { "id": "w", "name": "Warning Temperature", "type": "Temperature", "value": 86.0 },
                { "id": "c", "name": "Composite Temperature", "type": "Temperature", "value": 41.0 },
                { "id": "u", "name": "Percentage Used", "type": "Level", "value": 6.0 },
                { "id": "l", "name": "Life", "type": "Level", "value": 94.0 },
            ]}]
        }))
        .unwrap();
        let check = &disk_checks(&frame)[0];
        assert_eq!((check.values["life"].as_f64(), check.values["temp"].as_f64()), (Some(94.0), Some(41.0)));
        assert_eq!((check.level, check.reasons.clone()), (Level::Ok, vec!["disk-healthy", "disk-life"]));
    }

    #[test]
    fn battery_wear_comes_from_design_and_full_capacity() {
        let frame: Frame = serde_json::from_value(serde_json::json!({
            "at": 0, "elevated": false, "disks": [],
            "hardware": [{ "id": "/battery/0", "name": "S560647", "type": "Battery", "sensors": [
                { "id": "a", "name": "Designed Capacity", "type": "Energy", "value": 70000.0 },
                { "id": "b", "name": "Full Charged Capacity", "type": "Energy", "value": 52500.0 },
            ]}]
        }))
        .unwrap();
        let check = battery_check(&frame).unwrap();
        assert_eq!((check.level, check.values["wear"].as_f64().unwrap().round()), (Level::Warn, 25.0));
    }
}

//! What Windows itself remembers: drivers, updates, installs, new services and crashes from its event
//! logs, and install dates. Read once for the past, then only for what is new.

use std::collections::{HashMap, HashSet};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

use super::{Event, Timeline, now};
use crate::monitor::health::iso_seconds;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Default, Clone)]
pub struct Record {
    pub t: i64,
    pub data: HashMap<String, String>,
    /// Unnamed values, in order.
    pub list: Vec<String>,
}

impl Record {
    fn get(&self, k: &str) -> &str {
        self.data.get(k).map(|s| s.as_str()).unwrap_or_default()
    }
}

pub fn parse(xml: &str) -> Vec<Record> {
    let Ok(doc) = roxmltree::Document::parse(xml) else {
        crate::errlog::write("timeline", "event log text could not be read");
        return Vec::new();
    };
    let mut out: Vec<Record> = doc
        .root_element()
        .children()
        .filter(|n| n.tag_name().name() == "Event")
        .filter_map(|e| {
            let at = e.descendants().find(|n| n.tag_name().name() == "TimeCreated")?.attribute("SystemTime")?;
            let mut r = Record { t: iso_seconds(at)?, ..Default::default() };
            for d in e.descendants().filter(|n| n.tag_name().name() == "Data") {
                let v = d.text().unwrap_or_default().trim().to_string();
                match d.attribute("Name") {
                    Some(n) => {
                        r.data.insert(n.to_string(), v);
                    }
                    None => r.list.push(v),
                }
            }
            Some(r)
        })
        .collect();
    out.sort_by_key(|r| r.t);
    out
}

/// Event-log text can carry characters XML forbids; they must not lose the rest.
fn clean(s: &str) -> String {
    s.chars().filter(|c| matches!(c, '\t' | '\n' | '\r') || (*c >= ' ' && *c != '\u{fffe}' && *c != '\u{ffff}' && *c != '\u{feff}')).collect()
}

/// Oldest first. `None` when the log could not be asked.
fn query(windows: &Path, log: &str, what: &str, since: i64) -> Option<Vec<Record>> {
    let ms = (now() - since).max(60) * 1000;
    let q = format!("*[System[TimeCreated[timediff(@SystemTime) <= {ms}] and {what}]]");
    let out = Command::new(windows.join("System32").join("wevtutil.exe")).args(["qe", log, &format!("/q:{q}"), "/f:xml", "/uni:true", "/c:4000"]).creation_flags(CREATE_NO_WINDOW).output().ok()?;
    if !out.status.success() {
        crate::errlog::write("timeline", &format!("{log}: {}", crate::startup::decode(&out.stderr).trim()));
        return None;
    }
    Some(parse(&format!("<Events>{}</Events>", clean(&crate::startup::decode(&out.stdout)))))
}

/// What a driver is for, from its device class.
pub fn class(guid: &str) -> &'static str {
    match guid.trim_matches(['{', '}']).to_lowercase().as_str() {
        "4d36e968-e325-11ce-bfc1-08002be10318" => "display",
        "4d36e972-e325-11ce-bfc1-08002be10318" => "network",
        "4d36e96c-e325-11ce-bfc1-08002be10318" => "sound",
        "e0cbf06c-cd8b-4647-bb8a-263b43f0f974" => "bluetooth",
        "4d36e967-e325-11ce-bfc1-08002be10318" | "4d36e97b-e325-11ce-bfc1-08002be10318" | "4d36e96a-e325-11ce-bfc1-08002be10318" => "storage",
        "36fc9e60-c465-11cf-8056-444553540000" => "usb",
        "4d36e97d-e325-11ce-bfc1-08002be10318" => "system",
        "ca3e7ab9-b4c3-4ae6-8251-579ef933890f" | "6bdd1fc6-810f-11d0-bec7-08002be2092f" => "camera",
        "745a17a0-74d3-11d0-b6fe-00a0c90f57da" | "4d36e96b-e325-11ce-bfc1-08002be10318" | "4d36e96f-e325-11ce-bfc1-08002be10318" => "input",
        "f2e7dd72-6468-4e36-b6f1-6488f42c1b52" => "firmware",
        "5c4c3332-344d-483c-8739-259e934c9cc8" | "e2f84ce7-8efa-411c-aa69-97454ca4cb57" => "component",
        _ => "other",
    }
}

pub fn drivers(records: &[Record]) -> Vec<Event> {
    let mut seen = HashSet::new();
    records
        .iter()
        .filter(|r| r.get("Status") == "0x0" && r.get("DriverInbox") != "true")
        .filter(|r| !r.get("DriverProvider").is_empty() && r.get("DriverProvider") != "Microsoft")
        .filter_map(|r| {
            let (class, provider, version) = (class(r.get("ClassGuid")), r.get("DriverProvider"), r.get("DriverVersion"));
            // Plugging a device in again configures the same driver; the first time is the news.
            // The package's own name ("netwtw16.inf_amd64_…") keeps one maker's different devices apart.
            let family = r.get("DriverPackageId").split(".inf").next().unwrap_or_default().to_lowercase();
            let name = format!("{provider}|{class}|{family}");
            seen.insert((name.clone(), version.to_string())).then(|| Event::windows(r.t, "driver", "added", &name, Some(version.into()), version))
        })
        .collect()
}

/// Store apps ("9NRZT3Q9R3DL-…") and daily antivirus definitions come all the time and change little.
pub fn is_noise(title: &str) -> bool {
    let store = title.split_once('-').is_some_and(|(id, _)| id.len() == 12 && id.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
    store || title.contains("KB2267602") || title.contains("KB4052623")
}

pub fn updates(records: &[Record]) -> Vec<Event> {
    records
        .iter()
        .map(|r| (r, r.get("updateTitle")))
        .filter(|(_, title)| !title.is_empty() && !is_noise(title))
        .map(|(r, title)| Event::windows(r.t, "update", "happened", title, None, r.get("updateGuid")))
        .collect()
}

/// Some programs register their service anew on every start: only the first time is kept.
pub fn services(records: &[Record]) -> Vec<Event> {
    records.iter().filter(|r| !r.get("ServiceName").is_empty()).map(|r| Event::windows(r.t, "service", "added", r.get("ServiceName"), Some(r.get("ImagePath").into()), "")).collect()
}

/// Windows Installer packages: [name, version, language, status, maker]. One maker's packages within
/// ten minutes are one thing that happened.
pub fn packages(records: &[Record], action: &str) -> Vec<Event> {
    let mut groups: Vec<(i64, &str, Vec<(&str, &str)>)> = Vec::new();
    for r in records.iter().filter(|r| r.list.len() >= 5 && r.list[3] == "0") {
        let item = (r.list[0].as_str(), r.list[1].as_str());
        match groups.iter_mut().rev().find(|g| g.1 == r.list[4] && r.t - g.0 <= 600) {
            Some(g) if !g.2.contains(&item) => g.2.push(item),
            Some(_) => {}
            None => groups.push((r.t, r.list[4].as_str(), vec![item])),
        }
    }
    groups
        .into_iter()
        .map(|(t, maker, items)| {
            let key = t.to_string();
            match items.as_slice() {
                [(name, version)] => Event::windows(t, "program", action, name, Some(version.to_string()), &key),
                many => Event::windows(t, "program", action, maker, Some(many.iter().map(|(n, v)| format!("{n} {v}")).collect::<Vec<_>>().join("\n")), &key),
            }
        })
        .collect()
}

/// Programs that crashed, once per program and day.
pub fn app_crashes(records: &[Record]) -> Vec<Event> {
    records
        .iter()
        .filter(|r| !r.get("AppName").is_empty())
        .map(|r| {
            let mut e = Event::windows(r.t, "appcrash", "happened", r.get("AppName"), Some(r.get("ModuleName").into()), &(r.t / 86_400).to_string());
            // Where the module is: whose it is can be asked later.
            e.was = Some(r.get("ModulePath").to_string()).filter(|p| !p.is_empty());
            e.detail = Some(
                serde_json::json!({
                    "code": r.get("ExceptionCode"), "offset": r.get("FaultingOffset"), "stamp": r.get("ModuleTimeStamp"),
                    "moduleVersion": r.get("ModuleVersion"), "app": r.get("AppPath"), "appVersion": r.get("AppVersion"),
                })
                .to_string(),
            );
            e
        })
        .collect()
}

/// Programs that stopped answering, once per program and day.
pub fn hangs(records: &[Record]) -> Vec<Event> {
    records
        .iter()
        .filter(|r| !r.get("AppName").is_empty())
        .map(|r| {
            let mut e = Event::windows(r.t, "hang", "happened", r.get("AppName"), Some(r.get("AppVersion").into()).filter(|v: &String| !v.is_empty()), &(r.t / 86_400).to_string());
            e.was = Some(r.get("ExeFileName").to_string()).filter(|p| !p.is_empty());
            e
        })
        .collect()
}

/// Services that stopped on their own, once per service and day, with how many times.
pub fn service_crashes(records: &[Record]) -> Vec<Event> {
    let mut out: Vec<Event> = Vec::new();
    for r in records.iter().filter(|r| !r.get("param1").is_empty()) {
        let e = Event::windows(r.t, "svccrash", "happened", r.get("param1"), Some("1".into()), &(r.t / 86_400).to_string());
        match out.iter_mut().find(|x| x.uniq == e.uniq) {
            Some(x) => x.now = x.now.as_ref().and_then(|n| n.parse::<u32>().ok()).map(|n| (n + 1).to_string()),
            None => out.push(e),
        }
    }
    out
}

/// The computer's own day: on, off, asleep, awake. A wake seconds after going to sleep is no sleep.
pub fn power(records: &[Record], name: &str) -> Vec<Event> {
    records.iter().map(|r| Event::windows(r.t, "power", "happened", name, Some(r.get("Reason").to_string()).filter(|s| !s.is_empty()), &(r.t / 300).to_string())).collect()
}

pub fn supply(records: &[Record]) -> Vec<Event> {
    records.iter().filter_map(|r| match r.get("AcOnline") { "true" => Some((r, "plugged")), "false" => Some((r, "unplugged")), _ => None }).map(|(r, n)| Event::windows(r.t, "power", "happened", n, None, &r.t.to_string())).collect()
}

/// Networks joined and left. Windows often writes the same thing several times in a row.
pub fn networks(records: &[Record], action: &str) -> Vec<Event> {
    let mut out: Vec<Event> = Vec::new();
    for r in records {
        let name = r.get("Name");
        // "Identifying…" is Windows still finding out, not a network.
        if name.is_empty() || name.ends_with("...") || name.ends_with('…') || out.iter().rev().take(4).any(|e| e.name == name && r.t - e.t < 600) {
            continue;
        }
        out.push(Event::windows(r.t, "net", action, name, None, &r.t.to_string()));
    }
    out
}

pub fn defender(records: &[Record], name: &str) -> Vec<Event> {
    records
        .iter()
        .map(|r| {
            let threat = r.get("Threat Name");
            Event::windows(r.t, "security", "happened", name, Some(threat.to_string()).filter(|t| !t.is_empty()), &r.t.to_string())
        })
        .collect()
}

pub fn plain(records: &[Record], kind: &str, name: &str) -> Vec<Event> {
    records.iter().map(|r| Event::windows(r.t, kind, "happened", name, None, &(r.t / 3600).to_string())).collect()
}

/// "20261120" at noon: the installer noted only the day.
fn noon(date: &str) -> Option<i64> {
    if date.len() != 8 || !date.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    iso_seconds(&format!("{}-{}-{}T12:00:00Z", &date[..4], &date[4..6], &date[6..]))
}

/// Install dates. Windows rewrites them on updates too, so they say "installed or updated" ("dated").
/// What another record already tells, with its exact time, is left out.
pub fn dated(programs: &[super::changes::Program], known: &[Event], at: i64) -> Vec<Event> {
    programs
        .iter()
        .filter_map(|p| {
            let t = noon(p.date.as_deref()?)?;
            let told = |e: &Event| e.kind == "program" && (e.t - t).abs() < 129_600 && (e.name == p.name || e.now.as_deref().is_some_and(|v| v.lines().any(|l| l.starts_with(&p.name))));
            if known.iter().any(told) {
                return None;
            }
            (t <= at + 86_400 && t > at - super::EVENT_DAYS * 86_400).then(|| {
                let mut e = Event::windows(t, "program", "dated", &p.name, p.version.clone(), &t.to_string());
                e.day_only = true;
                e
            })
        })
        .collect()
}

pub fn look(line: &Timeline, windows: &Path) {
    let at = now();
    let number = |key: &str| line.kv(key).and_then(|v| v.parse::<i64>().ok());
    let last = number("past");
    // After "erase" nothing older than that moment is read back in.
    let floor = number("from").unwrap_or(at - super::EVENT_DAYS * 86_400);
    // A day of overlap: an event can be written a little after the fact. Repeats are ignored.
    let since = last.map_or(floor, |t| (t - 86_400).max(floor));
    let mut whole = true;
    let mut read = |log: &str, what: &str, make: &dyn Fn(&[Record]) -> Vec<Event>| match query(windows, log, what, since) {
        Some(records) => {
            line.add(&make(&records));
        }
        None => whole = false,
    };
    read("Microsoft-Windows-Kernel-PnP/Configuration", "EventID=400", &drivers);
    read("System", "Provider[@Name='Microsoft-Windows-WindowsUpdateClient'] and EventID=19", &updates);
    read("System", "Provider[@Name='Service Control Manager'] and EventID=7045", &services);
    read("Application", "Provider[@Name='MsiInstaller'] and EventID=1033", &|r| packages(r, "added"));
    read("Application", "Provider[@Name='MsiInstaller'] and EventID=1034", &|r| packages(r, "removed"));
    read("Application", "Provider[@Name='Application Error'] and EventID=1000", &app_crashes);
    let system = |p: &str, id: u32| format!("Provider[@Name='{p}'] and EventID={id}");
    read("Application", "Provider[@Name='Application Hang'] and EventID=1002", &hangs);
    read("System", "Provider[@Name='Service Control Manager'] and (EventID=7031 or EventID=7034)", &service_crashes);
    read("System", &system("Microsoft-Windows-Kernel-General", 12), &|r| power(r, "boot"));
    read("System", &system("Microsoft-Windows-Kernel-General", 13), &|r| power(r, "off"));
    read("System", &system("Microsoft-Windows-Kernel-Power", 42), &|r| power(r, "sleep"));
    read("System", &system("Microsoft-Windows-Power-Troubleshooter", 1), &|r| power(r, "wake"));
    read("System", &system("Microsoft-Windows-Kernel-Power", 506), &|r| power(r, "sleep"));
    read("System", &system("Microsoft-Windows-Kernel-Power", 507), &|r| power(r, "wake"));
    read("System", &system("Microsoft-Windows-Kernel-Power", 105), &supply);
    read("System", "Provider[@Name='disk'] and (EventID=7 or EventID=11 or EventID=51 or EventID=153 or EventID=154)", &|r| plain(r, "io", "disk"));
    read("System", "Provider[@Name='Ntfs'] and EventID=55", &|r| plain(r, "io", "ntfs"));
    read("System", "Provider[@Name='storahci' or @Name='stornvme'] and EventID=129", &|r| plain(r, "io", "reset"));
    read("System", &system("Microsoft-Windows-Resource-Exhaustion-Detector", 2004), &|r| plain(r, "alert", "commit-full"));
    // Some computers have these logs switched off; that is no reason to read everything again next time.
    for (log, id, make) in [
        ("Microsoft-Windows-NetworkProfile/Operational", "EventID=10000", &(|r: &[Record]| networks(r, "added")) as &dyn Fn(&[Record]) -> Vec<Event>),
        ("Microsoft-Windows-NetworkProfile/Operational", "EventID=10001", &|r| networks(r, "removed")),
        ("Microsoft-Windows-Windows Defender/Operational", "EventID=1116", &|r| defender(r, "threat")),
        ("Microsoft-Windows-Windows Defender/Operational", "EventID=5001", &|r| defender(r, "guard-off")),
        ("Microsoft-Windows-Windows Defender/Operational", "EventID=5000", &|r| defender(r, "guard-on")),
    ] {
        if let Some(records) = query(windows, log, id, since) {
            line.add(&make(&records));
        }
    }
    if let Some(log) = crate::monitor::health::read_crash_log(windows) {
        let events: Vec<Event> = log
            .incidents
            .iter()
            .filter(|i| i.kind != "whea" || i.code.as_deref() == Some("fatal"))
            .filter_map(|i| Some(Event::windows(iso_seconds(&i.at)?, "crash", "happened", i.kind, i.verdict.as_ref().map(|v| format!("{}|{}", v.cause, v.confidence)), &i.at)))
            .filter(|e| e.t >= floor)
            .collect();
        line.add(&events);
    }
    if last.is_none() {
        line.add(&dated(&super::changes::programs(), &line.events(0, i64::MAX), at));
    }
    if whole {
        line.set_kv("past", &at.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(t: i64, data: &[(&str, &str)]) -> Record {
        Record { t, data: data.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(), list: vec![] }
    }

    #[test]
    fn records_are_read_from_xml() {
        let r = parse("<Events><Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><TimeCreated SystemTime='2026-11-23T18:14:06.3Z'/></System><EventData><Data Name='A'>b</Data></EventData></Event><Event><System><TimeCreated SystemTime='2026-11-23T18:14:05Z'/></System><EventData><Data>Name</Data><Data>1.1</Data></EventData></Event></Events>");
        assert_eq!((r.len(), r[0].list[1].as_str(), r[1].get("A"), r[1].t - r[0].t), (2, "1.1", "b", 1));
        assert_eq!(clean("a\u{1}b\n"), "ab\n");
    }

    #[test]
    fn a_driver_is_news_once() {
        let gpu = "{4d36e968-e325-11ce-bfc1-08002be10318}";
        let d = |t, v, inbox, who| rec(t, &[("ClassGuid", gpu), ("DriverVersion", v), ("DriverInbox", inbox), ("DriverProvider", who), ("DriverPackageId", "nv.inf_amd64_1"), ("Status", "0x0")]);
        let e = drivers(&[d(5, "9", "true", "Microsoft"), d(10, "1", "false", "NVIDIA"), d(20, "1", "false", "NVIDIA"), d(30, "2", "false", "NVIDIA")]);
        assert_eq!(e.iter().map(|e| (e.t, e.name.as_str(), e.now.as_deref())).collect::<Vec<_>>(), vec![(10, "NVIDIA|display|nv", Some("1")), (30, "NVIDIA|display|nv", Some("2"))]);
    }

    #[test]
    fn repeated_network_lines_and_service_crashes_are_folded() {
        let n = |t, name: &str| rec(t, &[("Name", name)]);
        assert_eq!(networks(&[n(0, "Home"), n(5, "Home"), n(300, "Home"), n(9000, "Home"), n(9001, "Cafe")], "added").len(), 3);
        let s = |t| rec(t, &[("param1", "Energy")]);
        let e = service_crashes(&[s(10), s(20), s(30), s(90_000)]);
        assert_eq!(e.iter().map(|e| e.now.as_deref()).collect::<Vec<_>>(), vec![Some("3"), Some("1")]);
    }

    #[test]
    fn noise_is_left_out() {
        assert!(is_noise("9NRZT3Q9R3DL-Microsoft.WindowsAppRuntime.2"));
        assert!(is_noise("Security Intelligence Update - KB2267602"));
        assert!(!is_noise("2026-11 Cumulative Update for Windows 11 (KB5099999)"));
    }

    #[test]
    fn packages_of_one_setup_are_one_event() {
        let p = |t, n: &str, status: &str| Record { t, list: vec![n.into(), "1".into(), "1033".into(), status.into(), "Maker".into()], ..Default::default() };
        let e = packages(&[p(0, "A", "0"), p(60, "B", "0"), p(70, "Failed", "1603"), p(9000, "C", "0")], "added");
        assert_eq!(e.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["Maker", "C"]);
    }

    #[test]
    fn a_date_repeats_nothing_already_known() {
        let p = |n: &str| super::super::changes::Program { id: n.into(), name: n.into(), version: None, date: Some("20261120".into()) };
        let t = noon("20261120").unwrap();
        let known = [Event::windows(t + 3600, "program", "added", "A", None, "x")];
        let e = dated(&[p("A"), p("B")], &known, t);
        assert_eq!(e.iter().map(|e| (e.name.as_str(), e.day_only)).collect::<Vec<_>>(), vec![("B", true)]);
    }

    #[test]
    fn install_dates_are_days() {
        assert_eq!(noon("20.11.2026 0:00:00"), None);
        assert_eq!(noon("20261120").map(|t| t % 86_400), Some(43_200));
    }
}

//! Which programs worked, from when to when, and how long each was in front of the user. Names and
//! numbers only: no window titles, no documents.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde::Serialize;
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

use crate::processes::Sample;

/// Seconds between looks; a program unseen for longer than `GONE` has closed.
pub const EVERY: i64 = 5;
const GONE: i64 = 25;

/// Parts of Windows that are in front without the user having opened anything.
const SHELL: [&str; 12] = [
    "explorer.exe",
    "searchhost.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "lockapp.exe",
    "applicationframehost.exe",
    "textinputhost.exe",
    "dwm.exe",
    "logonui.exe",
    "consent.exe",
    "shellhost.exe",
    "system",
];

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub start: i64,
    pub end: i64,
    pub name: String,
    pub exe: String,
    pub title: Option<String>,
    pub company: Option<String>,
    /// Seconds in front.
    pub front: i64,
    /// Average share of the whole processor, percent.
    pub cpu: f64,
    /// Largest memory, MB.
    pub mem: i64,
    /// Read and written, MB.
    pub disk: i64,
    pub game: bool,
}

#[derive(Default, Clone)]
struct Live {
    name: String,
    exe: String,
    start: i64,
    last: i64,
    front: i64,
    full: i64,
    cpu: f64,
    n: u32,
    mem: u64,
    disk: f64,
}

#[derive(Default)]
pub struct Tracker {
    live: HashMap<String, Live>,
}

pub fn in_game_folder(exe: &str) -> bool {
    let e = exe.to_lowercase().replace('/', "\\");
    let file = e.rsplit('\\').next().unwrap_or_default();
    ["\\steamapps\\common\\", "\\epic games\\", "\\riot games\\", "\\gog galaxy\\games\\", "\\xboxgames\\", "\\ea games\\", "\\ubisoft game launcher\\games\\", "\\battle.net\\games\\"].iter().any(|f| e.contains(f))
        && !["launcher", "crash", "helper", "anticheat", "redist", "installer", "overlay", "riotclient"].iter().any(|w| file.contains(w))
}

impl Live {
    /// Worth a place on the line: used by a person, or busy enough to matter.
    fn matters(&self) -> bool {
        let avg = self.cpu / self.n.max(1) as f64;
        self.front >= 15 || (avg >= 3.0 && self.last - self.start >= 60) || self.mem >= 2_000_000_000
    }

    fn run(&self) -> Run {
        Run {
            start: self.start,
            end: self.last,
            name: self.name.clone(),
            exe: self.exe.clone(),
            title: None,
            company: None,
            front: self.front,
            cpu: (self.cpu / self.n.max(1) as f64 * 10.0).round() / 10.0,
            mem: (self.mem / 1_048_576) as i64,
            disk: (self.disk / 1_048_576.0) as i64,
            game: in_game_folder(&self.exe) || self.full >= 120,
        }
    }
}

impl Tracker {
    /// One look at the processes. `front` is the process in front, `full` that it fills the screen as a
    /// game does. Returns the runs that ended.
    pub fn look(&mut self, samples: &[Sample], front: Option<u32>, full: bool, at: i64) -> Vec<Run> {
        struct Sum<'a> {
            cpu: f64,
            mem: u64,
            disk: f64,
            front: bool,
            one: &'a Sample,
        }
        // A program is one thing however many processes it runs as.
        let mut now: HashMap<String, Sum> = HashMap::new();
        for s in samples {
            let Some(exe) = s.exe.as_ref() else { continue };
            if SHELL.contains(&s.name.to_lowercase().as_str()) {
                continue;
            }
            let e = now.entry(exe.to_string_lossy().to_lowercase()).or_insert(Sum { cpu: 0.0, mem: 0, disk: 0.0, front: false, one: s });
            e.cpu += s.cpu as f64;
            e.mem += s.memory;
            e.disk += s.disk as f64;
            e.front |= front == Some(s.pid);
        }
        for (key, sum) in now {
            let l = self.live.entry(key).or_insert_with(|| Live {
                name: sum.one.name.clone(),
                exe: sum.one.exe.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                start: at,
                last: at,
                ..Default::default()
            });
            // A long gap is the computer having slept: that time did not pass for the program.
            let passed = (at - l.last).clamp(0, GONE);
            l.last = at;
            l.n += 1;
            l.cpu += sum.cpu;
            l.mem = l.mem.max(sum.mem);
            l.disk += sum.disk * passed as f64;
            if sum.front {
                l.front += passed;
                if full {
                    l.full += passed;
                }
            }
        }
        let mut ended = Vec::new();
        self.live.retain(|_, l| {
            let alive = at - l.last <= GONE;
            if !alive && l.matters() {
                ended.push(l.run());
            }
            alive
        });
        ended
    }

    /// Runs still going that are worth keeping, so a crash does not lose them.
    pub fn going(&self) -> Vec<Run> {
        self.live.values().filter(|l| l.matters()).map(Live::run).collect()
    }
}

static TRACKER: Mutex<Option<Tracker>> = Mutex::new(None);

pub fn with<T>(f: impl FnOnce(&mut Tracker) -> T) -> T {
    f(TRACKER.lock().unwrap().get_or_insert_with(Tracker::default))
}

pub fn front() -> Option<u32> {
    // SAFETY: plain queries; the pid is written to a local.
    unsafe {
        let w = GetForegroundWindow();
        if w.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(w, Some(&mut pid));
        (pid != 0).then_some(pid)
    }
}

pub fn save(db: &Connection, runs: &[Run]) -> rusqlite::Result<()> {
    let tx = db.unchecked_transaction()?;
    for r in runs {
        let known = tx.execute(
            "UPDATE runs SET end = ?3, front = ?4, cpu = ?5, mem = ?6, disk = ?7, game = ?8 WHERE exe = ?1 AND start = ?2",
            params![r.exe, r.start, r.end, r.front, r.cpu, r.mem, r.disk, r.game],
        )?;
        if known == 0 {
            let f = crate::startup::fileinfo::inspect(Path::new(&r.exe), false);
            tx.execute(
                "INSERT INTO runs (start, end, name, exe, title, company, front, cpu, mem, disk, game) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![r.start, r.end, r.name, r.exe, f.description, f.company, r.front, r.cpu, r.mem, r.disk, r.game],
            )?;
        }
    }
    tx.commit()
}

pub fn load(db: &Connection, from: i64, to: i64) -> rusqlite::Result<Vec<Run>> {
    db.prepare("SELECT start, end, name, exe, title, company, front, cpu, mem, disk, game FROM runs WHERE end >= ?1 AND start < ?2 ORDER BY start")?
        .query_map([from, to], |r| {
            Ok(Run {
                start: r.get(0)?,
                end: r.get(1)?,
                name: r.get(2)?,
                exe: r.get(3)?,
                title: r.get(4)?,
                company: r.get(5)?,
                front: r.get(6)?,
                cpu: r.get(7)?,
                mem: r.get(8)?,
                disk: r.get(9)?,
                game: r.get(10)?,
            })
        })?
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(pid: u32, name: &str, cpu: f32) -> Sample {
        Sample { pid, parent: None, name: name.into(), exe: Some(format!("C:\\Apps\\{name}").into()), cmd: String::new(), start: 0, cpu, memory: 100 << 20, disk: 0, session: Some(1) }
    }

    #[test]
    fn a_used_program_becomes_a_run() {
        let mut t = Tracker::default();
        let list = [s(1, "editor.exe", 1.0), s(2, "editor.exe", 1.0), s(3, "idle.exe", 0.0)];
        for i in 0..13 {
            assert!(t.look(&list, Some(2), false, i * EVERY).is_empty());
        }
        assert_eq!(t.going().len(), 1, "the idle one is not worth a place");
        let ended = t.look(&[], None, false, 60 + GONE + 5);
        assert_eq!(ended.len(), 1);
        assert_eq!((ended[0].name.as_str(), ended[0].start, ended[0].end, ended[0].cpu, ended[0].front, ended[0].game), ("editor.exe", 0, 60, 2.0, 60, false));
    }

    #[test]
    fn sleep_is_not_work() {
        let mut t = Tracker::default();
        let list = [s(1, "editor.exe", 5.0)];
        t.look(&list, Some(1), false, 0);
        t.look(&list, Some(1), false, 8 * 3600);
        assert!(t.going()[0].front <= GONE);
    }

    #[test]
    fn games_are_known_by_folder_or_by_filling_the_screen() {
        assert!(in_game_folder(r"D:\SteamLibrary\steamapps\common\Game\Game-Win64.exe"));
        assert!(!in_game_folder(r"C:\Program Files (x86)\Epic Games\Launcher\EpicGamesLauncher.exe"));
        assert!(!in_game_folder(r"C:\Windows\notepad.exe"));
        let mut t = Tracker::default();
        for i in 0..40 {
            t.look(&[s(1, "own.exe", 20.0)], Some(1), true, i * EVERY);
        }
        assert!(t.going()[0].game);
    }
}

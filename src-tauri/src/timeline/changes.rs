//! What is on the computer now, compared with the last look: programs, startup, open ports.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::params;
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};

use super::{Event, Timeline};

const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

#[derive(Clone, Debug, PartialEq)]
pub struct Program {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    /// "20261120" as the installer wrote it.
    pub date: Option<String>,
}

/// What "Installed apps" lists: no updates, no hidden parts.
pub fn programs() -> Vec<Program> {
    let views = [(HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY), (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY), (HKEY_CURRENT_USER, 0)];
    let mut out: Vec<Program> = Vec::new();
    for (i, (hive, view)) in views.into_iter().enumerate() {
        let Ok(list) = RegKey::predef(hive).open_subkey_with_flags(UNINSTALL, KEY_READ | view) else { continue };
        for id in list.enum_keys().flatten() {
            let Ok(k) = list.open_subkey_with_flags(&id, KEY_READ | view) else { continue };
            let text = |n: &str| k.get_value::<String, _>(n).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            let Some(name) = text("DisplayName") else { continue };
            if k.get_value::<u32, _>("SystemComponent").unwrap_or(0) == 1 || text("ParentKeyName").is_some() {
                continue;
            }
            let version = text("DisplayVersion");
            // The same program often registers twice.
            if out.iter().any(|p| p.name == name && p.version == version) {
                continue;
            }
            out.push(Program { id: format!("{i}:{id}"), name, version, date: text("InstallDate") });
        }
    }
    out
}

/// (id, name, value)
pub type Item = (String, String, Option<String>);
type Before = HashMap<String, (String, Option<String>)>;

/// The difference between two looks.
pub fn diff(kind: &str, before: &Before, after: &[Item]) -> Vec<Event> {
    let mut out = Vec::new();
    for (id, name, value) in after {
        match before.get(id) {
            None => out.push(Event::seen(kind, "added", name, None, value.clone())),
            Some((_, was)) if was != value => out.push(Event::seen(kind, "changed", name, was.clone(), value.clone())),
            _ => {}
        }
    }
    let ids: HashSet<&str> = after.iter().map(|x| x.0.as_str()).collect();
    for (id, (name, was)) in before {
        if ids.contains(id.as_str()) {
            continue;
        }
        // An installer that registers itself under a new id on every update is one change, not two.
        match out.iter().position(|e| e.action == "added" && e.name == *name) {
            Some(i) => {
                let value = out[i].now.clone();
                out[i] = Event::seen(kind, "changed", name, was.clone(), value);
            }
            None => out.push(Event::seen(kind, "removed", name, was.clone(), None)),
        }
    }
    out.retain(|e| e.action != "changed" || e.was != e.now);
    out
}

/// A look that lost more than half of what was there failed to read it; nothing is concluded.
fn believable(before: usize, after: usize) -> bool {
    before < 6 || after * 2 >= before
}

fn present(line: &Timeline, kind: &str) -> Before {
    line.with(|db| {
        let mut q = db.prepare("SELECT id, name, value FROM present WHERE kind = ?1")?;
        q.query_map([kind], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?.collect()
    })
    .unwrap_or_default()
}

pub fn compare(line: &Timeline, kind: &str, after: &[Item]) {
    let before = present(line, kind);
    let known = line.kv(&format!("looked:{kind}")).is_some();
    if known {
        if !believable(before.len(), after.len()) {
            crate::errlog::write("timeline", &format!("{kind}: {} items, {} before; look ignored", after.len(), before.len()));
            return;
        }
        line.add(&diff(kind, &before, after));
    }
    let same = known && before.len() == after.len() && after.iter().all(|(id, n, v)| before.get(id).is_some_and(|b| b.0 == *n && b.1 == *v));
    if same {
        return;
    }
    let _ = line.with(|db| {
        let tx = db.unchecked_transaction()?;
        tx.execute("DELETE FROM present WHERE kind = ?1", [kind])?;
        for (id, name, value) in after {
            tx.execute("INSERT OR REPLACE INTO present VALUES (?1, ?2, ?3, ?4)", params![kind, id, name, value])?;
        }
        tx.commit()
    });
    line.set_kv(&format!("looked:{kind}"), "1");
}

/// Programs come and go through the day, so an open port is news only the first time it is seen.
pub fn first_time(line: &Timeline, kind: &str, items: &[Item]) {
    let known = line.kv(&format!("looked:{kind}")).is_some();
    let seen = present(line, kind);
    for (id, name, value) in items.iter().filter(|p| !seen.contains_key(&p.0)) {
        if known {
            line.add(&[Event::seen(kind, "added", name, None, value.clone())]);
        }
        let _ = line.with(|db| db.execute("INSERT OR IGNORE INTO present VALUES (?1, ?2, ?3, ?4)", params![kind, id, name, value]));
    }
    line.set_kv(&format!("looked:{kind}"), "1");
}

pub fn look(line: &Timeline, windows: &Path) {
    let programs: Vec<Item> = programs().into_iter().map(|p| (p.id, p.name, p.version)).collect();
    compare(line, "program", &programs);
    let startup: Vec<Item> = crate::startup::watch_list(windows).into_iter().map(|(id, name)| (id, name, None)).collect();
    compare(line, "startup", &startup);
    // High ports are handed out at random and say nothing.
    let ports: Vec<Item> = crate::network::exposed_listeners()
        .into_iter()
        .filter(|(port, _, _, windows)| *port < 49_152 && !windows)
        .map(|(port, name, _, _)| (format!("{port}:{name}"), name, Some(port.to_string())))
        .collect();
    first_time(line, "port", &ports);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(v: &[(&str, &str, &str)]) -> Before {
        v.iter().map(|(i, n, x)| (i.to_string(), (n.to_string(), Some(x.to_string())))).collect()
    }
    fn items(v: &[(&str, &str, &str)]) -> Vec<Item> {
        v.iter().map(|(i, n, x)| (i.to_string(), n.to_string(), Some(x.to_string()))).collect()
    }
    fn short(v: Vec<Event>) -> Vec<String> {
        let mut s: Vec<String> = v.into_iter().map(|e| format!("{} {} {}>{}", e.action, e.name, e.was.unwrap_or_default(), e.now.unwrap_or_default())).collect();
        s.sort();
        s
    }

    #[test]
    fn additions_removals_and_updates() {
        let before = map(&[("a", "Alpha", "1"), ("b", "Beta", "1"), ("x{1}", "Moves", "1")]);
        let after = items(&[("a", "Alpha", "2"), ("c", "Gamma", "5"), ("x{2}", "Moves", "2")]);
        assert_eq!(short(diff("program", &before, &after)), vec!["added Gamma >5", "changed Alpha 1>2", "changed Moves 1>2", "removed Beta 1>"]);
    }

    #[test]
    fn the_first_look_only_remembers_and_a_failed_one_is_ignored() {
        let line = super::super::tests::memory();
        let full: Vec<Item> = (0..20).map(|i| (i.to_string(), format!("P{i}"), None)).collect();
        compare(&line, "program", &full);
        assert!(line.events(0, i64::MAX).is_empty());
        compare(&line, "program", &full[..3]);
        assert!(line.events(0, i64::MAX).is_empty());
        compare(&line, "program", &full[..19]);
        assert_eq!(line.events(0, i64::MAX).len(), 1);
    }

    #[test]
    fn a_port_is_news_once() {
        let line = super::super::tests::memory();
        let p = |id: &str| (id.to_string(), id.to_string(), None);
        first_time(&line, "port", &[p("1")]);
        first_time(&line, "port", &[]);
        first_time(&line, "port", &[p("1"), p("2")]);
        assert_eq!(line.events(0, i64::MAX).iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["2"]);
    }
}

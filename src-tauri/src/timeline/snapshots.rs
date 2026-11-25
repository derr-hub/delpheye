//! Control states: exactly what was on the computer at one moment. One is taken every week, and
//! whenever the user asks.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{DAY, Timeline};

const EVERY: i64 = 7 * DAY;
const KEEP_AUTO: i64 = 60;

/// (kind, id, name, value)
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Row(pub String, pub String, pub String, pub Option<String>);

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: i64,
    pub t: i64,
    pub name: String,
    pub auto: bool,
    /// How many of each kind it holds.
    pub counts: Vec<(String, i64)>,
}

pub fn present(line: &Timeline) -> Vec<Row> {
    line.with(|db| db.prepare("SELECT kind, id, name, value FROM present ORDER BY kind, name")?.query_map([], |r| Ok(Row(r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect()).unwrap_or_default()
}

pub fn make(line: &Timeline, at: i64, name: &str, auto: bool) -> rusqlite::Result<()> {
    // Ports seen once are not "there now": only programs and startup make a state.
    let rows: Vec<Row> = present(line).into_iter().filter(|r| r.0 != "port").collect();
    let data = serde_json::to_string(&rows).unwrap_or_else(|_| "[]".into());
    line.with(|db| {
        db.execute("INSERT INTO snapshots (t, name, auto, data) VALUES (?1, ?2, ?3, ?4)", params![at, name, auto, data])?;
        db.execute("DELETE FROM snapshots WHERE auto = 1 AND id NOT IN (SELECT id FROM snapshots WHERE auto = 1 ORDER BY t DESC LIMIT ?1)", [KEEP_AUTO])?;
        Ok(())
    })
}

/// The weekly one, when it is due and there is something to keep.
pub fn keep(line: &Timeline, at: i64) {
    let last: Option<i64> = line.with(|db| db.query_row("SELECT MAX(t) FROM snapshots WHERE auto = 1", [], |r| r.get(0))).unwrap_or(None);
    if last.is_some_and(|t| at - t < EVERY) || present(line).is_empty() {
        return;
    }
    if let Err(e) = make(line, at, "", true) {
        crate::errlog::write("timeline", &format!("snapshot: {e}"));
    }
}

pub fn list(line: &Timeline) -> Vec<Snapshot> {
    line.with(|db| {
        db.prepare("SELECT id, t, name, auto, data FROM snapshots ORDER BY t DESC")?
            .query_map([], |r| {
                let rows: Vec<Row> = serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default();
                let mut counts: Vec<(String, i64)> = Vec::new();
                for row in rows {
                    match counts.iter_mut().find(|c| c.0 == row.0) {
                        Some(c) => c.1 += 1,
                        None => counts.push((row.0, 1)),
                    }
                }
                Ok(Snapshot { id: r.get(0)?, t: r.get(1)?, name: r.get(2)?, auto: r.get(3)?, counts })
            })?
            .collect()
    })
    .unwrap_or_default()
}

pub fn get(line: &Timeline, id: i64) -> Option<Vec<Row>> {
    let data: Option<String> = line.with(|db| db.query_row("SELECT data FROM snapshots WHERE id = ?1", [id], |r| r.get(0)).optional()).ok()?;
    serde_json::from_str(&data?).ok()
}

pub fn delete(line: &Timeline, id: i64) -> rusqlite::Result<usize> {
    line.with(|db| db.execute("DELETE FROM snapshots WHERE id = ?1", [id]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snapshot_keeps_what_was_there() {
        let line = super::super::tests::memory();
        keep(&line, 1000);
        assert!(list(&line).is_empty(), "nothing to keep yet");
        super::super::changes::compare(&line, "program", &[("1".into(), "Alpha".into(), Some("1.0".into()))]);
        keep(&line, 1000);
        keep(&line, 1000 + DAY);
        let l = list(&line);
        assert_eq!((l.len(), l[0].auto, l[0].counts.clone()), (1, true, vec![("program".to_string(), 1)]));
        super::super::changes::compare(&line, "program", &[]);
        make(&line, 5000, "mine", false).unwrap();
        assert_eq!(get(&line, l[0].id).unwrap()[0].2, "Alpha");
        assert_eq!(list(&line).len(), 2);
        delete(&line, l[0].id).unwrap();
        assert_eq!(list(&line)[0].name, "mine");
    }

    #[test]
    fn automatic_ones_do_not_pile_up() {
        let line = super::super::tests::memory();
        super::super::changes::compare(&line, "program", &[("1".into(), "Alpha".into(), None)]);
        for i in 0..80 {
            keep(&line, i * EVERY);
        }
        make(&line, 1, "mine", false).unwrap();
        assert_eq!(list(&line).len(), KEEP_AUTO as usize + 1);
    }
}

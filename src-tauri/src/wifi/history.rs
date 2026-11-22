//! The air over days: every 15 minutes, while DelphEye runs and Wi-Fi is on, a short record of how
//! loud each channel was and how the user's own network did. Kept for 60 days.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::journal::Journal;

const EVERY_SECS: u64 = 15 * 60;
const KEEP_DAYS: i64 = 60;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub band: String,
    pub channel: u32,
    pub interference: f32,
    pub networks: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// Unix seconds.
    #[serde(default)]
    pub at: i64,
    pub total: u32,
    pub per_band: Vec<(String, u32)>,
    pub own_band: Option<String>,
    pub own_channel: Option<u32>,
    pub own_rssi: Option<i32>,
    pub own_interference: Option<f32>,
    pub channels: Vec<Channel>,
}

pub fn record(snap: &super::Snapshot) -> Option<Record> {
    let a = snap.analysis.as_ref()?;
    Some(Record {
        at: snap.at / 1000,
        total: a.total,
        per_band: a.bands.iter().map(|b| (b.band.to_string(), b.networks)).collect(),
        own_band: a.own.as_ref().map(|o| o.band.to_string()),
        own_channel: a.own.as_ref().map(|o| o.channel),
        own_rssi: a.own.as_ref().map(|o| o.rssi),
        own_interference: a.own.as_ref().map(|o| o.interference),
        channels: a
            .bands
            .iter()
            .flat_map(|b| b.candidates.iter().map(move |c| Channel { band: b.band.to_string(), channel: c.channel, interference: c.interference, networks: c.networks }))
            .collect(),
    })
}

fn save(journal: &Journal, r: &Record) {
    let _ = journal.with(|db| {
        db.execute("INSERT INTO wifi_history (at, data) VALUES (?1, ?2)", params![r.at, serde_json::to_string(r).unwrap_or_default()])?;
        db.execute("DELETE FROM wifi_history WHERE at < ?1", params![r.at - KEEP_DAYS * 86_400])?;
        Ok(())
    });
}

/// Samples the air in the background for the life of the app.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        // Let the app settle first.
        std::thread::sleep(std::time::Duration::from_secs(90));
        loop {
            let snap = super::snapshot(true);
            if snap.state == "ok" {
                if let Some(r) = record(&snap) {
                    save(&app.state::<Journal>(), &r);
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(EVERY_SECS));
        }
    });
}

/// Records from the last `days` days, oldest first.
#[tauri::command]
pub async fn wifi_history(app: AppHandle, days: u32) -> Result<Vec<Record>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) - days as i64 * 86_400;
        app.state::<Journal>()
            .with(|db| {
                let mut stmt = db.prepare("SELECT at, data FROM wifi_history WHERE at >= ?1 ORDER BY at")?;
                let rows = stmt.query_map(params![since], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
                Ok(rows
                    .filter_map(|r| r.ok())
                    .filter_map(|(at, data)| serde_json::from_str::<Record>(&data).ok().map(|mut x| {
                        x.at = at;
                        x
                    }))
                    .collect())
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_round_trip_through_the_journal() {
        let journal = Journal::in_memory();
        let r = Record {
            at: 1_000_000,
            total: 3,
            per_band: vec![("5".into(), 3)],
            own_band: Some("5".into()),
            own_channel: Some(100),
            own_rssi: Some(-60),
            own_interference: Some(-100.0),
            channels: vec![Channel { band: "5".into(), channel: 36, interference: -80.0, networks: 2 }],
        };
        save(&journal, &r);
        let back: Vec<Record> = journal
            .with(|db| {
                let mut s = db.prepare("SELECT data FROM wifi_history")?;
                let v = s.query_map([], |x| x.get::<_, String>(0))?.filter_map(|x| x.ok()).filter_map(|d| serde_json::from_str(&d).ok()).collect();
                Ok(v)
            })
            .unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].own_channel, Some(100));
    }
}

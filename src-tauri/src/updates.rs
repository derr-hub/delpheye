//! Program updates through winget, Windows' own package manager: which installed programs have
//! a newer version, and installing it — one, or all in turn.
//!
//! winget prints tables, not data. They are read by the column positions the header line gives,
//! which works whatever language the headers are in.

use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub name: String,
    pub id: String,
    pub version: String,
    pub available: String,
    pub source: String,
    /// winget lists it, but will only upgrade it when asked for by name (pinned or similar).
    pub explicit: bool,
}

/// Reads every table winget printed. Rows end at the first empty line after a table.
pub fn parse(output: &str) -> Vec<Package> {
    let lines: Vec<&str> = output.lines().map(|l| l.trim_end_matches('\r')).collect();
    let mut out = Vec::new();
    let mut tables = 0;
    let mut i = 0;
    while i < lines.len() {
        // A table is a header line followed by a line of dashes.
        let is_rule = |l: &str| l.len() > 10 && l.chars().all(|c| c == '-');
        if i + 1 < lines.len() && is_rule(lines[i + 1].trim()) && !lines[i].trim().is_empty() {
            let header: Vec<char> = lines[i].chars().collect();
            // A column starts where a non-space follows a space (or the line starts).
            let starts: Vec<usize> = (0..header.len()).filter(|&k| header[k] != ' ' && (k == 0 || header[k - 1] == ' ')).collect();
            tables += 1;
            let mut j = i + 2;
            while j < lines.len() && !lines[j].trim().is_empty() {
                let row: Vec<char> = lines[j].chars().collect();
                let cell = |n: usize| -> String {
                    let from = starts.get(n).copied().unwrap_or(row.len()).min(row.len());
                    let to = starts.get(n + 1).copied().unwrap_or(row.len()).min(row.len());
                    row[from..to].iter().collect::<String>().trim().to_string()
                };
                if starts.len() >= 4 {
                    let pkg = Package {
                        name: cell(0),
                        id: cell(1),
                        version: cell(2),
                        available: cell(3),
                        source: if starts.len() >= 5 { cell(4) } else { String::new() },
                        explicit: tables > 1,
                    };
                    // Summary lines ("12 upgrades available.") have no id-shaped second column.
                    if !pkg.id.is_empty() && !pkg.id.contains(' ') && !pkg.available.is_empty() {
                        out.push(pkg);
                    }
                }
                j += 1;
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

fn winget(args: &[&str]) -> Result<(i32, String), String> {
    let output = Command::new("winget")
        .args(args)
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "no-winget".to_string() } else { e.to_string() })?;
    Ok((output.status.code().unwrap_or(-1), String::from_utf8_lossy(&output.stdout).into_owned()))
}

#[derive(Default)]
pub struct UpdatesState {
    running: AtomicBool,
    cancel: AtomicBool,
    last: Mutex<Vec<Package>>,
}

/// Every installed program winget knows a newer version of. Errors: "no-winget".
#[tauri::command]
pub async fn updates_list(state: State<'_, UpdatesState>) -> Result<Vec<Package>, String> {
    let (_, text) = tauri::async_runtime::spawn_blocking(|| winget(&["upgrade", "--include-unknown", "--accept-source-agreements", "--disable-interactivity"]))
        .await
        .map_err(|e| e.to_string())??;
    let list = parse(&text);
    *state.last.lock().unwrap() = list.clone();
    Ok(list)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub id: String,
    pub ok: bool,
    /// winget's exit code, for the ones that failed.
    pub code: i32,
}

/// What a winget exit code means, for the UI.
pub fn reason(code: i32) -> &'static str {
    match code as u32 {
        0 => "ok",
        0x8A15_002B => "nothing-new",
        0x8A15_0011 | 0x8A15_0010 => "not-found",
        0x8A15_0101 | 0x8A15_0102 => "in-use",
        0x8A15_0103 | 0x8A15_0107 => "reboot",
        0x8A15_0104 | 0x8A15_0105 => "no-space",
        0x8A15_0109 => "cancelled",
        0x8A15_0061 | 0x8A15_0056 => "different-installer",
        0x8A15_0019 | 0x8A15_0007 => "admin-declined",
        0x8A15_0068 | 0x8A15_0069 => "network",
        _ => "failed",
    }
}

/// Installs the newer version of each id in turn, reporting `updates:progress` before and after
/// each. Installers that need administrator rights ask through Windows' own prompt.
#[tauri::command]
pub async fn updates_install(app: AppHandle, state: State<'_, UpdatesState>, ids: Vec<String>) -> Result<Vec<Outcome>, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    // Only ids from the last listing: never pass anything else to winget.
    let known: Vec<String> = state.last.lock().unwrap().iter().map(|p| p.id.clone()).collect();
    let ids: Vec<String> = ids.into_iter().filter(|id| known.contains(id)).collect();
    let mut outcomes = Vec::new();
    for id in ids {
        if state.cancel.load(Ordering::SeqCst) {
            break;
        }
        let _ = app.emit("updates:progress", serde_json::json!({ "id": id, "state": "running" }));
        let id_for_run = id.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            winget(&[
                "upgrade", "--id", &id_for_run, "--exact", "--silent", "--include-unknown",
                "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
            ])
        })
        .await
        .map_err(|e| e.to_string())?;
        let code = result.map(|(code, _)| code).unwrap_or(-1);
        let ok = code == 0;
        let _ = app.emit("updates:progress", serde_json::json!({ "id": id, "state": if ok { "done" } else { "failed" }, "code": code, "reason": reason(code) }));
        if ok {
            crate::errlog::write("updates", &format!("updated {id}"));
        } else {
            crate::errlog::write("updates", &format!("could not update {id}: 0x{:08X}", code as u32));
        }
        outcomes.push(Outcome { id, ok, code });
    }
    state.running.store(false, Ordering::SeqCst);
    Ok(outcomes)
}

/// Stops after the program being updated now.
#[tauri::command]
pub fn updates_cancel(state: State<'_, UpdatesState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "   -    \\    |  \r
Name                                                         Id                                    Version          Available        Source\r
-------------------------------------------------------------------------------------------------------------------------------------------\r
7-Zip 26.00 (x64)                                            7zip.7zip                             26.00            26.06            winget\r
Microsoft Visual C++ v14 Redistributable (x64) - 14.51.36247 Microsoft.VCRedist.2015+.x64          14.51.36247.0    14.52.37029.0    winget\r
Discord                                                      Discord.Discord                       Unknown          1.0.9200         winget\r
13 upgrades available.\r
\r
The following packages have an upgrade available, but require explicit targeting for upgrade:\r
Ім'я         Ідентифікатор     Версія  Доступно Джерело\r
------------------------------------------------------\r
Spotify      Spotify.Spotify   1.2.3   1.2.9    winget\r
";

    #[test]
    fn tables_are_read_by_column_in_any_language() {
        let list = parse(SAMPLE);
        assert_eq!(list.len(), 4, "{list:#?}");
        assert_eq!(list[0], Package { name: "7-Zip 26.00 (x64)".into(), id: "7zip.7zip".into(), version: "26.00".into(), available: "26.06".into(), source: "winget".into(), explicit: false });
        assert_eq!(list[1].name, "Microsoft Visual C++ v14 Redistributable (x64) - 14.51.36247");
        assert_eq!(list[1].id, "Microsoft.VCRedist.2015+.x64");
        assert_eq!((list[2].version.as_str(), list[2].available.as_str()), ("Unknown", "1.0.9200"));
        assert_eq!((list[3].id.as_str(), list[3].explicit), ("Spotify.Spotify", true));
    }

    #[test]
    fn nothing_to_update_is_an_empty_list() {
        assert!(parse("No installed package found matching input criteria.\r\n").is_empty());
    }

    #[test]
    fn exit_codes_have_reasons() {
        assert_eq!(reason(0), "ok");
        assert_eq!(reason(0x8A15_002Bu32 as i32), "nothing-new");
        assert_eq!(reason(0x8A15_0101u32 as i32), "in-use");
        assert_eq!(reason(12345), "failed");
    }
}

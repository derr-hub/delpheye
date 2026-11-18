//! A small error log, so that when something goes wrong on someone else's computer there is a
//! record of what happened: Rust panics, errors the interface reports, and notable failures.
//!
//! It lives in `%LOCALAPPDATA%\com.delpheye.app\logs\delpheye.log` and is kept small: when it passes
//! 1 MB the old one becomes `delpheye.old.log`.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const LIMIT: u64 = 1024 * 1024;
static LOCK: Mutex<()> = Mutex::new(());

pub fn folder() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("com.delpheye.app").join("logs"))
}

fn timestamp() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    // Days to a civil date (Howard Hinnant's algorithm), UTC.
    let days = (secs / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let t = secs % 86_400;
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z", t / 3600, t / 60 % 60, t % 60)
}

/// Appends one line to the log. Never fails loudly: a broken log must not break the app.
pub fn write(source: &str, message: &str) {
    let Some(dir) = folder() else { return };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let file = dir.join("delpheye.log");
    if file.metadata().is_ok_and(|m| m.len() > LIMIT) {
        let _ = std::fs::rename(&file, dir.join("delpheye.old.log"));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&file) {
        let line = message.replace('\n', " | ");
        let _ = writeln!(f, "{} [{}] v{} {}", timestamp(), source, env!("CARGO_PKG_VERSION"), line.chars().take(4000).collect::<String>());
    }
}

/// Records panics (with where they happened) before the default handler runs.
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let place = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let what = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_default();
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        write("panic", &format!("thread '{thread}' at {place}: {what}"));
        default(info);
    }));
}

/// Errors the interface caught (uncaught exceptions, failed commands).
#[tauri::command]
pub fn log_error(message: String) {
    write("ui", &message);
}

/// Opens the log folder in Explorer.
#[tauri::command]
pub fn open_log_folder() -> Result<(), String> {
    let dir = folder().ok_or("no folder")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer.exe").arg(&dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_look_right() {
        let ts = timestamp();
        assert_eq!(ts.len(), 20, "{ts}");
        assert!(ts.starts_with("20") && ts.ends_with('Z'));
    }
}

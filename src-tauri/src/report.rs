//! Help reports: one file with every check, made on a relative's computer and opened on the
//! helper's. The interface gathers the data and turns it into JSON; this module only writes and
//! reads the file, and only files with DelphEye's own extension, so it cannot be used to touch
//! anything else.

use std::path::Path;

const EXTENSION: &str = "delpheye";
/// Far more than any report needs; refuse anything bigger rather than load it into memory.
const LIMIT: usize = 20 * 1024 * 1024;

fn check(path: &Path) -> Result<(), String> {
    let ok = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION));
    if ok { Ok(()) } else { Err("not-a-report".into()) }
}

/// Saves a report where the user chose to.
#[tauri::command]
pub fn report_write(path: String, contents: String) -> Result<(), String> {
    let path = Path::new(&path);
    check(path)?;
    if contents.len() > LIMIT {
        return Err("too-big".into());
    }
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

/// Reads a report the user picked.
#[tauri::command]
pub fn report_read(path: String) -> Result<String, String> {
    let path = Path::new(&path);
    check(path)?;
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size as usize > LIMIT {
        return Err("too-big".into());
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_report_files_are_written_and_read() {
        let dir = std::env::temp_dir().join(format!("delpheye-report-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("Mama-laptop.DelphEye");
        report_write(good.display().to_string(), "{\"kind\":\"delpheye-report\"}".into()).unwrap();
        assert_eq!(report_read(good.display().to_string()).unwrap(), "{\"kind\":\"delpheye-report\"}");
        let bad = dir.join("notes.txt");
        assert_eq!(report_write(bad.display().to_string(), "x".into()), Err("not-a-report".to_string()));
        assert_eq!(report_read(r"C:\Windows\win.ini".into()), Err("not-a-report".to_string()));
        assert!(!bad.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

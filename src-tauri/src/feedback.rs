//! Feedback from inside the app: a message with photos or videos goes to the developer's Discord
//! channel through a webhook (a link that can only post to that one channel).
//!
//! The webhook is not in the source (the repository is public): release builds get it from the
//! `DELPHEYE_FEEDBACK_WEBHOOK` environment variable at build time; the same variable at run time
//! works too, for testing.

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

/// Discord's limit for one message's attachments on an ordinary server.
const MESSAGE_LIMIT: u64 = 10 * 1024 * 1024;
const MAX_FILES: usize = 10;

fn webhook() -> Option<String> {
    let url = option_env!("DELPHEYE_FEEDBACK_WEBHOOK").map(String::from).or_else(|| std::env::var("DELPHEYE_FEEDBACK_WEBHOOK").ok())?;
    url.starts_with("https://discord.com/api/webhooks/").then_some(url)
}

#[tauri::command]
pub fn feedback_available() -> bool {
    webhook().is_some()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picked {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub video: bool,
}

/// Names and sizes of the files the user picked, for the list under the message.
#[tauri::command]
pub fn feedback_files(paths: Vec<String>) -> Vec<Picked> {
    paths
        .into_iter()
        .filter_map(|p| {
            let size = std::fs::metadata(&p).ok()?.len();
            let name = Path::new(&p).file_name()?.to_string_lossy().into_owned();
            let video = content_type(&name).starts_with("video/");
            Some(Picked { path: p, name, size, video })
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feedback {
    pub text: String,
    #[serde(default)]
    pub contact: String,
    /// "idea", "bug", "other".
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub files: Vec<String>,
    /// Adds the version, Windows and the end of the error log.
    #[serde(default)]
    pub technical: bool,
}

fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "txt" | "log" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// Files into messages of at most `MESSAGE_LIMIT` bytes each. Errors on a file too big alone.
pub fn batches(sizes: &[(String, u64)]) -> Result<Vec<Vec<usize>>, String> {
    let mut out: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let mut used = 0u64;
    for (i, (name, size)) in sizes.iter().enumerate() {
        if *size > MESSAGE_LIMIT {
            return Err(format!("too-big:{name}"));
        }
        if !current.is_empty() && (used + size > MESSAGE_LIMIT || current.len() == MAX_FILES) {
            out.push(std::mem::take(&mut current));
            used = 0;
        }
        current.push(i);
        used += size;
    }
    if !current.is_empty() {
        out.push(current);
    }
    Ok(out)
}

fn log_tail() -> String {
    let Some(path) = crate::errlog::folder().map(|d| d.join("delpheye.log")) else { return String::new() };
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(40)..].join("\n")
}

fn windows_version() -> String {
    sysinfo::System::long_os_version().unwrap_or_default()
}

/// One multipart/form-data body: the JSON payload and the files.
fn multipart(payload: &serde_json::Value, files: &[(String, Vec<u8>)]) -> (String, Vec<u8>) {
    let boundary = format!("delpheye{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n{payload}\r\n").as_bytes());
    for (i, (name, data)) in files.iter().enumerate() {
        let safe: String = name.chars().filter(|c| !matches!(c, '"' | '\r' | '\n' | '\\')).collect();
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files[{i}]\"; filename=\"{safe}\"\r\nContent-Type: {}\r\n\r\n", content_type(&safe)).as_bytes());
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (boundary, body)
}

fn post(url: &str, payload: serde_json::Value, files: Vec<(String, Vec<u8>)>) -> Result<(), String> {
    let (boundary, body) = multipart(&payload, &files);
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(120))).http_status_as_error(false).build().into();
    let r = agent
        .post(url)
        .header("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
        .send(&body[..])
        .map_err(|e| format!("network: {e}"))?;
    match r.status().as_u16() {
        200..=299 => Ok(()),
        413 => Err("too-big".into()),
        429 => Err("too-often".into()),
        s => Err(format!("status {s}")),
    }
}

/// Sends the feedback; long attachments go in follow-up messages.
#[tauri::command]
pub async fn feedback_send(feedback: Feedback) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = webhook().ok_or("not-configured")?;
        let text = feedback.text.trim();
        if text.is_empty() && feedback.files.is_empty() {
            return Err("empty".into());
        }
        let mut sizes = Vec::new();
        for f in &feedback.files {
            let p = Path::new(f);
            let size = std::fs::metadata(p).map_err(|_| format!("missing:{f}"))?.len();
            sizes.push((p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into()), size));
        }
        let groups = batches(&sizes)?;
        let label = match feedback.kind.as_str() {
            "bug" => "🐞 Помилка",
            "idea" => "💡 Ідея",
            _ => "💬 Відгук",
        };
        let mut fields = vec![json!({ "name": "Версія", "value": env!("CARGO_PKG_VERSION"), "inline": true })];
        if !feedback.contact.trim().is_empty() {
            fields.push(json!({ "name": "Контакт", "value": feedback.contact.trim().chars().take(200).collect::<String>(), "inline": true }));
        }
        if feedback.technical {
            fields.push(json!({ "name": "Windows", "value": windows_version(), "inline": true }));
        }
        let mut description: String = text.chars().take(3900).collect();
        if feedback.technical {
            let tail = log_tail();
            if !tail.is_empty() {
                let tail: String = tail.chars().rev().take(1200).collect::<Vec<_>>().into_iter().rev().collect();
                description.push_str(&format!("\n\n```\n{tail}\n```"));
            }
        }
        let first = json!({
            "username": "DelphEye",
            "allowed_mentions": { "parse": [] },
            "embeds": [{ "title": label, "description": description, "color": 0x4cc2ff, "fields": fields }],
        });
        let read = |i: usize| -> Result<(String, Vec<u8>), String> {
            let mut data = Vec::new();
            std::fs::File::open(&feedback.files[i]).and_then(|mut f| f.read_to_end(&mut data)).map_err(|e| e.to_string())?;
            Ok((sizes[i].0.clone(), data))
        };
        if groups.is_empty() {
            return post(&url, first, Vec::new());
        }
        for (n, group) in groups.iter().enumerate() {
            let files = group.iter().map(|&i| read(i)).collect::<Result<Vec<_>, _>>()?;
            let payload = if n == 0 { first.clone() } else { json!({ "username": "DelphEye", "content": format!("{label} — продовження ({}/{})", n + 1, groups.len()), "allowed_mentions": { "parse": [] } }) };
            post(&url, payload, files)?;
        }
        crate::errlog::write("feedback", "sent");
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_split_into_messages() {
        let mb = 1024 * 1024;
        let sizes: Vec<(String, u64)> = [6, 3, 5, 9, 1].iter().map(|s| ("f".to_string(), s * mb)).collect();
        assert_eq!(batches(&sizes).unwrap(), vec![vec![0, 1], vec![2], vec![3, 4]]);
        assert!(batches(&[("big.mp4".into(), 11 * mb)]).unwrap_err().starts_with("too-big"));
        assert!(batches(&[]).unwrap().is_empty());
    }

    #[test]
    fn the_body_has_every_part() {
        let (b, body) = multipart(&json!({ "content": "hi" }), &[("a.png".into(), vec![1, 2, 3])]);
        let s = String::from_utf8_lossy(&body);
        assert!(s.contains("payload_json") && s.contains("files[0]") && s.contains("image/png") && s.ends_with(&format!("--{b}--\r\n")));
    }
}

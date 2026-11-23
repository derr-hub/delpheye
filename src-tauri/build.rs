fn main() {
    // The feedback webhook stays out of the (public) repository: it comes from the
    // DELPHEYE_FEEDBACK_WEBHOOK variable or from %USERPROFILE%\.delpheye\feedback-webhook.txt
    // on the machine that builds DelphEye. Without either, feedback is switched off.
    println!("cargo:rerun-if-env-changed=DELPHEYE_FEEDBACK_WEBHOOK");
    if std::env::var("DELPHEYE_FEEDBACK_WEBHOOK").is_err() {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let file = std::path::PathBuf::from(home).join(".delpheye").join("feedback-webhook.txt");
            println!("cargo:rerun-if-changed={}", file.display());
            if let Ok(url) = std::fs::read_to_string(&file) {
                let url = url.trim().trim_end_matches('\\');
                if url.starts_with("https://discord.com/api/webhooks/") {
                    println!("cargo:rustc-env=DELPHEYE_FEEDBACK_WEBHOOK={url}");
                }
            }
        }
    }
    tauri_build::build()
}

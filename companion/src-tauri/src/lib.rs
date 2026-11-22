//! DelphEye Companion: the phone half of DelphEye's Wi-Fi tools. It hears the Wi-Fi around (through
//! Android's WifiManager, in `WifiPlugin.kt`), and sends what it hears — with the compass heading and
//! steps the interface measures — to DelphEye on the computer, over the home network only.

use std::time::Duration;

use serde_json::Value;
use tauri::Manager;
#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

/// The Android side of the Wi-Fi plugin, kept to call it from commands.
struct Wifi<R: tauri::Runtime> {
    #[cfg(target_os = "android")]
    handle: PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _r: std::marker::PhantomData<R>,
}

fn wifi_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("wifi")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let state = Wifi { handle: _api.register_android_plugin("com.delpheye.companion", "WifiPlugin")? };
            #[cfg(not(target_os = "android"))]
            let state = Wifi::<R> { _r: std::marker::PhantomData };
            app.manage(state);
            Ok(())
        })
        .build()
}

/// The latest Wi-Fi scan results and the current connection. Off Android: an empty answer.
#[tauri::command]
async fn wifi_scan(app: tauri::AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let wifi = app.state::<Wifi<tauri::Wry>>();
        return wifi.handle.run_mobile_plugin::<Value>("scan", ()).map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(serde_json::json!({ "results": [], "started": false }))
    }
}

/// Asks Android for the location permission, which it requires before it shares Wi-Fi scan results.
#[tauri::command]
async fn wifi_permission(app: tauri::AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let wifi = app.state::<Wifi<tauri::Wry>>();
        return wifi.handle.run_mobile_plugin::<Value>("requestPermissions", serde_json::json!({ "permissions": ["location"] })).map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(serde_json::json!({ "location": "granted" }))
    }
}

/// One request to DelphEye on the computer. Done here rather than in the web view, which Android
/// would stop from talking plain HTTP to the home network.
#[tauri::command]
async fn call(url: String, body: Option<Value>) -> Result<Value, String> {
    // Only addresses on the home network: this is the only place the app sends anything.
    let host = url.trim_start_matches("http://").split(['/', ':']).next().unwrap_or_default().to_string();
    let ip: std::net::Ipv4Addr = host.parse().map_err(|_| "bad-host".to_string())?;
    if !(ip.is_private() || ip.is_link_local()) {
        return Err("not-home-network".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(4))).http_status_as_error(false).build().into();
        let mut r = match body {
            Some(b) => agent.post(&url).send_json(&b),
            None => agent.get(&url).call(),
        }
        .map_err(|e| format!("unreachable: {e}"))?;
        let status = r.status().as_u16();
        let v: Value = r.body_mut().read_json().unwrap_or(Value::Null);
        if status >= 400 {
            return Err(v["error"].as_str().unwrap_or("failed").to_string());
        }
        Ok(v)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_barcode_scanner::init())
        .plugin(wifi_plugin())
        .invoke_handler(tauri::generate_handler![wifi_scan, wifi_permission, call])
        .run(tauri::generate_context!())
        .expect("error while running DelphEye Companion");
}

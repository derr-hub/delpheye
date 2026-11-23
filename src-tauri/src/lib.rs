mod cleanup;
mod companion;
mod cpu;
mod disk;
mod errlog;
mod feedback;
mod history;
mod journal;
mod leftovers;
mod metrics;
mod monitor;
mod network;
mod overlay;
mod privacy;
mod processes;
mod report;
mod restore;
mod router;
mod security;
mod startup;
mod system;
mod updates;
mod watcher;
mod wifi;

use tauri::Manager;

/// Opens the main window from its configuration.
///
/// Debug builds started with `DELPHEYE_DEVTOOLS_PORT` expose the page to developer tools on
/// that port, so the app can be checked end to end — including when it runs as administrator,
/// where WebView2 ignores its own environment variables.
fn open_main_window(app: &tauri::App) -> tauri::Result<()> {
    let config = app.config().app.windows.iter().find(|w| w.label == "main").cloned().expect("main window in tauri.conf.json");
    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
    #[cfg(debug_assertions)]
    if let Some(port) = std::env::var("DELPHEYE_DEVTOOLS_PORT").ok().filter(|p| p.parse::<u16>().is_ok()) {
        // Replacing the browser arguments drops Tauri's defaults, so they are repeated here.
        builder = builder.additional_browser_args(&format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
        ));
    }
    // Windows 11 draws the Mica material (the desktop wallpaper, heavily blurred and tinted)
    // behind the window; the interface lets it show through the title bar and navigation.
    if system::supports_mica() {
        builder = builder
            .transparent(true)
            .background_color(tauri::utils::config::Color(0, 0, 0, 0))
            .effects(tauri::utils::config::WindowEffectsConfig { effects: vec![tauri::utils::WindowEffect::Mica], ..Default::default() });
    }
    let window = builder.build()?;
    system::set_mica(system::supports_mica() && window.is_visible().is_ok());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    errlog::install_panic_hook();
    errlog::write("app", "started");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, shortcut, event| overlay::on_shortcut(app, shortcut, event.state())).build())
        .manage(cleanup::CleanupState::default())
        .manage(disk::DiskState::default())
        .manage(leftovers::LeftoversState::default())
        .manage(startup::StartupState::default())
        .manage(monitor::MonitorState::default())
        .manage(security::SecurityState::default())
        .manage(updates::UpdatesState::default())
        .manage(router::RouterState::default())
        .manage(watcher::WatcherState::default())
        .manage(companion::CompanionState::default())
        .manage(overlay::OverlayState::default())
        .manage(std::sync::Arc::new(network::NetworkState::default()))
        .setup(|app| {
            open_main_window(app)?;
            app.manage(journal::Journal::open_for(app.handle()));
            privacy::start(app.handle().clone());
            wifi::start_history(app.handle().clone());
            watcher::start(app.handle().clone());
            watcher::tray(app)?;
            // Started with Windows: straight to the tray, no window.
            if std::env::args().any(|a| a == "--background") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            // Whatever has sat in quarantine for its full week is deleted for good.
            let handle = app.handle().clone();
            std::thread::spawn(move || leftovers::purge_expired(&handle.state::<journal::Journal>()));
            metrics::spawn(app.handle().clone());
            monitor::spawn(app.handle().clone(), &app.state::<monitor::MonitorState>());
            overlay::start(app);
            history::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            metrics::system_info,
            system::app_status,
            system::relaunch_elevated,
            overlay::overlay_settings,
            overlay::overlay_save,
            overlay::overlay_interactive,
            overlay::overlay_test,
            overlay::overlay_open_main,
            feedback::feedback_available,
            feedback::feedback_files,
            feedback::feedback_send,
            history::health_history,
            wifi::share::wifi_share,
            restore::restore_status,
            restore::restore_auto,
            restore::restore_create,
            restore::restore_before,
            restore::restore_open_settings,
            cleanup::cleanup_scan,
            cleanup::cleanup_cancel,
            cleanup::cleanup_run,
            journal::journal_list,
            disk::disk_drives,
            disk::disk_index,
            disk::disk_cancel,
            disk::disk_open,
            disk::disk_indexed,
            disk::disk_folder,
            disk::disk_largest,
            disk::disk_rings,
            disk::disk_search,
            disk::disk_duplicates,
            disk::disk_trash,
            leftovers::leftovers_scan,
            leftovers::leftovers_cancel,
            leftovers::leftovers_quarantine,
            leftovers::quarantine_list,
            leftovers::quarantine_act,
            startup::startup_list,
            startup::startup_set,
            startup::startup_remove,
            startup::startup_revert,
            monitor::monitor_status,
            monitor::monitor_history,
            monitor::health_quick,
            monitor::stability_run,
            monitor::stability_cancel,
            monitor::cooling_history,
            monitor::gpu_adapters,
            monitor::slowdown_check,
            processes::processes_list,
            network::network_snapshot,
            network::network_check,
            errlog::log_error,
            report::report_write,
            privacy::privacy_usage,
            router::router_find,
            router::router_connect,
            router::router_read,
            router::router_disconnect,
            router::router_apply,
            router::router_log,
            companion::companion_start,
            companion::companion_state,
            companion::companion_stop,
            watcher::watcher_settings,
            watcher::watcher_save,
            watcher::watcher_alerts,
            watcher::watcher_read_all,
            watcher::watcher_test,
            watcher::watcher_autostart,
            router::router_debug_hook,
            wifi::wifi_snapshot,
            wifi::wifi_link,
            wifi::wifi_quality,
            wifi::history::wifi_history,
            updates::updates_list,
            updates::updates_install,
            updates::updates_cancel,
            report::report_read,
            errlog::open_log_folder,
            processes::process_details,
            processes::process_icons,
            processes::process_end,
            security::security_scan,
            security::security_reputation,
            security::security_act,
        ])
        // Closing the window keeps DelphEye watching from the tray, unless the user turned that off.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && window.app_handle().state::<watcher::WatcherState>().settings.lock().unwrap().tray_on_close {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

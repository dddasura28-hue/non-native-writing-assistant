mod http_transport;
mod provider_settings;
mod secret_store;
mod windows;

#[cfg(target_os = "windows")]
use tauri::Manager;

#[cfg(target_os = "windows")]
mod global_shortcut;

fn main() {
    let builder = tauri::Builder::default().manage(windows::WindowsCaptureSequence::default());

    #[cfg(target_os = "windows")]
    let builder = builder
        .manage(global_shortcut::GlobalShortcutState::default())
        .plugin(global_shortcut::plugin())
        .setup(|app| {
            global_shortcut::register(app);
            Ok(())
        });

    builder
        .invoke_handler(tauri::generate_handler![
            secret_store::set_provider_secret,
            secret_store::get_provider_secret,
            secret_store::has_provider_secret,
            secret_store::delete_provider_secret,
            provider_settings::load_provider_settings,
            provider_settings::save_provider_settings,
            http_transport::send_provider_http_request,
            #[cfg(target_os = "windows")]
            global_shortcut::get_windows_global_shortcut_status,
        ])
        .on_window_event(|window, event| {
            #[cfg(target_os = "windows")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "global-assistant" {
                    api.prevent_close();
                    let _ = window.hide();
                } else if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run the desktop application");
}

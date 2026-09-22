mod http_transport;
mod provider_settings;
mod secret_store;
mod windows;

fn main() {
    tauri::Builder::default()
        .manage(windows::WindowsCaptureSequence::default())
        .invoke_handler(tauri::generate_handler![
            secret_store::set_provider_secret,
            secret_store::get_provider_secret,
            secret_store::has_provider_secret,
            secret_store::delete_provider_secret,
            provider_settings::load_provider_settings,
            provider_settings::save_provider_settings,
            http_transport::send_provider_http_request,
            windows::capture_active_windows_text_surface,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the desktop application");
}

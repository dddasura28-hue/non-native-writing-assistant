mod model;

#[cfg(target_os = "windows")]
mod uia;

use model::{unavailable, WindowsCaptureUnavailableReason, WindowsTextSurfaceCaptureResponse};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct WindowsCaptureSequence(AtomicU64);

impl WindowsCaptureSequence {
    fn next_token(&self) -> String {
        let value = self.0.fetch_add(1, Ordering::Relaxed) + 1;
        format!("windows-capture-{value}")
    }
}

#[tauri::command]
pub async fn capture_active_windows_text_surface(
    app: AppHandle,
) -> Result<WindowsTextSurfaceCaptureResponse, String> {
    let token = app.state::<WindowsCaptureSequence>().next_token();
    Ok(
        tauri::async_runtime::spawn_blocking(move || capture_on_platform(token))
            .await
            .unwrap_or_else(|_| unavailable(WindowsCaptureUnavailableReason::NativeUiaUnavailable)),
    )
}

#[cfg(target_os = "windows")]
fn capture_on_platform(token: String) -> WindowsTextSurfaceCaptureResponse {
    uia::capture_active_text_surface(token)
}

#[cfg(not(target_os = "windows"))]
fn capture_on_platform(_token: String) -> WindowsTextSurfaceCaptureResponse {
    unavailable(WindowsCaptureUnavailableReason::NativeUiaUnavailable)
}

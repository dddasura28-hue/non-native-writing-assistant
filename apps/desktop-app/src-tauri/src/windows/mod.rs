mod model;

#[cfg(target_os = "windows")]
mod uia;

use model::unavailable;
pub(crate) use model::{WindowsCaptureUnavailableReason, WindowsTextSurfaceCaptureResponse};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub struct WindowsCaptureSequence(AtomicU64);

impl WindowsCaptureSequence {
    fn next_token(&self) -> String {
        let value = self.0.fetch_add(1, Ordering::Relaxed) + 1;
        format!("windows-capture-{value}")
    }
}

pub fn capture_active_windows_text_surface_now(
    sequence: &WindowsCaptureSequence,
) -> WindowsTextSurfaceCaptureResponse {
    let token = sequence.next_token();
    std::thread::spawn(move || capture_on_platform(token))
        .join()
        .unwrap_or_else(|_| unavailable(WindowsCaptureUnavailableReason::NativeUiaUnavailable))
}

#[cfg(target_os = "windows")]
fn capture_on_platform(token: String) -> WindowsTextSurfaceCaptureResponse {
    uia::capture_active_text_surface(token)
}

#[cfg(not(target_os = "windows"))]
fn capture_on_platform(_token: String) -> WindowsTextSurfaceCaptureResponse {
    unavailable(WindowsCaptureUnavailableReason::NativeUiaUnavailable)
}

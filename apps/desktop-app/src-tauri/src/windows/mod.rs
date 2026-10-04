mod boundary;
pub mod geometry;
mod model;
#[cfg(test)]
mod tsf;

#[cfg(target_os = "windows")]
mod uia;

#[cfg(test)]
pub(crate) use model::build_capture;
use model::unavailable;
pub(crate) use model::{WindowsCaptureUnavailableReason, WindowsTextSurfaceCaptureResponse};

pub fn capture_active_windows_text_surface_now(
    invocation_id: u64,
    capture_token: String,
) -> WindowsTextSurfaceCaptureResponse {
    std::thread::spawn(move || capture_on_platform(invocation_id, capture_token))
        .join()
        .unwrap_or_else(|_| unavailable(WindowsCaptureUnavailableReason::NativeUiaUnavailable))
}

#[cfg(target_os = "windows")]
fn capture_on_platform(invocation_id: u64, token: String) -> WindowsTextSurfaceCaptureResponse {
    uia::capture_active_text_surface(invocation_id, token)
}

#[cfg(not(target_os = "windows"))]
fn capture_on_platform(_invocation_id: u64, _token: String) -> WindowsTextSurfaceCaptureResponse {
    unavailable(WindowsCaptureUnavailableReason::NativeUiaUnavailable)
}

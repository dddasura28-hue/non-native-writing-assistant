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
    capture_token: String,
) -> WindowsTextSurfaceCaptureResponse {
    std::thread::spawn(move || capture_on_platform(capture_token))
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

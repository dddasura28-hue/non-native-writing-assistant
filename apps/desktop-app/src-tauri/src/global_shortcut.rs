use crate::windows::geometry::{
    bottom_right_position, logical_gap_to_physical, place_near_anchor, rescale_physical_size,
    AssistantPhysicalSize, ExternalTextAnchor, PhysicalWorkArea,
};
use crate::windows::{
    capture_active_windows_text_surface_now, WindowsCaptureSequence,
    WindowsTextSurfaceCaptureResponse,
};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{App, AppHandle, Emitter, Manager, PhysicalPosition, Runtime, State, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const ASSISTANT_WINDOW_LABEL: &str = "global-assistant";
const CAPTURE_EVENT: &str = "windows-global-capture";
const SHORTCUT_LABEL: &str = "Ctrl+Alt+Space";
const WINDOW_MARGIN: i32 = 20;
const WINDOW_GAP_LOGICAL: f64 = 12.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RegistrationState {
    Initializing,
    Registered,
    Unavailable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationStatus {
    state: RegistrationState,
    shortcut: &'static str,
}

pub struct GlobalShortcutState {
    registration: Mutex<RegistrationState>,
    invocation: AtomicU64,
}

impl Default for GlobalShortcutState {
    fn default() -> Self {
        Self {
            registration: Mutex::new(RegistrationState::Initializing),
            invocation: AtomicU64::new(0),
        }
    }
}

impl GlobalShortcutState {
    fn set_registration(&self, registration: RegistrationState) {
        if let Ok(mut current) = self.registration.lock() {
            *current = registration;
        }
    }

    fn registration(&self) -> RegistrationState {
        self.registration
            .lock()
            .map(|state| *state)
            .unwrap_or(RegistrationState::Unavailable)
    }

    fn next_invocation(&self) -> u64 {
        self.invocation.fetch_add(1, Ordering::Relaxed) + 1
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GlobalCaptureEvent {
    invocation_id: u64,
    response: WindowsTextSurfaceCaptureResponse,
}

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() == ShortcutState::Pressed
                && shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::Space)
            {
                handle_shortcut(app);
            }
        })
        .build()
}

pub fn register<R: Runtime>(app: &App<R>) {
    let state = app.state::<GlobalShortcutState>();
    let result = app.global_shortcut().register(configured_shortcut());
    state.set_registration(if result.is_ok() {
        RegistrationState::Registered
    } else {
        RegistrationState::Unavailable
    });
}

#[tauri::command]
pub fn get_windows_global_shortcut_status(
    state: State<'_, GlobalShortcutState>,
) -> RegistrationStatus {
    RegistrationStatus {
        state: state.registration(),
        shortcut: SHORTCUT_LABEL,
    }
}

fn configured_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
}

fn handle_shortcut<R: Runtime>(app: &AppHandle<R>) {
    let invocation_id = app.state::<GlobalShortcutState>().next_invocation();
    dispatch_capture(
        || capture_active_windows_text_surface_now(&app.state::<WindowsCaptureSequence>()),
        |response| {
            let payload = GlobalCaptureEvent {
                invocation_id,
                response: response.clone(),
            };
            let _ = app.emit_to(ASSISTANT_WINDOW_LABEL, CAPTURE_EVENT, &payload);
            let _ = app.emit_to("main", CAPTURE_EVENT, &payload);
        },
        |response| apply_window_action(app, response),
    );
}

fn dispatch_capture(
    capture: impl FnOnce() -> WindowsTextSurfaceCaptureResponse,
    notify: impl FnOnce(&WindowsTextSurfaceCaptureResponse),
    update_window: impl FnOnce(&WindowsTextSurfaceCaptureResponse),
) {
    let response = capture();
    notify(&response);
    update_window(&response);
}

fn apply_window_action<R: Runtime>(
    app: &AppHandle<R>,
    response: &WindowsTextSurfaceCaptureResponse,
) {
    let Some(window) = app.get_webview_window(ASSISTANT_WINDOW_LABEL) else {
        return;
    };

    let _ = window.hide();
    let WindowsTextSurfaceCaptureResponse::Captured { capture } = response else {
        return;
    };

    if let Ok(size) = window.outer_size() {
        let assistant = AssistantPhysicalSize {
            width: size.width,
            height: size.height,
        };
        let position = capture
            .anchor
            .and_then(|anchor| near_anchor_position(&window, anchor, assistant))
            .or_else(|| fallback_position(&window, assistant));
        if let Some(position) = position {
            let _ = window.set_position(PhysicalPosition::new(position.0, position.1));
        }
    }
    let _ = window.show();
}

fn near_anchor_position<R: Runtime>(
    window: &WebviewWindow<R>,
    anchor: ExternalTextAnchor,
    current_assistant: AssistantPhysicalSize,
) -> Option<(i32, i32)> {
    let (center_x, center_y) = anchor.center();
    let monitor = window.monitor_from_point(center_x, center_y).ok()??;
    let gap = logical_gap_to_physical(WINDOW_GAP_LOGICAL, monitor.scale_factor())?;
    let assistant = assistant_size_for_monitor(window, current_assistant, monitor.scale_factor());
    let work_area = monitor.work_area();
    place_near_anchor(
        anchor,
        assistant,
        PhysicalWorkArea {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width,
            height: work_area.size.height,
        },
        gap,
    )
}

fn fallback_position<R: Runtime>(
    window: &WebviewWindow<R>,
    current_assistant: AssistantPhysicalSize,
) -> Option<(i32, i32)> {
    let monitor = window.primary_monitor().ok()??;
    let assistant = assistant_size_for_monitor(window, current_assistant, monitor.scale_factor());
    let work_area = monitor.work_area();
    Some(bottom_right_position(
        PhysicalWorkArea {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width,
            height: work_area.size.height,
        },
        assistant,
        WINDOW_MARGIN,
    ))
}

fn assistant_size_for_monitor<R: Runtime>(
    window: &WebviewWindow<R>,
    current: AssistantPhysicalSize,
    target_scale_factor: f64,
) -> AssistantPhysicalSize {
    window
        .scale_factor()
        .ok()
        .and_then(|current_scale_factor| {
            rescale_physical_size(current, current_scale_factor, target_scale_factor)
        })
        .unwrap_or(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::geometry::ExternalTextAnchorConfidence;
    use crate::windows::{build_capture, WindowsCaptureUnavailableReason};
    use std::cell::RefCell;

    #[test]
    fn capture_is_completed_before_notification_and_window_visibility() {
        let steps = RefCell::new(Vec::new());
        dispatch_capture(
            || {
                steps.borrow_mut().push("capture");
                WindowsTextSurfaceCaptureResponse::Unavailable {
                    reason: WindowsCaptureUnavailableReason::NoFocusedElement,
                }
            },
            |_| steps.borrow_mut().push("notify"),
            |_| steps.borrow_mut().push("window"),
        );

        assert_eq!(*steps.borrow(), ["capture", "notify", "window"]);
    }

    #[test]
    fn failed_capture_hides_instead_of_reusing_a_previous_result() {
        let captured = RefCell::new(None);
        dispatch_capture(
            || WindowsTextSurfaceCaptureResponse::Unavailable {
                reason: WindowsCaptureUnavailableReason::ProtectedField,
            },
            |_| {},
            |response| {
                *captured.borrow_mut() = Some(matches!(
                    response,
                    WindowsTextSurfaceCaptureResponse::Captured { .. }
                ))
            },
        );
        assert_eq!(*captured.borrow(), Some(false));
    }

    #[test]
    fn every_dispatch_performs_a_fresh_capture() {
        let captures = RefCell::new(0);
        for _ in 0..2 {
            dispatch_capture(
                || {
                    *captures.borrow_mut() += 1;
                    WindowsTextSurfaceCaptureResponse::Unavailable {
                        reason: WindowsCaptureUnavailableReason::NoFocusedElement,
                    }
                },
                |_| {},
                |_| {},
            );
        }
        assert_eq!(*captures.borrow(), 2);
    }

    #[test]
    fn registration_failure_has_a_safe_standalone_status() {
        let state = GlobalShortcutState::default();
        state.set_registration(RegistrationState::Unavailable);
        assert_eq!(state.registration(), RegistrationState::Unavailable);
    }

    #[test]
    fn bottom_right_position_uses_the_monitor_work_area() {
        assert_eq!(
            bottom_right_position(
                PhysicalWorkArea {
                    x: -1920,
                    y: 0,
                    width: 1920,
                    height: 1040,
                },
                AssistantPhysicalSize {
                    width: 420,
                    height: 320,
                },
                20,
            ),
            (-440, 700),
        );
    }

    #[test]
    fn one_frozen_capture_supplies_both_event_and_window_geometry() {
        let anchor = ExternalTextAnchor {
            physical_x: 320.0,
            physical_y: 240.0,
            physical_width: 1.0,
            physical_height: 20.0,
            confidence: ExternalTextAnchorConfidence::Approximate,
        };
        let response = WindowsTextSurfaceCaptureResponse::Captured {
            capture: build_capture(
                "captured source".into(),
                8,
                None,
                true,
                true,
                "capture-1".into(),
                Some(anchor),
            )
            .unwrap(),
        };
        let notified = RefCell::new(None);
        let positioned = RefCell::new(None);

        dispatch_capture(
            || response,
            |response| {
                if let WindowsTextSurfaceCaptureResponse::Captured { capture } = response {
                    *notified.borrow_mut() = capture.anchor;
                }
            },
            |response| {
                if let WindowsTextSurfaceCaptureResponse::Captured { capture } = response {
                    *positioned.borrow_mut() = capture.anchor;
                }
            },
        );

        assert_eq!(*notified.borrow(), Some(anchor));
        assert_eq!(*positioned.borrow(), Some(anchor));
    }
}

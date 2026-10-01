use crate::windows::geometry::{
    bottom_right_position, logical_gap_to_physical, place_near_anchor, rescale_physical_size,
    AssistantPhysicalSize, ExternalTextAnchor, PhysicalWorkArea,
};
use crate::windows::{capture_active_windows_text_surface_now, WindowsTextSurfaceCaptureResponse};
use serde::Serialize;
use std::sync::Mutex;
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
    invocation: Mutex<u64>,
}

impl Default for GlobalShortcutState {
    fn default() -> Self {
        Self {
            registration: Mutex::new(RegistrationState::Initializing),
            invocation: Mutex::new(0),
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

    fn begin_invocation(&self, invalidate_previous: impl FnOnce()) -> u64 {
        let mut invocation = self
            .invocation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *invocation = invocation
            .checked_add(1)
            .expect("Windows global invocation sequence exhausted");
        invalidate_previous();
        *invocation
    }

    fn complete_if_current(&self, invocation_id: u64, complete: impl FnOnce()) -> bool {
        let invocation = self
            .invocation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *invocation != invocation_id {
            return false;
        }
        complete();
        true
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
    let state = app.state::<GlobalShortcutState>();
    let invocation_id = state.begin_invocation(|| hide_assistant_window(app));
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<GlobalShortcutState>();
        dispatch_capture_if_current(
            &state,
            invocation_id,
            || capture_active_windows_text_surface_now(invocation_token(invocation_id)),
            |response| {
                let payload = GlobalCaptureEvent {
                    invocation_id,
                    response: response.clone(),
                };
                let _ = app.emit_to(ASSISTANT_WINDOW_LABEL, CAPTURE_EVENT, &payload);
                let _ = app.emit_to("main", CAPTURE_EVENT, &payload);
                apply_window_action(&app, response);
            },
        );
    });
}

fn dispatch_capture_if_current(
    state: &GlobalShortcutState,
    invocation_id: u64,
    capture: impl FnOnce() -> WindowsTextSurfaceCaptureResponse,
    complete: impl FnOnce(&WindowsTextSurfaceCaptureResponse),
) -> bool {
    let response = capture();
    state.complete_if_current(invocation_id, || complete(&response))
}

fn invocation_token(invocation_id: u64) -> String {
    format!("windows-invocation-{invocation_id}")
}

fn hide_assistant_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(ASSISTANT_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

fn apply_window_action<R: Runtime>(
    app: &AppHandle<R>,
    response: &WindowsTextSurfaceCaptureResponse,
) {
    let Some(window) = app.get_webview_window(ASSISTANT_WINDOW_LABEL) else {
        return;
    };

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
    use std::sync::{mpsc, Arc};

    #[test]
    fn capture_is_completed_before_notification_and_window_visibility() {
        let state = GlobalShortcutState::default();
        let steps = RefCell::new(Vec::new());
        let invocation_id = state.begin_invocation(|| steps.borrow_mut().push("hide-old"));
        dispatch_capture_if_current(
            &state,
            invocation_id,
            || {
                steps.borrow_mut().push("capture");
                WindowsTextSurfaceCaptureResponse::Unavailable {
                    reason: WindowsCaptureUnavailableReason::NoFocusedElement,
                }
            },
            |_| {
                steps.borrow_mut().push("notify");
                steps.borrow_mut().push("window");
            },
        );

        assert_eq!(*steps.borrow(), ["hide-old", "capture", "notify", "window"]);
    }

    #[test]
    fn repeated_shortcuts_create_distinct_monotonic_invocations() {
        let state = GlobalShortcutState::default();
        let first = state.begin_invocation(|| {});
        let second = state.begin_invocation(|| {});

        assert_eq!(first, 1);
        assert_eq!(second, 2);
        assert_ne!(invocation_token(first), invocation_token(second));
    }

    #[test]
    fn slow_capture_a_arriving_after_b_is_discarded() {
        let state = Arc::new(GlobalShortcutState::default());
        let presented = Arc::new(Mutex::new(Vec::new()));
        let invocation_a = state.begin_invocation(|| {});
        let (capture_started_tx, capture_started_rx) = mpsc::channel();
        let (release_capture_tx, release_capture_rx) = mpsc::channel();
        let state_a = Arc::clone(&state);
        let presented_a = Arc::clone(&presented);
        let capture_a = std::thread::spawn(move || {
            dispatch_capture_if_current(
                &state_a,
                invocation_a,
                || {
                    capture_started_tx.send(()).unwrap();
                    release_capture_rx.recv().unwrap();
                    WindowsTextSurfaceCaptureResponse::Unavailable {
                        reason: WindowsCaptureUnavailableReason::NoFocusedElement,
                    }
                },
                |_| presented_a.lock().unwrap().push("A"),
            )
        });
        capture_started_rx.recv().unwrap();

        let invocation_b = state.begin_invocation(|| {});
        assert!(state.complete_if_current(invocation_b, || { presented.lock().unwrap().push("B") }));
        release_capture_tx.send(()).unwrap();

        assert!(!capture_a.join().unwrap());
        assert_eq!(*presented.lock().unwrap(), ["B"]);
    }

    #[test]
    fn current_unavailable_invocation_hides_without_showing() {
        let state = GlobalShortcutState::default();
        let actions = RefCell::new(Vec::new());
        let invocation = state.begin_invocation(|| actions.borrow_mut().push("hide"));

        assert!(
            state.complete_if_current(invocation, || { actions.borrow_mut().push("unavailable") })
        );

        assert_eq!(*actions.borrow(), ["hide", "unavailable"]);
    }

    #[test]
    fn stale_a_cannot_reposition_or_show_after_b_owns_the_window() {
        let state = GlobalShortcutState::default();
        let actions = RefCell::new(Vec::new());
        let invocation_a = state.begin_invocation(|| actions.borrow_mut().push("hide-A"));
        let invocation_b = state.begin_invocation(|| actions.borrow_mut().push("hide-B"));

        assert!(state.complete_if_current(invocation_b, || {
            actions.borrow_mut().push("position-monitor-2");
            actions.borrow_mut().push("show-B");
        }));
        assert!(!state.complete_if_current(invocation_a, || {
            actions.borrow_mut().push("position-monitor-1");
            actions.borrow_mut().push("show-A");
        }));

        assert_eq!(
            *actions.borrow(),
            ["hide-A", "hide-B", "position-monitor-2", "show-B"]
        );
    }

    #[test]
    fn stale_a_failure_cannot_hide_a_successful_b() {
        let state = GlobalShortcutState::default();
        let actions = RefCell::new(Vec::new());
        let invocation_a = state.begin_invocation(|| actions.borrow_mut().push("hide-A"));
        let invocation_b = state.begin_invocation(|| actions.borrow_mut().push("hide-B"));

        assert!(state.complete_if_current(invocation_b, || { actions.borrow_mut().push("show-B") }));
        assert!(!state.complete_if_current(invocation_a, || {
            actions.borrow_mut().push("hide-stale-A-error")
        }));

        assert_eq!(*actions.borrow(), ["hide-A", "hide-B", "show-B"]);
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
        let state = GlobalShortcutState::default();
        let invocation_id = state.begin_invocation(|| {});
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
                invocation_token(invocation_id),
                Some(anchor),
            )
            .unwrap(),
        };
        let notified = RefCell::new(None);
        let positioned = RefCell::new(None);

        dispatch_capture_if_current(
            &state,
            invocation_id,
            || response,
            |response| {
                if let WindowsTextSurfaceCaptureResponse::Captured { capture } = response {
                    *notified.borrow_mut() = capture.anchor;
                    *positioned.borrow_mut() = capture.anchor;
                }
            },
        );

        assert_eq!(*notified.borrow(), Some(anchor));
        assert_eq!(*positioned.borrow(), Some(anchor));
    }

    #[test]
    fn fallback_geometry_is_scoped_to_the_current_invocation() {
        let state = GlobalShortcutState::default();
        let actions = RefCell::new(Vec::new());
        let invocation_a = state.begin_invocation(|| {});
        let invocation_b = state.begin_invocation(|| {});
        let response_b = WindowsTextSurfaceCaptureResponse::Captured {
            capture: build_capture(
                "B".into(),
                1,
                None,
                true,
                true,
                invocation_token(invocation_b),
                None,
            )
            .unwrap(),
        };

        assert!(dispatch_capture_if_current(
            &state,
            invocation_b,
            || response_b,
            |response| {
                if let WindowsTextSurfaceCaptureResponse::Captured { capture } = response {
                    actions.borrow_mut().push(if capture.anchor.is_none() {
                        "fallback-B"
                    } else {
                        "anchor-B"
                    });
                }
            },
        ));
        assert!(!state.complete_if_current(invocation_a, || {
            actions.borrow_mut().push("stale-A-geometry")
        }));

        assert_eq!(*actions.borrow(), ["fallback-B"]);
    }
}

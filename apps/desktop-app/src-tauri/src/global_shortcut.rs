use crate::windows::{
    capture_active_windows_text_surface_now, WindowsCaptureSequence,
    WindowsTextSurfaceCaptureResponse,
};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{App, AppHandle, Emitter, Manager, PhysicalPosition, Runtime, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const ASSISTANT_WINDOW_LABEL: &str = "global-assistant";
const CAPTURE_EVENT: &str = "windows-global-capture";
const SHORTCUT_LABEL: &str = "Ctrl+Alt+Space";
const WINDOW_MARGIN: i32 = 20;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowAction {
    Show,
    Hide,
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
        |action| apply_window_action(app, action),
    );
}

fn dispatch_capture(
    capture: impl FnOnce() -> WindowsTextSurfaceCaptureResponse,
    notify: impl FnOnce(&WindowsTextSurfaceCaptureResponse),
    update_window: impl FnOnce(WindowAction),
) {
    let response = capture();
    let action = if matches!(response, WindowsTextSurfaceCaptureResponse::Captured { .. }) {
        WindowAction::Show
    } else {
        WindowAction::Hide
    };
    notify(&response);
    update_window(action);
}

fn apply_window_action<R: Runtime>(app: &AppHandle<R>, action: WindowAction) {
    let Some(window) = app.get_webview_window(ASSISTANT_WINDOW_LABEL) else {
        return;
    };

    let _ = window.hide();
    if action == WindowAction::Hide {
        return;
    }

    if let (Ok(Some(monitor)), Ok(size)) = (window.primary_monitor(), window.outer_size()) {
        let work_area = monitor.work_area();
        let position = bottom_right_position(
            work_area.position.x,
            work_area.position.y,
            work_area.size.width,
            work_area.size.height,
            size.width,
            size.height,
            WINDOW_MARGIN,
        );
        let _ = window.set_position(PhysicalPosition::new(position.0, position.1));
    }
    let _ = window.show();
}

fn bottom_right_position(
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
    window_width: u32,
    window_height: u32,
    margin: i32,
) -> (i32, i32) {
    let available_x = work_width.saturating_sub(window_width) as i64;
    let available_y = work_height.saturating_sub(window_height) as i64;
    let x = i64::from(work_x) + available_x - i64::from(margin);
    let y = i64::from(work_y) + available_y - i64::from(margin);
    (
        x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::WindowsCaptureUnavailableReason;
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
        let action = RefCell::new(None);
        dispatch_capture(
            || WindowsTextSurfaceCaptureResponse::Unavailable {
                reason: WindowsCaptureUnavailableReason::ProtectedField,
            },
            |_| {},
            |next| *action.borrow_mut() = Some(next),
        );
        assert_eq!(*action.borrow(), Some(WindowAction::Hide));
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
            bottom_right_position(-1920, 0, 1920, 1040, 420, 320, 20),
            (-440, 700),
        );
    }
}

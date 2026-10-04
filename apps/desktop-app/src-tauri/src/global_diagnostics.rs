//! Development-only global invocation tracing. No free-form messages or payloads.
use crate::windows::{WindowsCaptureUnavailableReason, WindowsTextSurfaceCaptureResponse};

#[derive(Clone, Copy)]
pub enum Stage {
    ShortcutCallback,
    InvocationAllocated,
    ComInitialize,
    UiaClient,
    FocusedElement,
    OwnProcess,
    Protected,
    KeyboardFocus,
    Enabled,
    KeyboardFocusable,
    ControlType,
    TextPattern,
    TextPattern2,
    TextEditPattern,
    ValuePattern,
    ValueReadOnly,
    Qualification,
    #[cfg(any(debug_assertions, test))]
    Capture,
    #[cfg(any(debug_assertions, test))]
    Geometry,
    NativeEventAssistant,
    NativeEventMain,
    Position,
    WindowLookup,
    WindowShow,
    InvocationDiscarded,
}

#[cfg(any(debug_assertions, test))]
impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::ShortcutCallback => "shortcut-callback",
            Self::InvocationAllocated => "invocation-allocated",
            Self::ComInitialize => "com-initialize",
            Self::UiaClient => "uia-client",
            Self::FocusedElement => "get-focused-element",
            Self::OwnProcess => "own-process",
            Self::Protected => "password-protected",
            Self::KeyboardFocus => "current-has-keyboard-focus",
            Self::Enabled => "current-is-enabled",
            Self::KeyboardFocusable => "current-is-keyboard-focusable",
            Self::ControlType => "control-type",
            Self::TextPattern => "text-pattern",
            Self::TextPattern2 => "text-pattern2",
            Self::TextEditPattern => "text-edit-pattern",
            Self::ValuePattern => "value-pattern",
            Self::ValueReadOnly => "value-current-is-read-only",
            Self::Qualification => "editable-qualification",
            Self::Capture => "capture",
            Self::Geometry => "geometry",
            Self::NativeEventAssistant => "native-event-assistant",
            Self::NativeEventMain => "native-event-main",
            Self::Position => "position",
            Self::WindowLookup => "window-lookup",
            Self::WindowShow => "window-show",
            Self::InvocationDiscarded => "invocation-discarded",
        }
    }
}

#[derive(Clone, Copy)]
pub enum Outcome {
    Entered,
    Allocated,
    Succeeded,
    Failed,
    Available,
    Unavailable,
    Qualified,
    Rejected,
    #[cfg(any(debug_assertions, test))]
    Captured,
    Attempted,
    Skipped,
    Stale,
}

#[cfg(any(debug_assertions, test))]
impl Outcome {
    fn name(self) -> &'static str {
        match self {
            Self::Entered => "entered",
            Self::Allocated => "allocated",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Available => "available",
            Self::Unavailable => "unavailable",
            Self::Qualified => "qualified",
            Self::Rejected => "rejected",
            Self::Captured => "captured",
            Self::Attempted => "attempted",
            Self::Skipped => "skipped",
            Self::Stale => "stale",
        }
    }
}

#[derive(Default)]
pub struct Details {
    pub value: Option<bool>,
    pub control_type: Option<i32>,
    pub utf16_length: Option<usize>,
    pub hresult: Option<i32>,
    pub reason: Option<WindowsCaptureUnavailableReason>,
}

#[cfg(any(debug_assertions, test))]
pub fn format_line(
    invocation_id: Option<u64>,
    stage: Stage,
    outcome: Outcome,
    details: Details,
) -> String {
    let invocation = invocation_id.map_or_else(|| "-".into(), |id| id.to_string());
    let mut line = format!(
        "[global-debug] invocation={invocation} stage={} result={}",
        stage.name(),
        outcome.name(),
    );
    if let Some(value) = details.value {
        line.push_str(&format!(" value={value}"));
    }
    if let Some(value) = details.control_type {
        line.push_str(&format!(" control_type={value}"));
    }
    if let Some(value) = details.utf16_length {
        line.push_str(&format!(" utf16_length={value}"));
    }
    if let Some(value) = details.hresult {
        line.push_str(&format!(" hresult=0x{:08X}", value as u32));
    }
    if let Some(reason) = details.reason {
        line.push_str(&format!(" reason={reason:?}"));
    }
    line
}

pub fn record(invocation_id: Option<u64>, stage: Stage, outcome: Outcome, details: Details) {
    #[cfg(debug_assertions)]
    eprintln!("{}", format_line(invocation_id, stage, outcome, details));
    #[cfg(not(debug_assertions))]
    let _ = (
        invocation_id,
        stage,
        outcome,
        details.value,
        details.control_type,
        details.utf16_length,
        details.hresult,
        details.reason,
    );
}

#[cfg(any(debug_assertions, test))]
pub fn capture_lines(id: u64, response: &WindowsTextSurfaceCaptureResponse) -> [String; 2] {
    let (outcome, details, geometry) = match response {
        WindowsTextSurfaceCaptureResponse::Captured { capture } => (
            Outcome::Captured,
            Details {
                utf16_length: Some(capture.text.encode_utf16().count()),
                ..Details::default()
            },
            if capture.anchor.is_some() {
                Outcome::Available
            } else {
                Outcome::Unavailable
            },
        ),
        WindowsTextSurfaceCaptureResponse::Unavailable { reason } => (
            Outcome::Unavailable,
            Details {
                reason: Some(*reason),
                ..Details::default()
            },
            Outcome::Skipped,
        ),
    };
    [
        format_line(Some(id), Stage::Capture, outcome, details),
        format_line(Some(id), Stage::Geometry, geometry, Details::default()),
    ]
}

pub fn record_capture(id: u64, response: &WindowsTextSurfaceCaptureResponse) {
    #[cfg(debug_assertions)]
    for line in capture_lines(id, response) {
        eprintln!("{line}");
    }
    #[cfg(not(debug_assertions))]
    let _ = (id, response);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::build_capture;

    #[test]
    fn captured_source_and_token_cannot_enter_diagnostic_lines() {
        let source = "PRIVATE source 中文 😀";
        let response = WindowsTextSurfaceCaptureResponse::Captured {
            capture: build_capture(
                source.into(),
                0,
                None,
                true,
                true,
                "PRIVATE credential".into(),
                None,
            )
            .unwrap(),
        };
        let lines = capture_lines(7, &response).join("\n");
        assert!(lines.contains(&format!("utf16_length={}", source.encode_utf16().count())));
        assert!(!lines.contains("PRIVATE"));
        assert!(!lines.contains(source));
        assert_eq!(
            capture_lines(7, &response)[1],
            "[global-debug] invocation=7 stage=geometry result=unavailable"
        );
    }

    #[test]
    fn failures_format_only_stage_and_safe_codes() {
        assert_eq!(format_line(Some(7), Stage::FocusedElement, Outcome::Failed, Details {
            hresult: Some(0x80004005u32 as i32), ..Details::default()
        }), "[global-debug] invocation=7 stage=get-focused-element result=failed hresult=0x80004005");
        assert_eq!(
            capture_lines(
                7,
                &WindowsTextSurfaceCaptureResponse::Unavailable {
                    reason: WindowsCaptureUnavailableReason::ProtectedField,
                }
            )[0],
            "[global-debug] invocation=7 stage=capture result=unavailable reason=ProtectedField"
        );
    }
}

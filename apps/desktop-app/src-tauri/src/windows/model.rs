use serde::Serialize;
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowsCaptureUnavailableReason {
    NoFocusedElement,
    OwnProcess,
    ProtectedField,
    DisabledElement,
    NotFocusable,
    UnsupportedTextPattern,
    SelectionUnavailable,
    MultipleSelection,
    ElementDisappeared,
    NativeUiaUnavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHostCapabilities {
    pub can_replace_text: bool,
    pub can_observe_composition: bool,
    pub can_observe_selection: bool,
    pub can_provide_surrounding_text: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsTextSurfaceCapture {
    pub text: String,
    pub cursor_offset: usize,
    pub selection: Option<NativeTextRange>,
    pub capabilities: NativeHostCapabilities,
    pub capture_token: String,
}

impl fmt::Debug for WindowsTextSurfaceCapture {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WindowsTextSurfaceCapture")
            .field("text_utf16_len", &utf16_len(&self.text))
            .field("cursor_offset", &self.cursor_offset)
            .field("selection", &self.selection)
            .field("capabilities", &self.capabilities)
            .field("capture_token", &"<opaque>")
            .finish()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum WindowsTextSurfaceCaptureResponse {
    Captured {
        capture: WindowsTextSurfaceCapture,
    },
    Unavailable {
        reason: WindowsCaptureUnavailableReason,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ElementFacts {
    pub own_process: bool,
    pub protected: bool,
    pub enabled: bool,
    pub keyboard_focusable: bool,
    pub has_text_pattern: bool,
}

pub fn validate_element(facts: ElementFacts) -> Result<(), WindowsCaptureUnavailableReason> {
    if facts.own_process {
        return Err(WindowsCaptureUnavailableReason::OwnProcess);
    }
    if facts.protected {
        return Err(WindowsCaptureUnavailableReason::ProtectedField);
    }
    if !facts.enabled {
        return Err(WindowsCaptureUnavailableReason::DisabledElement);
    }
    if !facts.keyboard_focusable {
        return Err(WindowsCaptureUnavailableReason::NotFocusable);
    }
    if !facts.has_text_pattern {
        return Err(WindowsCaptureUnavailableReason::UnsupportedTextPattern);
    }
    Ok(())
}

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn build_capture(
    text: String,
    cursor_offset: usize,
    selection: Option<NativeTextRange>,
    can_observe_selection: bool,
    can_provide_surrounding_text: bool,
    capture_token: String,
) -> Result<WindowsTextSurfaceCapture, WindowsCaptureUnavailableReason> {
    let text_len = utf16_len(&text);
    if cursor_offset > text_len
        || selection.is_some_and(|range| range.start > range.end || range.end > text_len)
        || (!can_observe_selection && selection.is_some())
    {
        return Err(WindowsCaptureUnavailableReason::ElementDisappeared);
    }

    Ok(WindowsTextSurfaceCapture {
        text,
        cursor_offset,
        selection,
        capabilities: NativeHostCapabilities {
            can_replace_text: false,
            can_observe_composition: false,
            can_observe_selection,
            can_provide_surrounding_text,
        },
        capture_token,
    })
}

pub fn unavailable(reason: WindowsCaptureUnavailableReason) -> WindowsTextSurfaceCaptureResponse {
    WindowsTextSurfaceCaptureResponse::Unavailable { reason }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    enum GuardedWriteError {
        SessionChanged,
        Consumed,
        SourceChanged,
        VerificationFailed,
    }

    struct GuardedValueSession {
        identity: u64,
        captured_value: String,
        consumed: bool,
    }

    impl GuardedValueSession {
        fn prepare(
            &mut self,
            identity: u64,
            current_value: &str,
            range: NativeTextRange,
            expected_text: &str,
            replacement_text: &str,
        ) -> Result<String, GuardedWriteError> {
            if self.consumed {
                return Err(GuardedWriteError::Consumed);
            }
            self.consumed = true;
            if identity != self.identity {
                return Err(GuardedWriteError::SessionChanged);
            }
            if current_value != self.captured_value {
                return Err(GuardedWriteError::SourceChanged);
            }
            replace_utf16_range(current_value, range, expected_text, replacement_text)
                .ok_or(GuardedWriteError::SourceChanged)
        }

        fn verify(actual: &str, expected: &str) -> Result<(), GuardedWriteError> {
            if actual == expected {
                Ok(())
            } else {
                Err(GuardedWriteError::VerificationFailed)
            }
        }
    }

    fn replace_utf16_range(
        value: &str,
        range: NativeTextRange,
        expected_text: &str,
        replacement_text: &str,
    ) -> Option<String> {
        let start = utf16_to_utf8_boundary(value, range.start)?;
        let end = utf16_to_utf8_boundary(value, range.end)?;
        if value.get(start..end)? != expected_text {
            return None;
        }
        Some(format!(
            "{}{}{}",
            value.get(..start)?,
            replacement_text,
            value.get(end..)?
        ))
    }

    fn utf16_to_utf8_boundary(value: &str, offset: usize) -> Option<usize> {
        if offset == 0 {
            return Some(0);
        }
        let mut utf16_offset = 0;
        for (utf8_offset, character) in value.char_indices() {
            if utf16_offset == offset {
                return Some(utf8_offset);
            }
            utf16_offset += character.len_utf16();
            if utf16_offset > offset {
                return None;
            }
        }
        (utf16_offset == offset).then_some(value.len())
    }

    #[test]
    fn protected_control_is_rejected() {
        assert_eq!(
            validate_element(ElementFacts {
                own_process: false,
                protected: true,
                enabled: true,
                keyboard_focusable: true,
                has_text_pattern: true,
            }),
            Err(WindowsCaptureUnavailableReason::ProtectedField)
        );
    }

    #[test]
    fn unsupported_element_is_unavailable() {
        assert_eq!(
            validate_element(ElementFacts {
                own_process: false,
                protected: false,
                enabled: true,
                keyboard_focusable: true,
                has_text_pattern: false,
            }),
            Err(WindowsCaptureUnavailableReason::UnsupportedTextPattern)
        );
    }

    #[test]
    fn utf16_offsets_count_emoji_as_two_code_units() {
        assert_eq!(utf16_len("A😀B"), 4);
        let capture =
            build_capture("A😀B".into(), 3, None, true, true, "capture-1".into()).unwrap();
        assert_eq!(capture.cursor_offset, 3);
    }

    #[test]
    fn degenerate_caret_maps_without_a_selection() {
        let capture =
            build_capture("hello".into(), 2, None, true, true, "capture-1".into()).unwrap();
        assert_eq!(capture.cursor_offset, 2);
        assert_eq!(capture.selection, None);
    }

    #[test]
    fn one_contiguous_selection_is_preserved() {
        let range = NativeTextRange { start: 1, end: 4 };
        let capture = build_capture(
            "hello".into(),
            4,
            Some(range),
            true,
            false,
            "capture-1".into(),
        )
        .unwrap();
        assert_eq!(capture.selection, Some(range));
    }

    #[test]
    fn multiple_selection_degrades_to_caret_only() {
        let capture = build_capture(
            "first second".into(),
            6,
            None,
            false,
            true,
            "capture-1".into(),
        )
        .unwrap();
        assert!(!capture.capabilities.can_observe_selection);
        assert_eq!(capture.selection, None);
    }

    #[test]
    fn text_pattern_capture_is_read_only_and_composition_unknown() {
        let capture =
            build_capture("read only".into(), 4, None, true, true, "capture-1".into()).unwrap();
        assert!(!capture.capabilities.can_replace_text);
        assert!(!capture.capabilities.can_observe_composition);
    }

    #[test]
    fn same_text_with_a_changed_native_identity_rejects_old_write() {
        let mut session = GuardedValueSession {
            identity: 10,
            captured_value: "hello".into(),
            consumed: false,
        };
        assert_eq!(
            session.prepare(
                11,
                "hello",
                NativeTextRange { start: 0, end: 5 },
                "hello",
                "hi"
            ),
            Err(GuardedWriteError::SessionChanged)
        );
    }

    #[test]
    fn guarded_write_session_is_one_shot() {
        let mut session = GuardedValueSession {
            identity: 10,
            captured_value: "hello".into(),
            consumed: false,
        };
        assert_eq!(
            session
                .prepare(
                    10,
                    "hello",
                    NativeTextRange { start: 0, end: 5 },
                    "hello",
                    "hi"
                )
                .unwrap(),
            "hi"
        );
        assert_eq!(
            session.prepare(
                10,
                "hello",
                NativeTextRange { start: 0, end: 5 },
                "hello",
                "hi"
            ),
            Err(GuardedWriteError::Consumed)
        );
    }

    #[test]
    fn pre_write_value_mismatch_rejects_without_replacement() {
        let mut session = GuardedValueSession {
            identity: 10,
            captured_value: "hello".into(),
            consumed: false,
        };
        assert_eq!(
            session.prepare(
                10,
                "changed",
                NativeTextRange { start: 0, end: 5 },
                "hello",
                "hi"
            ),
            Err(GuardedWriteError::SourceChanged)
        );
    }

    #[test]
    fn post_write_verification_failure_is_safe() {
        assert_eq!(
            GuardedValueSession::verify("provider changed it", "expected"),
            Err(GuardedWriteError::VerificationFailed)
        );
    }

    #[test]
    fn formatted_capture_and_errors_do_not_disclose_source_text() {
        let secret_source = "confidential-source-value";
        let capture = build_capture(
            secret_source.into(),
            0,
            None,
            true,
            true,
            "secret-token".into(),
        )
        .unwrap();
        assert!(!format!("{capture:?}").contains(secret_source));
        assert!(
            !format!("{:?}", WindowsCaptureUnavailableReason::ElementDisappeared)
                .contains(secret_source)
        );
    }
}

use super::geometry::ExternalTextAnchor;
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
    NotEditable,
    UnsupportedTextPattern,
    SelectionUnavailable,
    MultipleSelection,
    ElementDisappeared,
    NativeUiaUnavailable,
}

pub const CONTEXT_CHARACTERS_PER_SIDE: i32 = 8_192;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<ExternalTextAnchor>,
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
pub enum FocusedControlType {
    Edit,
    Document,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ElementFacts {
    pub own_process: bool,
    pub protected: bool,
    pub enabled: bool,
    pub has_keyboard_focus: bool,
    pub keyboard_focusable: bool,
    pub control_type: FocusedControlType,
    pub has_text_pattern: bool,
    pub has_text_edit_pattern: bool,
    pub value_pattern_read_only: Option<bool>,
}

pub fn qualify_focused_element(facts: ElementFacts) -> Result<(), WindowsCaptureUnavailableReason> {
    if facts.own_process {
        return Err(WindowsCaptureUnavailableReason::OwnProcess);
    }
    if facts.protected {
        return Err(WindowsCaptureUnavailableReason::ProtectedField);
    }
    if !facts.enabled {
        return Err(WindowsCaptureUnavailableReason::DisabledElement);
    }
    if !facts.has_keyboard_focus {
        return Err(WindowsCaptureUnavailableReason::NoFocusedElement);
    }
    if !facts.keyboard_focusable {
        return Err(WindowsCaptureUnavailableReason::NotFocusable);
    }
    if facts.control_type != FocusedControlType::Edit {
        return Err(WindowsCaptureUnavailableReason::NotEditable);
    }
    if !facts.has_text_pattern {
        return Err(WindowsCaptureUnavailableReason::UnsupportedTextPattern);
    }
    if facts.value_pattern_read_only == Some(true) {
        return Err(WindowsCaptureUnavailableReason::NotEditable);
    }
    if !facts.has_text_edit_pattern && facts.value_pattern_read_only != Some(false) {
        return Err(WindowsCaptureUnavailableReason::NotEditable);
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
    anchor: Option<ExternalTextAnchor>,
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
        anchor: anchor.filter(|value| value.is_valid()),
    })
}

pub fn unavailable(reason: WindowsCaptureUnavailableReason) -> WindowsTextSurfaceCaptureResponse {
    WindowsTextSurfaceCaptureResponse::Unavailable { reason }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::geometry::ExternalTextAnchorConfidence;

    fn editable_facts() -> ElementFacts {
        ElementFacts {
            own_process: false,
            protected: false,
            enabled: true,
            has_keyboard_focus: true,
            keyboard_focusable: true,
            control_type: FocusedControlType::Edit,
            has_text_pattern: true,
            has_text_edit_pattern: false,
            value_pattern_read_only: Some(false),
        }
    }

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
            qualify_focused_element(ElementFacts {
                protected: true,
                ..editable_facts()
            }),
            Err(WindowsCaptureUnavailableReason::ProtectedField)
        );
    }

    #[test]
    fn own_process_control_is_rejected() {
        assert_eq!(
            qualify_focused_element(ElementFacts {
                own_process: true,
                ..editable_facts()
            }),
            Err(WindowsCaptureUnavailableReason::OwnProcess)
        );
    }

    #[test]
    fn unsupported_element_is_unavailable() {
        assert_eq!(
            qualify_focused_element(ElementFacts {
                has_text_pattern: false,
                ..editable_facts()
            }),
            Err(WindowsCaptureUnavailableReason::UnsupportedTextPattern)
        );
    }

    #[test]
    fn browser_text_input_and_textarea_like_writable_edits_are_accepted() {
        let text_input = editable_facts();
        let textarea = ElementFacts {
            has_text_edit_pattern: true,
            ..editable_facts()
        };

        for provider_shape in [text_input, textarea] {
            assert_eq!(qualify_focused_element(provider_shape), Ok(()));
        }
    }

    #[test]
    fn edit_shaped_contenteditable_with_text_edit_pattern_is_accepted() {
        assert_eq!(
            qualify_focused_element(ElementFacts {
                has_text_edit_pattern: true,
                value_pattern_read_only: None,
                ..editable_facts()
            }),
            Ok(())
        );
    }

    #[test]
    fn disabled_edit_is_rejected() {
        assert_eq!(
            qualify_focused_element(ElementFacts {
                enabled: false,
                ..editable_facts()
            }),
            Err(WindowsCaptureUnavailableReason::DisabledElement)
        );
    }

    #[test]
    fn element_that_lost_keyboard_focus_is_rejected() {
        assert_eq!(
            qualify_focused_element(ElementFacts {
                has_keyboard_focus: false,
                ..editable_facts()
            }),
            Err(WindowsCaptureUnavailableReason::NoFocusedElement)
        );
    }

    #[test]
    fn generic_document_is_rejected_even_with_text_patterns() {
        assert_eq!(
            qualify_focused_element(ElementFacts {
                control_type: FocusedControlType::Document,
                has_text_edit_pattern: true,
                ..editable_facts()
            }),
            Err(WindowsCaptureUnavailableReason::NotEditable)
        );
    }

    #[test]
    fn text_pattern_alone_does_not_prove_editability() {
        assert_eq!(
            qualify_focused_element(ElementFacts {
                has_text_edit_pattern: false,
                value_pattern_read_only: None,
                ..editable_facts()
            }),
            Err(WindowsCaptureUnavailableReason::NotEditable)
        );
    }

    #[test]
    fn read_only_value_pattern_overrides_other_editability_signals() {
        assert_eq!(
            qualify_focused_element(ElementFacts {
                has_text_edit_pattern: true,
                value_pattern_read_only: Some(true),
                ..editable_facts()
            }),
            Err(WindowsCaptureUnavailableReason::NotEditable)
        );
    }

    #[test]
    fn browser_fixture_captures_only_the_focused_editable_surface() {
        let page = "Dashboard\nBuild logs...\nconst foo = ...\nNavigation";
        let focused = "I think this method have problem.";
        qualify_focused_element(editable_facts()).unwrap();

        let capture = build_capture(
            focused.into(),
            focused.len(),
            None,
            true,
            true,
            "browser-editable".into(),
            None,
        )
        .unwrap();

        assert_eq!(capture.text, focused);
        for unrelated in page.lines() {
            assert!(!capture.text.contains(unrelated));
        }
    }

    #[test]
    fn ambiguous_nested_browser_provider_does_not_promote_its_document_ancestor() {
        let focused = ElementFacts {
            control_type: FocusedControlType::Other,
            has_text_pattern: false,
            has_text_edit_pattern: false,
            value_pattern_read_only: None,
            ..editable_facts()
        };
        let broad_ancestor = ElementFacts {
            control_type: FocusedControlType::Document,
            has_text_pattern: true,
            has_text_edit_pattern: false,
            value_pattern_read_only: Some(true),
            ..editable_facts()
        };

        assert_eq!(
            qualify_focused_element(focused),
            Err(WindowsCaptureUnavailableReason::NotEditable)
        );
        assert_eq!(
            qualify_focused_element(broad_ancestor),
            Err(WindowsCaptureUnavailableReason::NotEditable)
        );
    }

    #[test]
    fn capture_window_limit_remains_bounded_per_caret_side() {
        assert_eq!(CONTEXT_CHARACTERS_PER_SIDE, 8_192);
    }

    #[test]
    fn utf16_offsets_count_emoji_as_two_code_units() {
        assert_eq!(utf16_len("A😀B"), 4);
        let capture =
            build_capture("A😀B".into(), 3, None, true, true, "capture-1".into(), None).unwrap();
        assert_eq!(capture.cursor_offset, 3);
    }

    #[test]
    fn degenerate_caret_maps_without_a_selection() {
        let capture = build_capture(
            "hello".into(),
            2,
            None,
            true,
            true,
            "capture-1".into(),
            None,
        )
        .unwrap();
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
            None,
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
            None,
        )
        .unwrap();
        assert!(!capture.capabilities.can_observe_selection);
        assert_eq!(capture.selection, None);
    }

    #[test]
    fn text_pattern_capture_is_read_only_and_composition_unknown() {
        let capture = build_capture(
            "read only".into(),
            4,
            None,
            true,
            true,
            "capture-1".into(),
            None,
        )
        .unwrap();
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
            None,
        )
        .unwrap();
        assert!(!format!("{capture:?}").contains(secret_source));
        assert!(
            !format!("{:?}", WindowsCaptureUnavailableReason::ElementDisappeared)
                .contains(secret_source)
        );
    }

    #[test]
    fn invalid_geometry_does_not_invalidate_the_text_capture() {
        let capture = build_capture(
            "English 中文\nA😀B".into(),
            14,
            None,
            true,
            true,
            "capture-geometry-failure".into(),
            Some(ExternalTextAnchor {
                physical_x: f64::NAN,
                physical_y: 20.0,
                physical_width: 1.0,
                physical_height: 18.0,
                confidence: ExternalTextAnchorConfidence::Approximate,
            }),
        )
        .unwrap();

        assert_eq!(capture.text, "English 中文\nA😀B");
        assert_eq!(capture.anchor, None);
    }

    #[test]
    fn unavailable_payloads_expose_neither_text_nor_geometry() {
        for (reason, serialized_reason) in [
            (
                WindowsCaptureUnavailableReason::ProtectedField,
                "protected-field",
            ),
            (WindowsCaptureUnavailableReason::NotEditable, "not-editable"),
        ] {
            let payload = serde_json::to_value(unavailable(reason)).unwrap();
            assert_eq!(payload["status"], "unavailable");
            assert_eq!(payload["reason"], serialized_reason);
            assert!(payload.get("capture").is_none());
            assert!(payload.get("anchor").is_none());
        }
    }
}

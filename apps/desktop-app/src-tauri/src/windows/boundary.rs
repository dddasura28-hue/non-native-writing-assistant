//! A transient proof of exact editable-value ownership, separate from qualification.
use super::model::{NativeTextRange, WindowsCaptureUnavailableReason as Unavailable};

pub struct VerifiedEditableTextDomain<'a> {
    value: &'a str,
}

impl std::fmt::Debug for VerifiedEditableTextDomain<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VerifiedEditableTextDomain")
            .field("value_utf16_len", &super::model::utf16_len(self.value))
            .finish()
    }
}

impl<'a> VerifiedEditableTextDomain<'a> {
    pub fn verify(value: Option<&'a str>, provider_text: &str) -> Result<Self, Unavailable> {
        let value = value.ok_or(Unavailable::AmbiguousEditableDomain)?;
        if value != provider_text {
            return Err(Unavailable::ValueTextDomainMismatch);
        }
        Ok(Self { value })
    }

    pub fn validate_range_text(
        &self,
        range: NativeTextRange,
        text: &str,
    ) -> Result<(), Unavailable> {
        if range.start > range.end {
            return Err(Unavailable::UnsupportedSelection);
        }
        let start =
            utf16_boundary(self.value, range.start).ok_or(Unavailable::UnsupportedSelection)?;
        let end = utf16_boundary(self.value, range.end).ok_or(Unavailable::UnsupportedSelection)?;
        if self.value.get(start..end) != Some(text) {
            return Err(Unavailable::ValueTextDomainMismatch);
        }
        Ok(())
    }

    pub fn verify_current(&self, value: &str, provider_text: &str) -> Result<(), Unavailable> {
        if value != self.value || provider_text != self.value {
            return Err(Unavailable::ValueTextDomainMismatch);
        }
        Ok(())
    }
}

/// Endpoint comparisons come from peer UIA ranges, never text matching.
pub fn verify_range_ownership(
    same_focused_element: bool,
    start_vs_domain_start: i32,
    end_vs_domain_end: i32,
    start_vs_end: i32,
) -> Result<(), Unavailable> {
    if !same_focused_element
        || start_vs_domain_start < 0
        || end_vs_domain_end > 0
        || start_vs_end > 0
    {
        return Err(Unavailable::UnsupportedSelection);
    }
    Ok(())
}

fn utf16_boundary(text: &str, offset: usize) -> Option<usize> {
    let mut current = 0;
    for (byte, character) in text.char_indices() {
        if current == offset {
            return Some(byte);
        }
        current += character.len_utf16();
        if current > offset {
            return None;
        }
    }
    (current == offset).then_some(text.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::geometry::{ExternalTextAnchor, ExternalTextAnchorConfidence};
    use crate::windows::model::{
        build_capture, qualify_focused_element, unavailable, utf16_len, ElementFacts,
        FocusedControlType, WindowsTextSurfaceCapture, WindowsTextSurfaceCaptureResponse,
    };

    struct FakeProvider<'a> {
        facts: ElementFacts,
        value: Option<&'a str>,
        text_domain: &'a str,
        caret: Option<usize>,
        same_range_owner: bool,
    }

    fn isolated(value: &str) -> FakeProvider<'_> {
        FakeProvider {
            facts: ElementFacts {
                own_process: false,
                protected: false,
                enabled: true,
                has_keyboard_focus: true,
                keyboard_focusable: true,
                control_type: FocusedControlType::Edit,
                has_text_pattern: true,
                has_text_edit_pattern: false,
                value_pattern_read_only: Some(false),
            },
            value: Some(value),
            text_domain: value,
            caret: Some(utf16_len(value)),
            same_range_owner: true,
        }
    }

    impl FakeProvider<'_> {
        fn capture(&self) -> Result<WindowsTextSurfaceCapture, Unavailable> {
            qualify_focused_element(self.facts)?;
            let domain = VerifiedEditableTextDomain::verify(self.value, self.text_domain)?;
            verify_range_ownership(self.same_range_owner, 0, 0, -1)?;
            let caret = self.caret.ok_or(Unavailable::MissingCaret)?;
            let range = NativeTextRange {
                start: 0,
                end: utf16_len(self.text_domain),
            };
            domain.validate_range_text(range, self.text_domain)?;
            // Geometry is supplied only after the same production proof succeeds.
            build_capture(
                self.text_domain.into(),
                caret,
                None,
                true,
                true,
                "fixture".into(),
                Some(ExternalTextAnchor {
                    physical_x: 10.0,
                    physical_y: 20.0,
                    physical_width: 1.0,
                    physical_height: 18.0,
                    confidence: ExternalTextAnchorConfidence::Approximate,
                }),
            )
        }
    }

    #[test]
    fn isolated_input_and_textarea_values_have_exact_source() {
        for value in [
            "I think this method have problem.",
            "first line\nsecond line",
        ] {
            let capture = isolated(value).capture().unwrap();
            assert_eq!(capture.text, value);
            assert_eq!(capture.cursor_offset, utf16_len(value));
            assert!(!capture.capabilities.can_replace_text);
            assert!(!capture.capabilities.can_observe_composition);
        }
    }

    #[test]
    fn broad_page_is_rejected_despite_qualification_and_matching_substring() {
        let value = "I think this method have problem.";
        let mut provider = isolated(value);
        provider.facts.control_type = FocusedControlType::Document;
        provider.facts.has_text_edit_pattern = true;
        provider.text_domain =
            "Dashboard\nBuild logs\nI think this method have problem.\nNavigation";
        assert_eq!(qualify_focused_element(provider.facts), Ok(()));
        assert_eq!(
            provider.capture().err(),
            Some(Unavailable::ValueTextDomainMismatch)
        );
    }

    #[test]
    fn repeated_value_is_never_located_in_a_broad_domain() {
        for domain in [
            "hello hello",
            "hello\nNavigation\nhello",
            " hello",
            "hello\r\n",
        ] {
            assert_eq!(
                VerifiedEditableTextDomain::verify(Some("hello"), domain).err(),
                Some(Unavailable::ValueTextDomainMismatch)
            );
        }
    }

    #[test]
    fn value_pattern_only_and_missing_insertion_points_are_unsupported() {
        let mut provider = isolated("value only");
        provider.facts.has_text_pattern = false;
        provider.caret = None;
        assert_eq!(
            provider.capture().err(),
            Some(Unavailable::UnsupportedTextPattern)
        );
        provider.facts.has_text_pattern = true;
        assert_eq!(provider.capture().err(), Some(Unavailable::MissingCaret));
    }

    #[test]
    fn text_edit_only_document_is_qualified_but_its_domain_is_ambiguous() {
        let mut provider = isolated("contenteditable");
        provider.facts.control_type = FocusedControlType::Document;
        provider.facts.has_text_edit_pattern = true;
        provider.facts.value_pattern_read_only = None;
        provider.value = None;
        assert_eq!(qualify_focused_element(provider.facts), Ok(()));
        assert_eq!(
            provider.capture().err(),
            Some(Unavailable::AmbiguousEditableDomain)
        );
    }

    #[test]
    fn notepad_document_remains_supported_with_exact_writable_value() {
        let mut provider = isolated("Notepad 中文 😀\r\nsecond line");
        provider.facts.control_type = FocusedControlType::Document;
        provider.facts.has_text_edit_pattern = true;
        assert_eq!(provider.capture().unwrap().text, provider.value.unwrap());
    }

    #[test]
    fn empty_value_never_imports_placeholder_or_accessibility_text() {
        let provider = isolated("");
        assert_eq!(provider.capture().unwrap().text, "");
        for unrelated in [
            "Type here",
            "Accessible name",
            "Label",
            "Help text",
            "Autocomplete option",
        ] {
            assert_eq!(
                VerifiedEditableTextDomain::verify(Some(""), unrelated).err(),
                Some(Unavailable::ValueTextDomainMismatch)
            );
        }
    }

    #[test]
    fn password_and_read_only_document_are_rejected_before_boundary_capture() {
        let mut provider = isolated("must not be captured");
        provider.facts.control_type = FocusedControlType::Document;
        provider.facts.protected = true;
        assert_eq!(provider.capture().err(), Some(Unavailable::ProtectedField));
        provider.facts.protected = false;
        provider.facts.value_pattern_read_only = Some(true);
        assert_eq!(provider.capture().err(), Some(Unavailable::NotEditable));
    }

    #[test]
    fn ranges_from_other_elements_or_outside_the_domain_are_rejected() {
        for evidence in [
            (false, 0, 0, -1),
            (true, -1, 0, -1),
            (true, 0, 1, -1),
            (true, 0, 0, 1),
        ] {
            assert_eq!(
                verify_range_ownership(evidence.0, evidence.1, evidence.2, evidence.3),
                Err(Unavailable::UnsupportedSelection)
            );
        }
        assert_eq!(verify_range_ownership(true, 1, -1, -1), Ok(()));
        let mut provider = isolated("same text in another provider");
        provider.same_range_owner = false;
        assert_eq!(
            provider.capture().err(),
            Some(Unavailable::UnsupportedSelection)
        );
    }

    #[test]
    fn bounded_range_text_and_utf16_offsets_are_exact_without_normalization() {
        let mut provider = isolated("A😀B");
        provider.caret = Some(3);
        let capture = provider.capture().unwrap();
        assert_eq!(capture.text, "A😀B");
        assert_eq!(capture.cursor_offset, 3);
        for (value, range, text) in [
            ("A😀B", NativeTextRange { start: 1, end: 3 }, "😀"),
            ("中文写作", NativeTextRange { start: 1, end: 3 }, "文写"),
            (
                "English 中文 😀\r\nnext",
                NativeTextRange { start: 8, end: 13 },
                "中文 😀",
            ),
            (
                "line one\nline two",
                NativeTextRange { start: 5, end: 13 },
                "one\nline",
            ),
        ] {
            let domain = VerifiedEditableTextDomain::verify(Some(value), value).unwrap();
            assert_eq!(domain.validate_range_text(range, text), Ok(()));
        }
        let domain = VerifiedEditableTextDomain::verify(Some("A😀B"), "A😀B").unwrap();
        assert_eq!(
            domain.validate_range_text(NativeTextRange { start: 1, end: 2 }, ""),
            Err(Unavailable::UnsupportedSelection)
        );
        assert_eq!(
            domain.validate_range_text(NativeTextRange { start: 0, end: 4 }, "Navigation"),
            Err(Unavailable::ValueTextDomainMismatch)
        );
        assert_eq!(
            domain.validate_range_text(NativeTextRange { start: 4, end: 5 }, ""),
            Err(Unavailable::UnsupportedSelection)
        );
    }

    #[test]
    fn boundary_failure_emits_no_text_or_geometry_and_debug_is_source_free() {
        let mut provider = isolated("PRIVATE value 😀");
        provider.text_domain = "PRIVATE broad page with value";
        let response = provider
            .capture()
            .map(|capture| WindowsTextSurfaceCaptureResponse::Captured { capture })
            .unwrap_or_else(unavailable);
        let payload = serde_json::to_value(response).unwrap();
        assert_eq!(payload["reason"], "value-text-domain-mismatch");
        assert!(payload.get("capture").is_none());
        assert!(payload.get("anchor").is_none());
        assert!(!payload.to_string().contains("PRIVATE"));
        let domain =
            VerifiedEditableTextDomain::verify(Some("PRIVATE value"), "PRIVATE value").unwrap();
        assert!(!format!("{domain:?}").contains("PRIVATE"));
    }

    #[test]
    fn a_domain_that_changes_during_capture_cannot_supply_the_old_snapshot() {
        let domain = VerifiedEditableTextDomain::verify(Some("old value"), "old value").unwrap();
        assert_eq!(domain.verify_current("old value", "old value"), Ok(()));
        for (value, text) in [
            ("new value", "new value"),
            ("old value", "new value"),
            ("new value", "old value"),
        ] {
            assert_eq!(
                domain.verify_current(value, text),
                Err(Unavailable::ValueTextDomainMismatch)
            );
        }
    }
}

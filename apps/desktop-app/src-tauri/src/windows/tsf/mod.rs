//! Windows TSF feasibility proof.
//!
//! This module deliberately contains no COM activation, registration, IPC,
//! provider access, or production host wiring. It proves the UTF-16 mapping,
//! composition lifecycle, native-session identity, and guarded-write rules
//! that a future separately-built TSF in-process DLL would need to enforce.

mod bindings;

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Utf16Range {
    start: usize,
    end: usize,
}

impl Utf16Range {
    fn validate(self, text: &str) -> Result<(), ProofError> {
        if self.start > self.end || self.end > text.encode_utf16().count() {
            return Err(ProofError::RangeUnavailable);
        }
        utf16_to_utf8_boundary(text, self.start).ok_or(ProofError::InvalidUtf16Boundary)?;
        utf16_to_utf8_boundary(text, self.end).ok_or(ProofError::InvalidUtf16Boundary)?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActiveEnd {
    Start,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NativeSelection {
    range: Utf16Range,
    active_end: ActiveEnd,
}

#[derive(Clone, PartialEq, Eq)]
struct OpaqueSession {
    document_manager: u64,
    context: u64,
    generation: u64,
}

impl fmt::Debug for OpaqueSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpaqueSession(<redacted>)")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeComposition {
    range: Utf16Range,
    text: String,
}

#[derive(Clone, PartialEq, Eq)]
struct NativeTextSnapshot {
    text: String,
    cursor_offset: usize,
    selection: Option<Utf16Range>,
    composition: Option<NativeComposition>,
    session: OpaqueSession,
    analyzable: bool,
}

impl fmt::Debug for NativeTextSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeTextSnapshot")
            .field("text_utf16_len", &self.text.encode_utf16().count())
            .field("cursor_offset", &self.cursor_offset)
            .field("selection", &self.selection)
            .field(
                "composition_range",
                &self.composition.as_ref().map(|value| value.range),
            )
            .field("session", &self.session)
            .field("analyzable", &self.analyzable)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureDirective {
    DeferWhileComposing,
    CaptureCommitted,
    DiscardCancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProofError {
    Deactivated,
    MultipleSelections,
    RangeUnavailable,
    InvalidUtf16Boundary,
    CompositionAlreadyActive,
    CompositionInactive,
    SessionChanged,
    SourceChanged,
    CompositionActive,
    Consumed,
}

impl fmt::Display for ProofError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Deactivated => "TSF host is inactive.",
            Self::MultipleSelections => "The native selection cannot be represented safely.",
            Self::RangeUnavailable | Self::InvalidUtf16Boundary => {
                "The native text range is unavailable."
            }
            Self::CompositionAlreadyActive | Self::CompositionInactive => {
                "The native composition lifecycle changed."
            }
            Self::SessionChanged => "The native text session changed.",
            Self::SourceChanged => "The source text changed.",
            Self::CompositionActive => "Text replacement is unavailable during composition.",
            Self::Consumed => "The native replacement was already used.",
        };
        formatter.write_str(message)
    }
}

#[derive(Debug)]
struct TsfProofHost {
    active: bool,
    document_manager: u64,
    context: u64,
    generation: u64,
    composition: Option<Utf16Range>,
}

impl TsfProofHost {
    fn activate(document_manager: u64, context: u64) -> Self {
        Self {
            active: true,
            document_manager,
            context,
            generation: 1,
            composition: None,
        }
    }

    fn session(&self) -> Result<OpaqueSession, ProofError> {
        if !self.active {
            return Err(ProofError::Deactivated);
        }
        Ok(OpaqueSession {
            document_manager: self.document_manager,
            context: self.context,
            generation: self.generation,
        })
    }

    fn focus_context(&mut self, document_manager: u64, context: u64) {
        self.document_manager = document_manager;
        self.context = context;
        self.generation += 1;
        self.composition = None;
    }

    fn note_native_edit(&mut self) {
        self.generation += 1;
    }

    fn start_composition(&mut self, range: Utf16Range) -> Result<CaptureDirective, ProofError> {
        self.ensure_active()?;
        if self.composition.is_some() {
            return Err(ProofError::CompositionAlreadyActive);
        }
        self.generation += 1;
        self.composition = Some(range);
        Ok(CaptureDirective::DeferWhileComposing)
    }

    fn update_composition(&mut self, range: Utf16Range) -> Result<CaptureDirective, ProofError> {
        self.ensure_active()?;
        if self.composition.is_none() {
            return Err(ProofError::CompositionInactive);
        }
        self.generation += 1;
        self.composition = Some(range);
        Ok(CaptureDirective::DeferWhileComposing)
    }

    fn end_composition(&mut self, committed: bool) -> Result<CaptureDirective, ProofError> {
        self.ensure_active()?;
        if self.composition.take().is_none() {
            return Err(ProofError::CompositionInactive);
        }
        self.generation += 1;
        Ok(if committed {
            CaptureDirective::CaptureCommitted
        } else {
            CaptureDirective::DiscardCancelled
        })
    }

    fn deactivate(&mut self) {
        self.active = false;
        self.generation += 1;
        self.composition = None;
    }

    fn callback_action(&self) -> Result<CaptureDirective, ProofError> {
        self.ensure_active()?;
        Ok(if self.composition.is_some() {
            CaptureDirective::DeferWhileComposing
        } else {
            CaptureDirective::CaptureCommitted
        })
    }

    fn ensure_active(&self) -> Result<(), ProofError> {
        if self.active {
            Ok(())
        } else {
            Err(ProofError::Deactivated)
        }
    }

    fn capture(
        &self,
        text: &str,
        selections: &[NativeSelection],
        before_limit: usize,
        after_limit: usize,
    ) -> Result<NativeTextSnapshot, ProofError> {
        self.ensure_active()?;
        if selections.len() != 1 {
            return Err(ProofError::MultipleSelections);
        }

        let selection = selections[0];
        selection.range.validate(text)?;
        if let Some(composition) = self.composition {
            composition.validate(text)?;
        }

        let target_start = self.composition.map_or(selection.range.start, |value| {
            value.start.min(selection.range.start)
        });
        let target_end = self.composition.map_or(selection.range.end, |value| {
            value.end.max(selection.range.end)
        });
        let total = text.encode_utf16().count();
        let window_start = next_utf16_boundary(text, target_start.saturating_sub(before_limit))
            .ok_or(ProofError::InvalidUtf16Boundary)?;
        let window_end =
            previous_utf16_boundary(text, target_end.saturating_add(after_limit).min(total))
                .ok_or(ProofError::InvalidUtf16Boundary)?;
        let window = slice_utf16(
            text,
            Utf16Range {
                start: window_start,
                end: window_end,
            },
        )?;
        let mapped_selection = Utf16Range {
            start: selection.range.start - window_start,
            end: selection.range.end - window_start,
        };
        let cursor_offset = match selection.active_end {
            ActiveEnd::Start => mapped_selection.start,
            ActiveEnd::End => mapped_selection.end,
        };
        let selection =
            (mapped_selection.start != mapped_selection.end).then_some(mapped_selection);
        let composition = self
            .composition
            .map(|range| {
                let text = slice_utf16(text, range)?;
                Ok(NativeComposition {
                    range: Utf16Range {
                        start: range.start - window_start,
                        end: range.end - window_start,
                    },
                    text: text.to_owned(),
                })
            })
            .transpose()?;

        Ok(NativeTextSnapshot {
            text: window.to_owned(),
            cursor_offset,
            selection,
            analyzable: composition.is_none(),
            composition,
            session: self.session()?,
        })
    }
}

#[derive(Debug)]
struct GuardedWriteProof {
    session: OpaqueSession,
    range: Utf16Range,
    expected_text: String,
    replacement_text: String,
    consumed: bool,
}

impl GuardedWriteProof {
    fn new(
        snapshot: &NativeTextSnapshot,
        range: Utf16Range,
        expected_text: &str,
        replacement_text: &str,
    ) -> Result<Self, ProofError> {
        if snapshot.composition.is_some() {
            return Err(ProofError::CompositionActive);
        }
        range.validate(&snapshot.text)?;
        if slice_utf16(&snapshot.text, range)? != expected_text {
            return Err(ProofError::SourceChanged);
        }
        Ok(Self {
            session: snapshot.session.clone(),
            range,
            expected_text: expected_text.to_owned(),
            replacement_text: replacement_text.to_owned(),
            consumed: false,
        })
    }

    fn apply(&mut self, host: &mut TsfProofHost, current_text: &str) -> Result<String, ProofError> {
        if self.consumed {
            return Err(ProofError::Consumed);
        }
        self.consumed = true;
        if host.composition.is_some() {
            return Err(ProofError::CompositionActive);
        }
        if host.session()? != self.session {
            return Err(ProofError::SessionChanged);
        }
        self.range.validate(current_text)?;
        if slice_utf16(current_text, self.range)? != self.expected_text {
            return Err(ProofError::SourceChanged);
        }

        let start = utf16_to_utf8_boundary(current_text, self.range.start)
            .ok_or(ProofError::InvalidUtf16Boundary)?;
        let end = utf16_to_utf8_boundary(current_text, self.range.end)
            .ok_or(ProofError::InvalidUtf16Boundary)?;
        let mut next =
            String::with_capacity(current_text.len() - (end - start) + self.replacement_text.len());
        next.push_str(&current_text[..start]);
        next.push_str(&self.replacement_text);
        next.push_str(&current_text[end..]);
        host.note_native_edit();
        Ok(next)
    }
}

fn slice_utf16(text: &str, range: Utf16Range) -> Result<&str, ProofError> {
    range.validate(text)?;
    let start =
        utf16_to_utf8_boundary(text, range.start).ok_or(ProofError::InvalidUtf16Boundary)?;
    let end = utf16_to_utf8_boundary(text, range.end).ok_or(ProofError::InvalidUtf16Boundary)?;
    Ok(&text[start..end])
}

fn utf16_to_utf8_boundary(text: &str, offset: usize) -> Option<usize> {
    if offset == 0 {
        return Some(0);
    }
    let mut utf16_offset = 0;
    for (utf8_offset, character) in text.char_indices() {
        if utf16_offset == offset {
            return Some(utf8_offset);
        }
        utf16_offset += character.len_utf16();
        if utf16_offset > offset {
            return None;
        }
    }
    (utf16_offset == offset).then_some(text.len())
}

fn next_utf16_boundary(text: &str, mut offset: usize) -> Option<usize> {
    let total = text.encode_utf16().count();
    while offset <= total {
        if utf16_to_utf8_boundary(text, offset).is_some() {
            return Some(offset);
        }
        offset += 1;
    }
    None
}

fn previous_utf16_boundary(text: &str, mut offset: usize) -> Option<usize> {
    loop {
        if utf16_to_utf8_boundary(text, offset).is_some() {
            return Some(offset);
        }
        if offset == 0 {
            return None;
        }
        offset -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caret(offset: usize) -> NativeSelection {
        NativeSelection {
            range: Utf16Range {
                start: offset,
                end: offset,
            },
            active_end: ActiveEnd::End,
        }
    }

    fn selection(start: usize, end: usize, active_end: ActiveEnd) -> NativeSelection {
        NativeSelection {
            range: Utf16Range { start, end },
            active_end,
        }
    }

    #[test]
    fn composition_is_initially_inactive() {
        let host = TsfProofHost::activate(1, 10);
        assert_eq!(host.composition, None);
        assert_eq!(
            host.callback_action(),
            Ok(CaptureDirective::CaptureCommitted)
        );
    }

    #[test]
    fn composition_start_defers_analysis() {
        let mut host = TsfProofHost::activate(1, 10);
        assert_eq!(
            host.start_composition(Utf16Range { start: 1, end: 2 }),
            Ok(CaptureDirective::DeferWhileComposing)
        );
    }

    #[test]
    fn composition_update_replaces_only_native_range_state() {
        let mut host = TsfProofHost::activate(1, 10);
        host.start_composition(Utf16Range { start: 1, end: 2 })
            .unwrap();
        host.update_composition(Utf16Range { start: 1, end: 3 })
            .unwrap();
        assert_eq!(host.composition, Some(Utf16Range { start: 1, end: 3 }));
    }

    #[test]
    fn composition_range_and_text_are_exact_and_relative_to_capture() {
        let mut host = TsfProofHost::activate(1, 10);
        host.start_composition(Utf16Range { start: 6, end: 8 })
            .unwrap();
        let snapshot = host.capture("before中文after", &[caret(8)], 3, 3).unwrap();
        assert_eq!(snapshot.text, "ore中文aft");
        assert_eq!(
            snapshot.composition.unwrap(),
            NativeComposition {
                range: Utf16Range { start: 3, end: 5 },
                text: "中文".into(),
            }
        );
        assert!(!snapshot.analyzable);
    }

    #[test]
    fn committed_composition_becomes_analyzable_only_after_end() {
        let mut host = TsfProofHost::activate(1, 10);
        host.start_composition(Utf16Range { start: 0, end: 2 })
            .unwrap();
        assert!(!host.capture("中文", &[caret(2)], 8, 8).unwrap().analyzable);
        assert_eq!(
            host.end_composition(true),
            Ok(CaptureDirective::CaptureCommitted)
        );
        assert!(host.capture("中文", &[caret(2)], 8, 8).unwrap().analyzable);
    }

    #[test]
    fn cancelled_composition_is_discarded() {
        let mut host = TsfProofHost::activate(1, 10);
        host.start_composition(Utf16Range { start: 0, end: 1 })
            .unwrap();
        assert_eq!(
            host.end_composition(false),
            Ok(CaptureDirective::DiscardCancelled)
        );
        assert_eq!(host.composition, None);
    }

    #[test]
    fn emoji_composition_uses_utf16_code_units() {
        let mut host = TsfProofHost::activate(1, 10);
        host.start_composition(Utf16Range { start: 1, end: 3 })
            .unwrap();
        let snapshot = host.capture("A😀B", &[caret(3)], 8, 8).unwrap();
        assert_eq!(snapshot.cursor_offset, 3);
        assert_eq!(snapshot.composition.unwrap().text, "😀");
    }

    #[test]
    fn collapsed_selection_maps_to_null_selection_and_caret() {
        let host = TsfProofHost::activate(1, 10);
        let snapshot = host.capture("abcdef", &[caret(3)], 2, 2).unwrap();
        assert_eq!(snapshot.text, "bcde");
        assert_eq!(snapshot.cursor_offset, 2);
        assert_eq!(snapshot.selection, None);
    }

    #[test]
    fn contiguous_selection_and_active_end_map_exactly() {
        let host = TsfProofHost::activate(1, 10);
        let snapshot = host
            .capture(
                "zero selected tail",
                &[selection(5, 13, ActiveEnd::Start)],
                2,
                2,
            )
            .unwrap();
        assert_eq!(snapshot.text, "o selected t");
        assert_eq!(snapshot.selection, Some(Utf16Range { start: 2, end: 10 }));
        assert_eq!(snapshot.cursor_offset, 2);
    }

    #[test]
    fn multiple_selections_are_rejected_instead_of_concatenated() {
        let host = TsfProofHost::activate(1, 10);
        assert_eq!(
            host.capture("abcdef", &[caret(1), caret(4)], 2, 2),
            Err(ProofError::MultipleSelections)
        );
    }

    #[test]
    fn bounded_capture_has_exact_before_and_after_context() {
        let host = TsfProofHost::activate(1, 10);
        let snapshot = host.capture("0123456789", &[caret(5)], 3, 2).unwrap();
        assert_eq!(snapshot.text, "23456");
        assert_eq!(snapshot.cursor_offset, 3);
    }

    #[test]
    fn bounded_capture_never_invents_text_at_document_edges() {
        let host = TsfProofHost::activate(1, 10);
        assert_eq!(host.capture("abc", &[caret(0)], 8, 1).unwrap().text, "a");
        assert_eq!(host.capture("abc", &[caret(3)], 1, 8).unwrap().text, "c");
    }

    #[test]
    fn multiline_and_mixed_language_capture_is_exact() {
        let host = TsfProofHost::activate(1, 10);
        let text = "English\n中文 A😀B\nend";
        let snapshot = host
            .capture(text, &[selection(8, 15, ActiveEnd::End)], 2, 2)
            .unwrap();
        assert_eq!(snapshot.text, "h\n中文 A😀B\ne");
        assert_eq!(snapshot.selection, Some(Utf16Range { start: 2, end: 9 }));
    }

    #[test]
    fn surrounding_bound_does_not_split_an_emoji_surrogate_pair() {
        let host = TsfProofHost::activate(1, 10);
        let snapshot = host.capture("A😀B", &[caret(3)], 1, 1).unwrap();
        assert_eq!(snapshot.text, "B");
        assert_eq!(snapshot.cursor_offset, 0);
    }

    #[test]
    fn same_text_in_a_new_context_has_a_different_session() {
        let mut host = TsfProofHost::activate(1, 10);
        let first = host.capture("same", &[caret(4)], 8, 8).unwrap();
        host.focus_context(1, 11);
        let second = host.capture("same", &[caret(4)], 8, 8).unwrap();
        assert_ne!(first.session, second.session);
    }

    #[test]
    fn native_edit_invalidates_an_older_capture() {
        let mut host = TsfProofHost::activate(1, 10);
        let capture = host.capture("same", &[caret(4)], 8, 8).unwrap();
        host.note_native_edit();
        assert_ne!(capture.session, host.session().unwrap());
    }

    #[test]
    fn current_session_and_exact_expected_text_can_be_replaced() {
        let mut host = TsfProofHost::activate(1, 10);
        let snapshot = host.capture("bad text", &[caret(8)], 8, 8).unwrap();
        let mut write =
            GuardedWriteProof::new(&snapshot, Utf16Range { start: 0, end: 3 }, "bad", "good")
                .unwrap();
        assert_eq!(write.apply(&mut host, "bad text"), Ok("good text".into()));
    }

    #[test]
    fn changed_expected_text_rejects_without_mutation() {
        let mut host = TsfProofHost::activate(1, 10);
        let snapshot = host.capture("bad text", &[caret(8)], 8, 8).unwrap();
        let mut write =
            GuardedWriteProof::new(&snapshot, Utf16Range { start: 0, end: 3 }, "bad", "good")
                .unwrap();
        let current = "new text";
        assert_eq!(
            write.apply(&mut host, current),
            Err(ProofError::SourceChanged)
        );
        assert_eq!(current, "new text");
    }

    #[test]
    fn active_composition_rejects_a_prepared_write() {
        let mut host = TsfProofHost::activate(1, 10);
        let snapshot = host.capture("bad", &[caret(3)], 8, 8).unwrap();
        let mut write =
            GuardedWriteProof::new(&snapshot, Utf16Range { start: 0, end: 3 }, "bad", "good")
                .unwrap();
        host.start_composition(Utf16Range { start: 0, end: 3 })
            .unwrap();
        assert_eq!(
            write.apply(&mut host, "bad"),
            Err(ProofError::CompositionActive)
        );
    }

    #[test]
    fn changed_context_rejects_an_old_write_even_when_text_matches() {
        let mut host = TsfProofHost::activate(1, 10);
        let snapshot = host.capture("same", &[caret(4)], 8, 8).unwrap();
        let mut write =
            GuardedWriteProof::new(&snapshot, Utf16Range { start: 0, end: 4 }, "same", "next")
                .unwrap();
        host.focus_context(2, 20);
        assert_eq!(
            write.apply(&mut host, "same"),
            Err(ProofError::SessionChanged)
        );
    }

    #[test]
    fn consumed_write_cannot_be_used_twice() {
        let mut host = TsfProofHost::activate(1, 10);
        let snapshot = host.capture("one", &[caret(3)], 8, 8).unwrap();
        let mut write =
            GuardedWriteProof::new(&snapshot, Utf16Range { start: 0, end: 3 }, "one", "two")
                .unwrap();
        assert_eq!(write.apply(&mut host, "one"), Ok("two".into()));
        assert_eq!(write.apply(&mut host, "two"), Err(ProofError::Consumed));
    }

    #[test]
    fn old_capture_cannot_mutate_a_new_native_generation() {
        let mut host = TsfProofHost::activate(1, 10);
        let snapshot = host.capture("one", &[caret(3)], 8, 8).unwrap();
        let mut write =
            GuardedWriteProof::new(&snapshot, Utf16Range { start: 0, end: 3 }, "one", "two")
                .unwrap();
        host.note_native_edit();
        assert_eq!(
            write.apply(&mut host, "one"),
            Err(ProofError::SessionChanged)
        );
    }

    #[test]
    fn formatted_snapshots_sessions_and_errors_do_not_disclose_source() {
        let source = "top-secret-source";
        let host = TsfProofHost::activate(1, 10);
        let snapshot = host.capture(source, &[caret(3)], 30, 30).unwrap();
        assert!(!format!("{snapshot:?}").contains(source));
        assert!(!format!("{:?}", snapshot.session).contains('1'));
        assert!(!ProofError::SourceChanged.to_string().contains(source));
    }

    #[test]
    fn composition_callbacks_retain_no_source_or_composition_text() {
        let mut host = TsfProofHost::activate(1, 10);
        host.start_composition(Utf16Range { start: 0, end: 2 })
            .unwrap();
        let formatted = format!("{host:?}");
        assert!(!formatted.contains("中文"));
        assert!(!formatted.contains("private"));
    }

    #[test]
    fn deactivated_host_rejects_late_callbacks_and_captures() {
        let mut host = TsfProofHost::activate(1, 10);
        host.deactivate();
        assert_eq!(host.callback_action(), Err(ProofError::Deactivated));
        assert_eq!(
            host.capture("late", &[caret(0)], 8, 8),
            Err(ProofError::Deactivated)
        );
    }

    #[test]
    fn callback_path_only_requests_local_capture_work() {
        let host = TsfProofHost::activate(1, 10);
        assert_eq!(
            host.callback_action(),
            Ok(CaptureDirective::CaptureCommitted)
        );
    }
}

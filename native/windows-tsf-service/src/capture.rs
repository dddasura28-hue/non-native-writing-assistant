use std::fmt;
use std::mem::ManuallyDrop;
use windows::core::Interface;
use windows::Win32::UI::TextServices::{
    ITfContext, ITfContextComposition, ITfRange, GUID_PROP_COMPOSING, TF_AE_END, TF_AE_START,
    TF_ANCHOR_END, TF_ANCHOR_START, TF_SELECTION, TF_TF_MOVESTART,
};

const SURROUNDING_LIMIT: i32 = 2048;
const SELECTION_LIMIT: usize = 16 * 1024;
const WINDOW_LIMIT: usize = SELECTION_LIMIT + (SURROUNDING_LIMIT as usize * 2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Utf16Range {
    pub start: usize,
    pub end: usize,
}

impl Utf16Range {
    #[cfg(test)]
    fn validate(self, total: usize) -> Result<(), CaptureError> {
        if self.start <= self.end && self.end <= total {
            Ok(())
        } else {
            Err(CaptureError::InvalidRange)
        }
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveEnd {
    Start,
    End,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeSelection {
    pub range: Utf16Range,
    pub active_end: ActiveEnd,
}

#[derive(Clone, PartialEq, Eq)]
pub struct NativeComposition {
    pub range: Utf16Range,
    pub text_utf16: Vec<u16>,
}

impl fmt::Debug for NativeComposition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeComposition")
            .field("range", &self.range)
            .field("text_units", &self.text_utf16.len())
            .finish()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct OpaqueSession {
    pub(crate) document_identity: usize,
    pub(crate) context_identity: usize,
    pub generation: u64,
}

impl fmt::Debug for OpaqueSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpaqueSession")
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct NativeTextSnapshot {
    pub text_utf16: Vec<u16>,
    pub cursor_offset: usize,
    pub selection: Option<Utf16Range>,
    pub composition: Option<NativeComposition>,
    pub analyzable: bool,
    pub session: OpaqueSession,
}

impl fmt::Debug for NativeTextSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeTextSnapshot")
            .field("text_units", &self.text_utf16.len())
            .field("cursor_offset", &self.cursor_offset)
            .field("selection", &self.selection)
            .field("composition", &self.composition)
            .field("analyzable", &self.analyzable)
            .field("session", &self.session)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureError {
    WindowsFailure,
    MissingSelection,
    MultipleSelections,
    DiscontinuousRange,
    UnsupportedActiveEnd,
    #[cfg(test)]
    InvalidRange,
    CaptureTooLarge,
    MultipleCompositions,
    CompositionOutsideWindow,
}

impl fmt::Display for CaptureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::WindowsFailure => "Windows text service operation failed",
            Self::MissingSelection => "no active selection was available",
            Self::MultipleSelections => "multiple selections are not supported by this prototype",
            Self::DiscontinuousRange => "a discontinuous text range is unsupported",
            Self::UnsupportedActiveEnd => "the selection active end is unsupported",
            #[cfg(test)]
            Self::InvalidRange => "the text range was invalid",
            Self::CaptureTooLarge => "the requested text window exceeded the prototype bound",
            Self::MultipleCompositions => {
                "multiple compositions are not supported by this prototype"
            }
            Self::CompositionOutsideWindow => {
                "the composition was outside the captured text window"
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for CaptureError {}

impl From<windows::core::Error> for CaptureError {
    fn from(_: windows::core::Error) -> Self {
        Self::WindowsFailure
    }
}

fn require_single_selection(count: u32) -> Result<(), CaptureError> {
    match count {
        0 => Err(CaptureError::MissingSelection),
        1 => Ok(()),
        _ => Err(CaptureError::MultipleSelections),
    }
}

#[cfg(test)]
pub fn capture_from_utf16(
    text_utf16: &[u16],
    selection: NativeSelection,
    composition: Option<Utf16Range>,
    before_limit: usize,
    after_limit: usize,
    session: OpaqueSession,
) -> Result<NativeTextSnapshot, CaptureError> {
    selection.range.validate(text_utf16.len())?;
    if let Some(range) = composition {
        range.validate(text_utf16.len())?;
    }

    let target_start = composition
        .map(|range| range.start.min(selection.range.start))
        .unwrap_or(selection.range.start);
    let target_end = composition
        .map(|range| range.end.max(selection.range.end))
        .unwrap_or(selection.range.end);
    let window_start = target_start.saturating_sub(before_limit);
    let window_end = target_end.saturating_add(after_limit).min(text_utf16.len());
    let mapped_selection = Utf16Range {
        start: selection.range.start - window_start,
        end: selection.range.end - window_start,
    };
    let cursor_offset = match selection.active_end {
        ActiveEnd::Start => mapped_selection.start,
        ActiveEnd::End => mapped_selection.end,
    };
    let mapped_composition = composition.map(|range| NativeComposition {
        range: Utf16Range {
            start: range.start - window_start,
            end: range.end - window_start,
        },
        text_utf16: text_utf16[range.start..range.end].to_vec(),
    });

    Ok(NativeTextSnapshot {
        text_utf16: text_utf16[window_start..window_end].to_vec(),
        cursor_offset,
        selection: (mapped_selection.start != mapped_selection.end).then_some(mapped_selection),
        analyzable: mapped_composition.is_none(),
        composition: mapped_composition,
        session,
    })
}

pub(crate) unsafe fn capture_context(
    context: &ITfContext,
    edit_cookie: u32,
    document_identity: usize,
    generation: u64,
) -> Result<NativeTextSnapshot, CaptureError> {
    let mut raw_selections = [TF_SELECTION::default(), TF_SELECTION::default()];
    let mut fetched = 0;
    let get_selection =
        unsafe { context.GetSelection(edit_cookie, 0, &mut raw_selections, &mut fetched) };

    let mut ranges = Vec::new();
    for selection in &mut raw_selections {
        let range = unsafe { ManuallyDrop::take(&mut selection.range) };
        ranges.push((range, selection.style));
    }
    get_selection.map_err(CaptureError::from)?;

    require_single_selection(fetched)?;
    let (selection_range, selection_style) = ranges
        .into_iter()
        .next()
        .and_then(|(range, style)| range.map(|range| (range, style)))
        .ok_or(CaptureError::MissingSelection)?;

    let before_range = unsafe { selection_range.Clone()? };
    unsafe {
        before_range.Collapse(edit_cookie, TF_ANCHOR_START)?;
        before_range.ShiftStart(
            edit_cookie,
            -SURROUNDING_LIMIT,
            std::ptr::null_mut(),
            std::ptr::null(),
        )?;
    }
    let selected_range = unsafe { selection_range.Clone()? };
    let after_range = unsafe { selection_range.Clone()? };
    unsafe {
        after_range.Collapse(edit_cookie, TF_ANCHOR_END)?;
        after_range.ShiftEnd(
            edit_cookie,
            SURROUNDING_LIMIT,
            std::ptr::null_mut(),
            std::ptr::null(),
        )?;
    }

    let before =
        unsafe { read_range_utf16(&before_range, edit_cookie, SURROUNDING_LIMIT as usize)? };
    let selected = unsafe { read_range_utf16(&selected_range, edit_cookie, SELECTION_LIMIT)? };
    let after = unsafe { read_range_utf16(&after_range, edit_cookie, SURROUNDING_LIMIT as usize)? };
    let selection = Utf16Range {
        start: before.len(),
        end: before.len() + selected.len(),
    };
    let cursor_offset = if selection.start == selection.end || selection_style.ase == TF_AE_END {
        selection.end
    } else if selection_style.ase == TF_AE_START {
        selection.start
    } else {
        return Err(CaptureError::UnsupportedActiveEnd);
    };

    let window_range = unsafe { before_range.Clone()? };
    unsafe { window_range.ShiftEndToRange(edit_cookie, &after_range, TF_ANCHOR_END)? };
    let composition = unsafe { capture_composition(context, edit_cookie, &window_range)? };

    let mut text_utf16 = Vec::with_capacity(before.len() + selected.len() + after.len());
    text_utf16.extend_from_slice(&before);
    text_utf16.extend_from_slice(&selected);
    text_utf16.extend_from_slice(&after);

    Ok(NativeTextSnapshot {
        text_utf16,
        cursor_offset,
        selection: (selection.start != selection.end).then_some(selection),
        analyzable: composition.is_none(),
        composition,
        session: OpaqueSession {
            document_identity,
            context_identity: context.as_raw() as usize,
            generation,
        },
    })
}

unsafe fn capture_composition(
    context: &ITfContext,
    edit_cookie: u32,
    window_range: &ITfRange,
) -> Result<Option<NativeComposition>, CaptureError> {
    // Querying GUID_PROP_COMPOSING proves that the property surface is present. Enumeration through
    // ITfContextComposition supplies a stable composition range without retaining property values.
    let _ = unsafe { context.GetProperty(&GUID_PROP_COMPOSING) };
    let composition_context: ITfContextComposition =
        context.cast().map_err(|_| CaptureError::WindowsFailure)?;
    let enumerator = unsafe { composition_context.EnumCompositions()? };
    let mut views = [None, None];
    let mut fetched = 0;
    unsafe { enumerator.Next(&mut views, &mut fetched)? };
    if fetched == 0 {
        return Ok(None);
    }
    if fetched != 1 {
        return Err(CaptureError::MultipleCompositions);
    }

    let view = views[0].take().ok_or(CaptureError::WindowsFailure)?;
    let range = unsafe { view.GetRange()? };
    let starts_before_window =
        unsafe { window_range.CompareStart(edit_cookie, &range, TF_ANCHOR_START)? > 0 };
    let ends_after_window =
        unsafe { window_range.CompareEnd(edit_cookie, &range, TF_ANCHOR_END)? < 0 };
    if starts_before_window || ends_after_window {
        return Err(CaptureError::CompositionOutsideWindow);
    }

    let prefix = unsafe { window_range.Clone()? };
    unsafe { prefix.ShiftEndToRange(edit_cookie, &range, TF_ANCHOR_START)? };
    let prefix_text = unsafe { read_range_utf16(&prefix, edit_cookie, WINDOW_LIMIT)? };
    let composition_text = unsafe { read_range_utf16(&range, edit_cookie, SELECTION_LIMIT)? };
    let start = prefix_text.len();
    Ok(Some(NativeComposition {
        range: Utf16Range {
            start,
            end: start + composition_text.len(),
        },
        text_utf16: composition_text,
    }))
}

unsafe fn read_range_utf16(
    range: &ITfRange,
    edit_cookie: u32,
    limit: usize,
) -> Result<Vec<u16>, CaptureError> {
    let reader = unsafe { range.Clone()? };
    let mut output = Vec::new();
    let mut chunk = [0u16; 256];

    while output.len() < limit {
        let remaining = limit - output.len();
        let buffer_len = remaining.min(chunk.len());
        let mut read = 0;
        unsafe {
            reader.GetText(
                edit_cookie,
                TF_TF_MOVESTART,
                &mut chunk[..buffer_len],
                &mut read,
            )?;
        }
        if read == 0 {
            return if unsafe { reader.IsEmpty(edit_cookie)?.as_bool() } {
                Ok(output)
            } else {
                Err(CaptureError::DiscontinuousRange)
            };
        }
        output.extend_from_slice(&chunk[..read as usize]);
    }

    let mut extra = [0u16; 1];
    let mut extra_read = 0;
    unsafe {
        reader.GetText(edit_cookie, TF_TF_MOVESTART, &mut extra, &mut extra_read)?;
    }
    if extra_read == 0 {
        if unsafe { reader.IsEmpty(edit_cookie)?.as_bool() } {
            Ok(output)
        } else {
            Err(CaptureError::DiscontinuousRange)
        }
    } else {
        Err(CaptureError::CaptureTooLarge)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(generation: u64) -> OpaqueSession {
        OpaqueSession {
            document_identity: 0x5678,
            context_identity: 0x1234,
            generation,
        }
    }

    fn utf16(value: &str) -> Vec<u16> {
        value.encode_utf16().collect()
    }

    #[test]
    fn collapsed_selection_maps_to_caret_and_no_selection() {
        let snapshot = capture_from_utf16(
            &utf16("abcdef"),
            NativeSelection {
                range: Utf16Range { start: 3, end: 3 },
                active_end: ActiveEnd::End,
            },
            None,
            2,
            2,
            session(1),
        )
        .unwrap();
        assert_eq!(snapshot.text_utf16, utf16("bcde"));
        assert_eq!(snapshot.cursor_offset, 2);
        assert_eq!(snapshot.selection, None);
    }

    #[test]
    fn contiguous_selection_maps_exactly() {
        let snapshot = capture_from_utf16(
            &utf16("zero selected tail"),
            NativeSelection {
                range: Utf16Range { start: 5, end: 13 },
                active_end: ActiveEnd::Start,
            },
            None,
            2,
            2,
            session(2),
        )
        .unwrap();
        assert_eq!(snapshot.text_utf16, utf16("o selected t"));
        assert_eq!(snapshot.selection, Some(Utf16Range { start: 2, end: 10 }));
        assert_eq!(snapshot.cursor_offset, 2);
    }

    #[test]
    fn multiline_chinese_emoji_and_mixed_text_keep_utf16_offsets() {
        let text = utf16("English\n中文 A😀B\nend");
        let snapshot = capture_from_utf16(
            &text,
            NativeSelection {
                range: Utf16Range { start: 8, end: 15 },
                active_end: ActiveEnd::End,
            },
            Some(Utf16Range { start: 10, end: 12 }),
            2,
            2,
            session(3),
        )
        .unwrap();
        assert_eq!(snapshot.text_utf16, utf16("h\n中文 A😀B\ne"));
        assert_eq!(snapshot.cursor_offset, 9);
        assert_eq!(snapshot.composition.unwrap().text_utf16, utf16(" A"));
        assert!(!snapshot.analyzable);
    }

    #[test]
    fn emoji_uses_two_utf16_code_units() {
        let snapshot = capture_from_utf16(
            &utf16("A😀B"),
            NativeSelection {
                range: Utf16Range { start: 3, end: 3 },
                active_end: ActiveEnd::End,
            },
            Some(Utf16Range { start: 1, end: 3 }),
            8,
            8,
            session(4),
        )
        .unwrap();
        assert_eq!(snapshot.cursor_offset, 3);
        assert_eq!(
            snapshot.composition.unwrap().range,
            Utf16Range { start: 1, end: 3 }
        );
    }

    #[test]
    fn invalid_and_disjoint_ranges_are_rejected() {
        let text = utf16("abc");
        let result = capture_from_utf16(
            &text,
            NativeSelection {
                range: Utf16Range { start: 3, end: 2 },
                active_end: ActiveEnd::End,
            },
            None,
            1,
            1,
            session(5),
        );
        assert_eq!(result, Err(CaptureError::InvalidRange));
    }

    #[test]
    fn snapshot_debug_does_not_disclose_text() {
        let source = "top-secret-source 中文";
        let snapshot = capture_from_utf16(
            &utf16(source),
            NativeSelection {
                range: Utf16Range { start: 1, end: 1 },
                active_end: ActiveEnd::End,
            },
            None,
            30,
            30,
            session(6),
        )
        .unwrap();
        let formatted = format!("{snapshot:?}");
        assert!(!formatted.contains(source));
        assert!(!formatted.contains("中文"));
        assert!(!formatted.contains("0x1234"));
    }

    #[test]
    fn stale_generation_changes_opaque_session_identity() {
        assert_ne!(session(1), session(2));
    }

    #[test]
    fn equal_text_in_a_new_document_or_context_is_a_different_session() {
        let first = session(1);
        let mut new_document = first;
        new_document.document_identity = 0x9999;
        let mut new_context = first;
        new_context.context_identity = 0x8888;
        assert_ne!(first, new_document);
        assert_ne!(first, new_context);
    }

    #[test]
    fn capture_at_document_edges_invents_no_text() {
        let text = utf16("abc");
        let start = capture_from_utf16(
            &text,
            NativeSelection {
                range: Utf16Range { start: 0, end: 0 },
                active_end: ActiveEnd::End,
            },
            None,
            50,
            1,
            session(8),
        )
        .unwrap();
        let end = capture_from_utf16(
            &text,
            NativeSelection {
                range: Utf16Range { start: 3, end: 3 },
                active_end: ActiveEnd::End,
            },
            None,
            1,
            50,
            session(9),
        )
        .unwrap();
        assert_eq!(start.text_utf16, utf16("a"));
        assert_eq!(end.text_utf16, utf16("c"));
    }

    #[test]
    fn composition_update_then_end_or_cancel_has_no_retained_state() {
        let text = utf16("A中文B");
        let selection = NativeSelection {
            range: Utf16Range { start: 3, end: 3 },
            active_end: ActiveEnd::End,
        };
        let started = capture_from_utf16(
            &text,
            selection,
            Some(Utf16Range { start: 1, end: 2 }),
            8,
            8,
            session(10),
        )
        .unwrap();
        let updated = capture_from_utf16(
            &text,
            selection,
            Some(Utf16Range { start: 1, end: 3 }),
            8,
            8,
            session(11),
        )
        .unwrap();
        let inactive = capture_from_utf16(&text, selection, None, 8, 8, session(12)).unwrap();
        assert_eq!(
            started.composition.unwrap().range,
            Utf16Range { start: 1, end: 2 }
        );
        assert_eq!(
            updated.composition.unwrap().range,
            Utf16Range { start: 1, end: 3 }
        );
        assert!(inactive.composition.is_none());
        assert!(inactive.analyzable);
    }

    #[test]
    fn formatted_errors_do_not_contain_source_text() {
        let source = "private source";
        assert!(!CaptureError::InvalidRange.to_string().contains(source));
    }

    #[test]
    fn multiple_native_selections_are_rejected() {
        assert_eq!(
            require_single_selection(2),
            Err(CaptureError::MultipleSelections)
        );
    }

    #[test]
    fn inactive_composition_is_analyzable() {
        let snapshot = capture_from_utf16(
            &utf16("ordinary English"),
            NativeSelection {
                range: Utf16Range { start: 8, end: 8 },
                active_end: ActiveEnd::End,
            },
            None,
            8,
            8,
            session(7),
        )
        .unwrap();
        assert!(snapshot.analyzable);
        assert!(snapshot.composition.is_none());
    }
}

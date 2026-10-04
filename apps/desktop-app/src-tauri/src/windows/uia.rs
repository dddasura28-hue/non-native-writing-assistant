use super::boundary::{verify_range_ownership, VerifiedEditableTextDomain};
use super::geometry::{
    adjacent_caret_anchor, selection_anchor, AdjacentCaretSide, ExternalTextAnchor,
};
use super::model::{
    build_capture, qualify_focused_element, unavailable, ElementFacts, FocusedControlType,
    NativeTextRange, WindowsCaptureUnavailableReason as Unavailable,
    WindowsTextSurfaceCaptureResponse, CONTEXT_CHARACTERS_PER_SIDE,
};
use crate::global_diagnostics::{record, Details, Outcome, Stage};
use windows::core::{Interface, BOOL, BSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    SAFEARRAY,
};
use windows::Win32::System::Ole::{
    SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetElement, SafeArrayGetElemsize,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextEditPattern,
    IUIAutomationTextPattern, IUIAutomationTextPattern2, IUIAutomationTextRange,
    IUIAutomationValuePattern, TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start,
    TextUnit_Character, UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_TextEditPatternId,
    UIA_TextPattern2Id, UIA_TextPatternId, UIA_ValuePatternId,
};

const MAX_BOUNDING_VALUES: usize = 256 * 4;

pub fn capture_active_text_surface(
    invocation_id: u64,
    token: String,
) -> WindowsTextSurfaceCaptureResponse {
    let initialized_result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let initialized = initialized_result.is_ok();
    record(
        Some(invocation_id),
        Stage::ComInitialize,
        if initialized {
            Outcome::Succeeded
        } else {
            Outcome::Failed
        },
        Details {
            hresult: Some(initialized_result.0),
            ..Details::default()
        },
    );
    if !initialized {
        return unavailable(Unavailable::NativeUiaUnavailable);
    }
    let result = capture_initialized(invocation_id, token);
    unsafe { CoUninitialize() };
    result.unwrap_or_else(unavailable)
}

fn capture_initialized(
    invocation_id: u64,
    token: String,
) -> Result<WindowsTextSurfaceCaptureResponse, Unavailable> {
    let automation: IUIAutomation = observe_query(
        invocation_id,
        Stage::UiaClient,
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) },
        |_| Details::default(),
    )
    .map_err(|_| Unavailable::NativeUiaUnavailable)?;
    let element = observe_query(
        invocation_id,
        Stage::FocusedElement,
        unsafe { automation.GetFocusedElement() },
        |_| Details::default(),
    )
    .map_err(|_| Unavailable::NoFocusedElement)?;

    let process_id = observe_query(
        invocation_id,
        Stage::OwnProcess,
        unsafe { element.CurrentProcessId() },
        |value| Details {
            value: Some(*value == std::process::id() as i32),
            ..Details::default()
        },
    )
    .map_err(|_| Unavailable::ElementDisappeared)?;
    if process_id == std::process::id() as i32 {
        record(
            Some(invocation_id),
            Stage::Qualification,
            Outcome::Rejected,
            Details {
                reason: Some(Unavailable::OwnProcess),
                ..Details::default()
            },
        );
        return Err(Unavailable::OwnProcess);
    }
    let protected = observe_query(
        invocation_id,
        Stage::Protected,
        unsafe { element.CurrentIsPassword() },
        boolean_details,
    )
    .map_err(|_| Unavailable::ElementDisappeared)?
    .as_bool();
    let enabled = observe_query(
        invocation_id,
        Stage::Enabled,
        unsafe { element.CurrentIsEnabled() },
        boolean_details,
    )
    .map_err(|_| Unavailable::ElementDisappeared)?
    .as_bool();
    let has_keyboard_focus = observe_query(
        invocation_id,
        Stage::KeyboardFocus,
        unsafe { element.CurrentHasKeyboardFocus() },
        boolean_details,
    )
    .map_err(|_| Unavailable::ElementDisappeared)?
    .as_bool();
    let keyboard_focusable = observe_query(
        invocation_id,
        Stage::KeyboardFocusable,
        unsafe { element.CurrentIsKeyboardFocusable() },
        boolean_details,
    )
    .map_err(|_| Unavailable::ElementDisappeared)?
    .as_bool();
    let control_type = match observe_query(
        invocation_id,
        Stage::ControlType,
        unsafe { element.CurrentControlType() },
        |value| Details {
            control_type: Some(value.0),
            ..Details::default()
        },
    )
    .map_err(|_| Unavailable::ElementDisappeared)?
    {
        value if value == UIA_EditControlTypeId => FocusedControlType::Edit,
        value if value == UIA_DocumentControlTypeId => FocusedControlType::Document,
        _ => FocusedControlType::Other,
    };
    let text_edit_pattern = observe_pattern(invocation_id, Stage::TextEditPattern, unsafe {
        element.GetCurrentPatternAs::<IUIAutomationTextEditPattern>(UIA_TextEditPatternId)
    });
    let text_pattern2 = observe_pattern(invocation_id, Stage::TextPattern2, unsafe {
        element.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id)
    });
    let text_pattern = text_pattern2
        .as_ref()
        .and_then(|pattern| pattern.cast::<IUIAutomationTextPattern>().ok())
        .or_else(|| {
            unsafe { element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }
                .ok()
        })
        .or_else(|| {
            text_edit_pattern
                .as_ref()
                .and_then(|pattern| pattern.cast::<IUIAutomationTextPattern>().ok())
        });
    record(
        Some(invocation_id),
        Stage::TextPattern,
        if text_pattern.is_some() {
            Outcome::Available
        } else {
            Outcome::Unavailable
        },
        Details {
            value: Some(text_pattern.is_some()),
            ..Details::default()
        },
    );
    let value_pattern = observe_pattern(invocation_id, Stage::ValuePattern, unsafe {
        element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
    });
    let value_pattern_read_only = value_pattern.as_ref().map(|pattern| {
        observe_query(
            invocation_id,
            Stage::ValueReadOnly,
            unsafe { pattern.CurrentIsReadOnly() },
            boolean_details,
        )
        .map(|read_only| read_only.as_bool())
        .unwrap_or(true)
    });
    if value_pattern.is_none() {
        record(
            Some(invocation_id),
            Stage::ValueReadOnly,
            Outcome::Skipped,
            Details::default(),
        );
    }

    let qualification = qualify_focused_element(ElementFacts {
        own_process: false,
        protected,
        enabled,
        has_keyboard_focus,
        keyboard_focusable,
        control_type,
        has_text_pattern: text_pattern.is_some(),
        has_text_edit_pattern: text_edit_pattern.is_some(),
        value_pattern_read_only,
    });
    record(
        Some(invocation_id),
        Stage::Qualification,
        if qualification.is_ok() {
            Outcome::Qualified
        } else {
            Outcome::Rejected
        },
        Details {
            reason: qualification.err(),
            ..Details::default()
        },
    );
    qualification?;

    let text_pattern = text_pattern.ok_or(Unavailable::UnsupportedTextPattern)?;
    let result = capture_verified_surface(
        invocation_id,
        &automation,
        &element,
        &text_pattern,
        text_pattern2.as_ref(),
        value_pattern.as_ref(),
        token,
    );
    record(
        Some(invocation_id),
        Stage::BoundaryResult,
        if result.is_ok() {
            Outcome::Verified
        } else {
            Outcome::Rejected
        },
        Details {
            reason: result.as_ref().err().copied(),
            ..Details::default()
        },
    );
    result
}

fn read_value(id: u64, pattern: &IUIAutomationValuePattern) -> Result<String, Unavailable> {
    let value = observe_query(
        id,
        Stage::ValuePatternLength,
        unsafe { pattern.CurrentValue() },
        |value| Details {
            utf16_length: Some(value.len()),
            ..Details::default()
        },
    )
    .map_err(|_| Unavailable::AmbiguousEditableDomain)?;
    String::try_from(value).map_err(|_| Unavailable::AmbiguousEditableDomain)
}

fn capture_verified_surface(
    id: u64,
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
    text_pattern: &IUIAutomationTextPattern,
    text_pattern2: Option<&IUIAutomationTextPattern2>,
    value_pattern: Option<&IUIAutomationValuePattern>,
    token: String,
) -> Result<WindowsTextSurfaceCaptureResponse, Unavailable> {
    record(
        Some(id),
        Stage::EditableDomain,
        Outcome::Attempted,
        Details::default(),
    );
    // Qualification already rejected read-only ValuePatterns. TextEdit alone
    // does not independently prove ownership of the provider's document text.
    let value_pattern = value_pattern.ok_or(Unavailable::AmbiguousEditableDomain)?;
    let value = read_value(id, value_pattern)?;
    let range = observe_query(
        id,
        Stage::EditableDomain,
        unsafe { text_pattern.DocumentRange() },
        |_| Details::default(),
    )
    .map_err(|_| Unavailable::AmbiguousEditableDomain)?;
    if !range_owned_by_focused(automation, element, &range)? {
        return Err(Unavailable::AmbiguousEditableDomain);
    }
    let provider_text = range_text(&range)?;
    record(
        Some(id),
        Stage::TextDomainLength,
        Outcome::Succeeded,
        Details {
            utf16_length: Some(super::model::utf16_len(&provider_text)),
            ..Details::default()
        },
    );
    let proof = VerifiedEditableTextDomain::verify(Some(&value), &provider_text);
    record(
        Some(id),
        Stage::DomainConsistency,
        if proof.is_ok() {
            Outcome::Matched
        } else {
            Outcome::Mismatch
        },
        Details::default(),
    );
    let domain = VerifiedProviderDomain {
        automation,
        element,
        range,
        text: proof?,
    };
    domain
        .validate_range(&domain.range)
        .map_err(|_| Unavailable::AmbiguousEditableDomain)?;
    let caret = active_caret(text_pattern2);
    record(
        Some(id),
        Stage::CaretAvailable,
        if caret.is_some() {
            Outcome::Available
        } else {
            Outcome::Unavailable
        },
        Details {
            value: Some(caret.is_some()),
            ..Details::default()
        },
    );
    if let Some(caret) = &caret {
        domain.validate_range(caret)?;
        if !is_degenerate(caret)? {
            return Err(Unavailable::UnsupportedSelection);
        }
    }
    let selections = read_selections(text_pattern, caret.is_some())?;
    for selection in &selections {
        domain.validate_range(selection)?;
    }

    let capture = match selections.as_slice() {
        [selection] if !is_degenerate(selection)? => {
            capture_exact_selection(&domain, selection, caret.as_ref(), token)?
        }
        [selection] => {
            if let Some(caret) = &caret {
                if compare_endpoints(
                    selection,
                    TextPatternRangeEndpoint_Start,
                    caret,
                    TextPatternRangeEndpoint_Start,
                )? != 0
                {
                    return Err(Unavailable::UnsupportedSelection);
                }
            }
            let anchor = caret.as_ref().unwrap_or(selection);
            capture_around_caret(&domain, anchor, true, true, token)?
        }
        [] => {
            let anchor = caret.as_ref().ok_or(Unavailable::MissingCaret)?;
            capture_around_caret(&domain, anchor, false, true, token)?
        }
        _ => {
            let anchor = caret.as_ref().ok_or(Unavailable::MultipleSelection)?;
            capture_around_caret(&domain, anchor, false, false, token)?
        }
    };

    // Detect provider mutation during native range/geometry work. Never return
    // text from a previously verified but now inconsistent live UIA domain.
    let current_value = read_value(id, value_pattern)?;
    let current_text = range_text(&domain.range)?;
    let currentness = domain.text.verify_current(&current_value, &current_text);
    record(
        Some(id),
        Stage::DomainConsistency,
        if currentness.is_ok() {
            Outcome::Matched
        } else {
            Outcome::Mismatch
        },
        Details::default(),
    );
    currentness?;
    Ok(WindowsTextSurfaceCaptureResponse::Captured { capture })
}

struct VerifiedProviderDomain<'a> {
    automation: &'a IUIAutomation,
    element: &'a IUIAutomationElement,
    range: IUIAutomationTextRange,
    text: VerifiedEditableTextDomain<'a>,
}

impl VerifiedProviderDomain<'_> {
    fn validate_range(&self, range: &IUIAutomationTextRange) -> Result<(), Unavailable> {
        let same = range_owned_by_focused(self.automation, self.element, range)?;
        verify_range_ownership(
            same,
            compare_endpoints(
                range,
                TextPatternRangeEndpoint_Start,
                &self.range,
                TextPatternRangeEndpoint_Start,
            )?,
            compare_endpoints(
                range,
                TextPatternRangeEndpoint_End,
                &self.range,
                TextPatternRangeEndpoint_End,
            )?,
            compare_endpoints(
                range,
                TextPatternRangeEndpoint_Start,
                range,
                TextPatternRangeEndpoint_End,
            )?,
        )
    }

    fn offset(
        &self,
        point: &IUIAutomationTextRange,
        endpoint: windows::Win32::UI::Accessibility::TextPatternRangeEndpoint,
    ) -> Result<usize, Unavailable> {
        self.validate_range(point)?;
        let prefix = unsafe { self.range.Clone() }.map_err(|_| Unavailable::ElementDisappeared)?;
        unsafe { prefix.MoveEndpointByRange(TextPatternRangeEndpoint_End, point, endpoint) }
            .map_err(|_| Unavailable::UnsupportedSelection)?;
        self.validate_range(&prefix)?;
        let text = range_text(&prefix)?;
        let end = super::model::utf16_len(&text);
        self.text
            .validate_range_text(NativeTextRange { start: 0, end }, &text)?;
        Ok(end)
    }

    fn validate_text(
        &self,
        range: &IUIAutomationTextRange,
        text: &str,
    ) -> Result<NativeTextRange, Unavailable> {
        let offsets = NativeTextRange {
            start: self.offset(range, TextPatternRangeEndpoint_Start)?,
            end: self.offset(range, TextPatternRangeEndpoint_End)?,
        };
        self.text.validate_range_text(offsets, text)?;
        Ok(offsets)
    }
}

fn range_owned_by_focused(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
    range: &IUIAutomationTextRange,
) -> Result<bool, Unavailable> {
    let owner =
        unsafe { range.GetEnclosingElement() }.map_err(|_| Unavailable::UnsupportedSelection)?;
    unsafe { automation.CompareElements(&owner, element) }
        .map(|same| same.as_bool())
        .map_err(|_| Unavailable::UnsupportedSelection)
}

fn compare_endpoints(
    range: &IUIAutomationTextRange,
    endpoint: windows::Win32::UI::Accessibility::TextPatternRangeEndpoint,
    other: &IUIAutomationTextRange,
    other_endpoint: windows::Win32::UI::Accessibility::TextPatternRangeEndpoint,
) -> Result<i32, Unavailable> {
    unsafe { range.CompareEndpoints(endpoint, other, other_endpoint) }
        .map_err(|_| Unavailable::UnsupportedSelection)
}

fn boolean_details(value: &BOOL) -> Details {
    Details {
        value: Some(value.as_bool()),
        ..Details::default()
    }
}

fn observe_query<T>(
    id: u64,
    stage: Stage,
    result: windows::core::Result<T>,
    details: impl FnOnce(&T) -> Details,
) -> windows::core::Result<T> {
    match &result {
        Ok(value) => record(Some(id), stage, Outcome::Succeeded, details(value)),
        Err(error) => record(
            Some(id),
            stage,
            Outcome::Failed,
            Details {
                hresult: Some(error.code().0),
                ..Details::default()
            },
        ),
    }
    result
}

fn observe_pattern<T>(id: u64, stage: Stage, result: windows::core::Result<T>) -> Option<T> {
    record(
        Some(id),
        stage,
        if result.is_ok() {
            Outcome::Available
        } else {
            Outcome::Unavailable
        },
        Details {
            value: Some(result.is_ok()),
            hresult: result.as_ref().err().map(|error| error.code().0),
            ..Details::default()
        },
    );
    result.ok()
}

fn active_caret(pattern: Option<&IUIAutomationTextPattern2>) -> Option<IUIAutomationTextRange> {
    let pattern = pattern?;
    let mut active = BOOL::default();
    let range = unsafe { pattern.GetCaretRange(&mut active) }.ok()?;
    active.as_bool().then_some(range)
}

fn read_selections(
    pattern: &IUIAutomationTextPattern,
    caret_available: bool,
) -> Result<Vec<IUIAutomationTextRange>, Unavailable> {
    let array = match unsafe { pattern.GetSelection() } {
        Ok(array) => array,
        Err(_) if caret_available => return Ok(Vec::new()),
        Err(_) => return Err(Unavailable::SelectionUnavailable),
    };
    let length = unsafe { array.Length() }.map_err(|_| Unavailable::ElementDisappeared)?;
    if length < 0 {
        return Err(Unavailable::ElementDisappeared);
    }
    (0..length)
        .map(|index| {
            unsafe { array.GetElement(index) }.map_err(|_| Unavailable::ElementDisappeared)
        })
        .collect()
}

fn capture_exact_selection(
    domain: &VerifiedProviderDomain<'_>,
    selection: &IUIAutomationTextRange,
    caret: Option<&IUIAutomationTextRange>,
    token: String,
) -> Result<super::model::WindowsTextSurfaceCapture, Unavailable> {
    let text = range_text(selection)?;
    let text_len = super::model::utf16_len(&text);
    let offsets = domain.validate_text(selection, &text)?;
    let cursor = if let Some(caret) = caret {
        let point = domain.offset(caret, TextPatternRangeEndpoint_Start)?;
        if point < offsets.start || point > offsets.end {
            return Err(Unavailable::UnsupportedSelection);
        }
        point - offsets.start
    } else {
        // A truthful contiguous selection is sufficient; no insertion point is
        // fabricated for a ValuePattern-only control.
        text_len
    };
    let geometry =
        bounding_rectangle_values(selection).and_then(|values| selection_anchor(&values));
    build_capture(
        text,
        cursor,
        Some(NativeTextRange {
            start: 0,
            end: text_len,
        }),
        true,
        false,
        token,
        geometry,
    )
}

fn capture_around_caret(
    domain: &VerifiedProviderDomain<'_>,
    caret_range: &IUIAutomationTextRange,
    can_observe_selection: bool,
    include_geometry: bool,
    token: String,
) -> Result<super::model::WindowsTextSurfaceCapture, Unavailable> {
    let window = unsafe { caret_range.Clone() }.map_err(|_| Unavailable::ElementDisappeared)?;
    unsafe {
        window.MoveEndpointByRange(
            TextPatternRangeEndpoint_Start,
            caret_range,
            TextPatternRangeEndpoint_Start,
        )
    }
    .map_err(|_| Unavailable::ElementDisappeared)?;
    unsafe {
        window.MoveEndpointByRange(
            TextPatternRangeEndpoint_End,
            caret_range,
            TextPatternRangeEndpoint_End,
        )
    }
    .map_err(|_| Unavailable::ElementDisappeared)?;
    unsafe {
        window.MoveEndpointByUnit(
            TextPatternRangeEndpoint_Start,
            TextUnit_Character,
            -CONTEXT_CHARACTERS_PER_SIDE,
        )
    }
    .map_err(|_| Unavailable::ElementDisappeared)?;
    unsafe {
        window.MoveEndpointByUnit(
            TextPatternRangeEndpoint_End,
            TextUnit_Character,
            CONTEXT_CHARACTERS_PER_SIDE,
        )
    }
    .map_err(|_| Unavailable::ElementDisappeared)?;

    // UIA movement is provider-wide. Clamp by endpoints to the already proven
    // focused domain, not by searching or trimming the returned text.
    if compare_endpoints(
        &window,
        TextPatternRangeEndpoint_Start,
        &domain.range,
        TextPatternRangeEndpoint_Start,
    )? < 0
    {
        unsafe {
            window.MoveEndpointByRange(
                TextPatternRangeEndpoint_Start,
                &domain.range,
                TextPatternRangeEndpoint_Start,
            )
        }
        .map_err(|_| Unavailable::UnsupportedSelection)?;
    }
    if compare_endpoints(
        &window,
        TextPatternRangeEndpoint_End,
        &domain.range,
        TextPatternRangeEndpoint_End,
    )? > 0
    {
        unsafe {
            window.MoveEndpointByRange(
                TextPatternRangeEndpoint_End,
                &domain.range,
                TextPatternRangeEndpoint_End,
            )
        }
        .map_err(|_| Unavailable::UnsupportedSelection)?;
    }
    domain.validate_range(&window)?;
    let text = range_text(&window)?;
    let offsets = domain.validate_text(&window, &text)?;
    let point = domain.offset(caret_range, TextPatternRangeEndpoint_Start)?;
    if point < offsets.start || point > offsets.end {
        return Err(Unavailable::MissingCaret);
    }
    let cursor = point - offsets.start;
    let geometry = include_geometry
        .then(|| caret_anchor(domain, caret_range))
        .flatten();
    build_capture(
        text,
        cursor,
        None,
        can_observe_selection,
        true,
        token,
        geometry,
    )
}

fn caret_anchor(
    domain: &VerifiedProviderDomain<'_>,
    caret: &IUIAutomationTextRange,
) -> Option<ExternalTextAnchor> {
    adjacent_range(caret, AdjacentCaretSide::Previous)
        .and_then(|range| anchor_from_adjacent_range(domain, &range, AdjacentCaretSide::Previous))
        .or_else(|| {
            adjacent_range(caret, AdjacentCaretSide::Next).and_then(|range| {
                anchor_from_adjacent_range(domain, &range, AdjacentCaretSide::Next)
            })
        })
}

fn adjacent_range(
    caret: &IUIAutomationTextRange,
    side: AdjacentCaretSide,
) -> Option<IUIAutomationTextRange> {
    let range = unsafe { caret.Clone() }.ok()?;
    let moved = match side {
        AdjacentCaretSide::Previous => unsafe {
            range.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -1)
        }
        .ok()?,
        AdjacentCaretSide::Next => {
            unsafe { range.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, 1) }
                .ok()?
        }
    };
    let expected = match side {
        AdjacentCaretSide::Previous => -1,
        AdjacentCaretSide::Next => 1,
    };
    (moved == expected).then_some(range)
}

fn anchor_from_adjacent_range(
    domain: &VerifiedProviderDomain<'_>,
    range: &IUIAutomationTextRange,
    side: AdjacentCaretSide,
) -> Option<ExternalTextAnchor> {
    domain.validate_range(range).ok()?;
    let text = range_text(range).ok()?;
    domain.validate_text(range, &text).ok()?;
    let values = bounding_rectangle_values(range)?;
    adjacent_caret_anchor(&values, &text, side)
}

struct OwnedSafeArray(*mut SAFEARRAY);

impl Drop for OwnedSafeArray {
    fn drop(&mut self) {
        if !self.0.is_null() {
            let _ = unsafe { SafeArrayDestroy(self.0) };
        }
    }
}

fn bounding_rectangle_values(range: &IUIAutomationTextRange) -> Option<Vec<f64>> {
    let raw = unsafe { range.GetBoundingRectangles() }.ok()?;
    if raw.is_null() {
        return None;
    }
    let array = OwnedSafeArray(raw);
    if unsafe { SafeArrayGetDim(array.0) } != 1
        || unsafe { SafeArrayGetElemsize(array.0) } as usize != std::mem::size_of::<f64>()
    {
        return None;
    }
    let bounds = unsafe { (*array.0).rgsabound[0] };
    let count = bounds.cElements as usize;
    if count > MAX_BOUNDING_VALUES {
        return None;
    }
    let mut values = Vec::with_capacity(count);
    for offset in 0..count {
        let index = bounds.lLbound.checked_add(i32::try_from(offset).ok()?)?;
        let mut value = 0.0_f64;
        unsafe { SafeArrayGetElement(array.0, &index, std::ptr::from_mut(&mut value).cast()) }
            .ok()?;
        values.push(value);
    }
    Some(values)
}

fn is_degenerate(range: &IUIAutomationTextRange) -> Result<bool, Unavailable> {
    unsafe {
        range.CompareEndpoints(
            TextPatternRangeEndpoint_Start,
            range,
            TextPatternRangeEndpoint_End,
        )
    }
    .map(|comparison| comparison == 0)
    .map_err(|_| Unavailable::ElementDisappeared)
}

fn range_text(range: &IUIAutomationTextRange) -> Result<String, Unavailable> {
    let text: BSTR = unsafe { range.GetText(-1) }.map_err(|_| Unavailable::ElementDisappeared)?;
    String::try_from(text).map_err(|_| Unavailable::ElementDisappeared)
}

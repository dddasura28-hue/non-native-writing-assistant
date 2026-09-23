use super::geometry::{
    adjacent_caret_anchor, selection_anchor, AdjacentCaretSide, ExternalTextAnchor,
};
use super::model::{
    build_capture, unavailable, ElementFacts, NativeTextRange,
    WindowsCaptureUnavailableReason as Unavailable, WindowsTextSurfaceCaptureResponse,
};
use windows::core::{Interface, BOOL, BSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    SAFEARRAY,
};
use windows::Win32::System::Ole::{
    SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetElement, SafeArrayGetElemsize,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationTextPattern, IUIAutomationTextPattern2,
    IUIAutomationTextRange, IUIAutomationValuePattern, TextPatternRangeEndpoint_End,
    TextPatternRangeEndpoint_Start, TextUnit_Character, UIA_TextPattern2Id, UIA_TextPatternId,
    UIA_ValuePatternId,
};

const CONTEXT_CHARACTERS_PER_SIDE: i32 = 8_192;
const MAX_BOUNDING_VALUES: usize = 256 * 4;

pub fn capture_active_text_surface(token: String) -> WindowsTextSurfaceCaptureResponse {
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    if !initialized {
        return unavailable(Unavailable::NativeUiaUnavailable);
    }
    let result = capture_initialized(token);
    unsafe { CoUninitialize() };
    result.unwrap_or_else(unavailable)
}

fn capture_initialized(token: String) -> Result<WindowsTextSurfaceCaptureResponse, Unavailable> {
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|_| Unavailable::NativeUiaUnavailable)?;
    let element =
        unsafe { automation.GetFocusedElement() }.map_err(|_| Unavailable::NoFocusedElement)?;

    let process_id =
        unsafe { element.CurrentProcessId() }.map_err(|_| Unavailable::ElementDisappeared)?;
    if process_id == std::process::id() as i32 {
        return Err(Unavailable::OwnProcess);
    }
    let protected = unsafe { element.CurrentIsPassword() }
        .map_err(|_| Unavailable::ElementDisappeared)?
        .as_bool();
    let enabled = unsafe { element.CurrentIsEnabled() }
        .map_err(|_| Unavailable::ElementDisappeared)?
        .as_bool();
    let keyboard_focusable = unsafe { element.CurrentIsKeyboardFocusable() }
        .map_err(|_| Unavailable::ElementDisappeared)?
        .as_bool();
    let text_pattern2 =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id) }
            .ok();
    let text_pattern = text_pattern2
        .as_ref()
        .and_then(|pattern| pattern.cast::<IUIAutomationTextPattern>().ok())
        .or_else(|| {
            unsafe { element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }
                .ok()
        });
    let _value_pattern_available =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
            .is_ok();

    super::model::validate_element(ElementFacts {
        own_process: false,
        protected,
        enabled,
        keyboard_focusable,
        has_text_pattern: text_pattern.is_some(),
    })?;

    let text_pattern = text_pattern.ok_or(Unavailable::UnsupportedTextPattern)?;
    let caret = active_caret(text_pattern2.as_ref());
    let selections = read_selections(&text_pattern, caret.is_some())?;

    let capture = match selections.as_slice() {
        [selection] if !is_degenerate(selection)? => {
            capture_exact_selection(selection, caret.as_ref(), token)?
        }
        [selection] => {
            let anchor = caret.as_ref().unwrap_or(selection);
            capture_around_caret(anchor, true, true, token)?
        }
        [] => {
            let anchor = caret.as_ref().ok_or(Unavailable::SelectionUnavailable)?;
            capture_around_caret(anchor, false, true, token)?
        }
        _ => {
            let anchor = caret.as_ref().ok_or(Unavailable::MultipleSelection)?;
            capture_around_caret(anchor, false, false, token)?
        }
    };

    Ok(WindowsTextSurfaceCaptureResponse::Captured { capture })
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
    selection: &IUIAutomationTextRange,
    caret: Option<&IUIAutomationTextRange>,
    token: String,
) -> Result<super::model::WindowsTextSurfaceCapture, Unavailable> {
    let geometry =
        bounding_rectangle_values(selection).and_then(|values| selection_anchor(&values));
    let text = range_text(selection)?;
    let text_len = super::model::utf16_len(&text);
    let cursor = caret
        .and_then(|range| offset_within(selection, range, TextPatternRangeEndpoint_Start).ok())
        .filter(|offset| *offset <= text_len)
        .unwrap_or(text_len);
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
    caret_range: &IUIAutomationTextRange,
    can_observe_selection: bool,
    include_geometry: bool,
    token: String,
) -> Result<super::model::WindowsTextSurfaceCapture, Unavailable> {
    let geometry = include_geometry
        .then(|| caret_anchor(caret_range))
        .flatten();
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

    let cursor = offset_within(&window, caret_range, TextPatternRangeEndpoint_Start)?;
    build_capture(
        range_text(&window)?,
        cursor,
        None,
        can_observe_selection,
        true,
        token,
        geometry,
    )
}

fn caret_anchor(caret: &IUIAutomationTextRange) -> Option<ExternalTextAnchor> {
    adjacent_range(caret, AdjacentCaretSide::Previous)
        .and_then(|range| anchor_from_adjacent_range(&range, AdjacentCaretSide::Previous))
        .or_else(|| {
            adjacent_range(caret, AdjacentCaretSide::Next)
                .and_then(|range| anchor_from_adjacent_range(&range, AdjacentCaretSide::Next))
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
    range: &IUIAutomationTextRange,
    side: AdjacentCaretSide,
) -> Option<ExternalTextAnchor> {
    let text = range_text(range).ok()?;
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

fn offset_within(
    container: &IUIAutomationTextRange,
    point: &IUIAutomationTextRange,
    endpoint: windows::Win32::UI::Accessibility::TextPatternRangeEndpoint,
) -> Result<usize, Unavailable> {
    let prefix = unsafe { container.Clone() }.map_err(|_| Unavailable::ElementDisappeared)?;
    unsafe { prefix.MoveEndpointByRange(TextPatternRangeEndpoint_End, point, endpoint) }
        .map_err(|_| Unavailable::ElementDisappeared)?;
    let text = unsafe { prefix.GetText(-1) }.map_err(|_| Unavailable::ElementDisappeared)?;
    Ok(text.len())
}

fn range_text(range: &IUIAutomationTextRange) -> Result<String, Unavailable> {
    let text: BSTR = unsafe { range.GetText(-1) }.map_err(|_| Unavailable::ElementDisappeared)?;
    String::try_from(text).map_err(|_| Unavailable::ElementDisappeared)
}

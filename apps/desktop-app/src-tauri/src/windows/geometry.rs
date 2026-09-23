use serde::Serialize;

const MAX_BOUNDING_RECTANGLES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalTextAnchorConfidence {
    Exact,
    Approximate,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalTextAnchor {
    pub physical_x: f64,
    pub physical_y: f64,
    pub physical_width: f64,
    pub physical_height: f64,
    pub confidence: ExternalTextAnchorConfidence,
}

impl ExternalTextAnchor {
    pub fn is_valid(self) -> bool {
        [
            self.physical_x,
            self.physical_y,
            self.physical_width,
            self.physical_height,
        ]
        .into_iter()
        .all(f64::is_finite)
            && self.physical_width > 0.0
            && self.physical_height > 0.0
            && self.physical_x >= f64::from(i32::MIN)
            && self.physical_y >= f64::from(i32::MIN)
            && self.physical_x + self.physical_width <= f64::from(i32::MAX)
            && self.physical_y + self.physical_height <= f64::from(i32::MAX)
    }

    pub fn center(self) -> (f64, f64) {
        (
            self.physical_x + self.physical_width / 2.0,
            self.physical_y + self.physical_height / 2.0,
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct PhysicalTextRectangle {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl PhysicalTextRectangle {
    fn from_values(values: &[f64]) -> Option<Self> {
        let [x, y, width, height] = values else {
            return None;
        };
        let rectangle = Self {
            x: *x,
            y: *y,
            width: *width,
            height: *height,
        };
        ExternalTextAnchor {
            physical_x: rectangle.x,
            physical_y: rectangle.y,
            physical_width: rectangle.width,
            physical_height: rectangle.height,
            confidence: ExternalTextAnchorConfidence::Exact,
        }
        .is_valid()
        .then_some(rectangle)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdjacentCaretSide {
    Previous,
    Next,
}

pub fn selection_anchor(values: &[f64]) -> Option<ExternalTextAnchor> {
    let rectangles = validated_rectangles(values)?;
    let rectangle = rectangles.last()?;
    Some(ExternalTextAnchor {
        physical_x: rectangle.x,
        physical_y: rectangle.y,
        physical_width: rectangle.width,
        physical_height: rectangle.height,
        confidence: ExternalTextAnchorConfidence::Exact,
    })
}

pub fn adjacent_caret_anchor(
    values: &[f64],
    adjacent_text: &str,
    side: AdjacentCaretSide,
) -> Option<ExternalTextAnchor> {
    if !is_unambiguous_adjacent_text(adjacent_text) {
        return None;
    }
    let rectangles = validated_rectangles(values)?;
    let [rectangle] = rectangles.as_slice() else {
        return None;
    };
    let physical_x = match side {
        AdjacentCaretSide::Previous => rectangle.x + rectangle.width,
        AdjacentCaretSide::Next => rectangle.x,
    };
    let anchor = ExternalTextAnchor {
        physical_x,
        physical_y: rectangle.y,
        physical_width: 1.0,
        physical_height: rectangle.height,
        confidence: ExternalTextAnchorConfidence::Approximate,
    };
    anchor.is_valid().then_some(anchor)
}

fn validated_rectangles(values: &[f64]) -> Option<Vec<PhysicalTextRectangle>> {
    if values.len() % 4 != 0 || values.len() / 4 > MAX_BOUNDING_RECTANGLES {
        return None;
    }
    values
        .chunks_exact(4)
        .map(PhysicalTextRectangle::from_values)
        .collect()
}

fn is_unambiguous_adjacent_text(text: &str) -> bool {
    let mut characters = text.chars();
    let Some(character) = characters.next() else {
        return false;
    };
    characters.next().is_none()
        && !character.is_control()
        && !matches!(
            character as u32,
            0x0300..=0x036f
                | 0x0590..=0x08ff
                | 0x1ab0..=0x1aff
                | 0x1dc0..=0x1dff
                | 0x200c..=0x200f
                | 0x202a..=0x202e
                | 0x2066..=0x2069
                | 0x20d0..=0x20ff
                | 0xfe00..=0xfe0f
                | 0xfe20..=0xfe2f
        )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PhysicalWorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssistantPhysicalSize {
    pub width: u32,
    pub height: u32,
}

pub fn logical_gap_to_physical(logical_gap: f64, scale_factor: f64) -> Option<i32> {
    if !logical_gap.is_finite()
        || logical_gap < 0.0
        || !scale_factor.is_finite()
        || scale_factor <= 0.0
    {
        return None;
    }
    let physical = (logical_gap * scale_factor).round();
    (physical <= f64::from(i32::MAX)).then_some(physical as i32)
}

pub fn rescale_physical_size(
    current: AssistantPhysicalSize,
    current_scale_factor: f64,
    target_scale_factor: f64,
) -> Option<AssistantPhysicalSize> {
    if current.width == 0
        || current.height == 0
        || !current_scale_factor.is_finite()
        || current_scale_factor <= 0.0
        || !target_scale_factor.is_finite()
        || target_scale_factor <= 0.0
    {
        return None;
    }
    let width = (f64::from(current.width) / current_scale_factor * target_scale_factor).round();
    let height = (f64::from(current.height) / current_scale_factor * target_scale_factor).round();
    (width >= 1.0 && width <= f64::from(u32::MAX) && height >= 1.0 && height <= f64::from(u32::MAX))
        .then_some(AssistantPhysicalSize {
            width: width as u32,
            height: height as u32,
        })
}

pub fn place_near_anchor(
    anchor: ExternalTextAnchor,
    assistant: AssistantPhysicalSize,
    work_area: PhysicalWorkArea,
    gap: i32,
) -> Option<(i32, i32)> {
    if !anchor.is_valid()
        || assistant.width == 0
        || assistant.height == 0
        || assistant.width > work_area.width
        || assistant.height > work_area.height
        || gap < 0
    {
        return None;
    }

    let work_left = f64::from(work_area.x);
    let work_top = f64::from(work_area.y);
    let work_right = work_left + f64::from(work_area.width);
    let work_bottom = work_top + f64::from(work_area.height);
    let assistant_width = f64::from(assistant.width);
    let assistant_height = f64::from(assistant.height);
    let gap = f64::from(gap);

    let max_x = work_right - assistant_width;
    let x = anchor.physical_x.clamp(work_left, max_x);
    let below = anchor.physical_y + anchor.physical_height + gap;
    let above = anchor.physical_y - gap - assistant_height;
    let y = if below + assistant_height <= work_bottom {
        below
    } else if above >= work_top {
        above
    } else {
        below.clamp(work_top, work_bottom - assistant_height)
    };

    Some((round_to_i32(x)?, round_to_i32(y)?))
}

pub fn bottom_right_position(
    work_area: PhysicalWorkArea,
    assistant: AssistantPhysicalSize,
    margin: i32,
) -> (i32, i32) {
    let available_x = work_area.width.saturating_sub(assistant.width) as i64;
    let available_y = work_area.height.saturating_sub(assistant.height) as i64;
    let x = i64::from(work_area.x) + available_x - i64::from(margin);
    let y = i64::from(work_area.y) + available_y - i64::from(margin);
    (
        x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
    )
}

fn round_to_i32(value: f64) -> Option<i32> {
    let rounded = value.round();
    (rounded >= f64::from(i32::MIN) && rounded <= f64::from(i32::MAX)).then_some(rounded as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(x: f64, y: f64, width: f64, height: f64) -> ExternalTextAnchor {
        ExternalTextAnchor {
            physical_x: x,
            physical_y: y,
            physical_width: width,
            physical_height: height,
            confidence: ExternalTextAnchorConfidence::Approximate,
        }
    }

    const ASSISTANT: AssistantPhysicalSize = AssistantPhysicalSize {
        width: 420,
        height: 320,
    };
    const WORK_AREA: PhysicalWorkArea = PhysicalWorkArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };

    #[test]
    fn degenerate_range_empty_rectangles_do_not_create_an_anchor() {
        assert_eq!(selection_anchor(&[]), None);
    }

    #[test]
    fn previous_character_inference_uses_the_trailing_edge() {
        assert_eq!(
            adjacent_caret_anchor(
                &[100.0, 200.0, 12.0, 20.0],
                "A",
                AdjacentCaretSide::Previous
            ),
            Some(anchor(112.0, 200.0, 1.0, 20.0))
        );
    }

    #[test]
    fn next_character_fallback_uses_the_leading_edge() {
        assert_eq!(
            adjacent_caret_anchor(&[100.0, 200.0, 12.0, 20.0], "中", AdjacentCaretSide::Next),
            Some(anchor(100.0, 200.0, 1.0, 20.0))
        );
    }

    #[test]
    fn document_end_can_use_the_previous_character() {
        assert!(adjacent_caret_anchor(
            &[20.0, 30.0, 18.0, 22.0],
            "😀",
            AdjacentCaretSide::Previous
        )
        .is_some());
    }

    #[test]
    fn malformed_or_empty_rectangles_are_rejected_safely() {
        for values in [
            vec![],
            vec![1.0, 2.0, 3.0],
            vec![f64::NAN, 2.0, 3.0, 4.0],
            vec![1.0, f64::INFINITY, 3.0, 4.0],
            vec![1.0, 2.0, -3.0, 4.0],
        ] {
            assert_eq!(selection_anchor(&values), None);
        }
    }

    #[test]
    fn selection_uses_the_last_visible_rectangle() {
        assert_eq!(
            selection_anchor(&[10.0, 10.0, 100.0, 20.0, 10.0, 30.0, 50.0, 20.0]),
            Some(ExternalTextAnchor {
                physical_x: 10.0,
                physical_y: 30.0,
                physical_width: 50.0,
                physical_height: 20.0,
                confidence: ExternalTextAnchorConfidence::Exact,
            })
        );
    }

    #[test]
    fn bidi_or_complex_adjacent_text_is_conservatively_rejected() {
        for text in ["א", "ا", "\u{0301}", "👩‍💻", "\n"] {
            assert_eq!(
                adjacent_caret_anchor(&[10.0, 10.0, 10.0, 20.0], text, AdjacentCaretSide::Previous),
                None
            );
        }
    }

    #[test]
    fn places_below_when_space_exists_and_above_near_the_bottom() {
        assert_eq!(
            place_near_anchor(anchor(500.0, 200.0, 1.0, 20.0), ASSISTANT, WORK_AREA, 12),
            Some((500, 232))
        );
        assert_eq!(
            place_near_anchor(anchor(500.0, 900.0, 1.0, 20.0), ASSISTANT, WORK_AREA, 12),
            Some((500, 568))
        );
    }

    #[test]
    fn clamps_both_horizontal_edges() {
        assert_eq!(
            place_near_anchor(anchor(1900.0, 200.0, 1.0, 20.0), ASSISTANT, WORK_AREA, 12),
            Some((1500, 232))
        );
        assert_eq!(
            place_near_anchor(anchor(-20.0, 200.0, 1.0, 20.0), ASSISTANT, WORK_AREA, 12),
            Some((0, 232))
        );
    }

    #[test]
    fn honors_a_secondary_monitor_work_area() {
        let secondary = PhysicalWorkArea {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert_eq!(
            place_near_anchor(anchor(-800.0, 400.0, 1.0, 20.0), ASSISTANT, secondary, 12),
            Some((-800, 432))
        );
    }

    #[test]
    fn a_large_assistant_uses_available_space_and_stays_bounded() {
        let assistant = AssistantPhysicalSize {
            width: 700,
            height: 500,
        };
        let work = PhysicalWorkArea {
            x: 100,
            y: 50,
            width: 800,
            height: 600,
        };
        assert_eq!(
            place_near_anchor(anchor(850.0, 580.0, 1.0, 20.0), assistant, work, 12),
            Some((200, 68))
        );
    }

    #[test]
    fn invalid_anchor_triggers_fallback_instead_of_placement() {
        assert_eq!(
            place_near_anchor(anchor(f64::NAN, 10.0, 1.0, 20.0), ASSISTANT, WORK_AREA, 12),
            None
        );
    }

    #[test]
    fn logical_gap_conversion_is_dpi_deterministic() {
        for (scale, expected) in [(1.0, 12), (1.25, 15), (1.5, 18), (2.0, 24)] {
            assert_eq!(logical_gap_to_physical(12.0, scale), Some(expected));
        }
    }

    #[test]
    fn assistant_size_conversion_is_dpi_deterministic() {
        let logical_size_at_100_percent = AssistantPhysicalSize {
            width: 420,
            height: 320,
        };
        for (scale, expected) in [
            (1.0, (420, 320)),
            (1.25, (525, 400)),
            (1.5, (630, 480)),
            (2.0, (840, 640)),
        ] {
            let size = rescale_physical_size(logical_size_at_100_percent, 1.0, scale).unwrap();
            assert_eq!((size.width, size.height), expected);
        }
        assert_eq!(
            rescale_physical_size(
                AssistantPhysicalSize {
                    width: 630,
                    height: 480,
                },
                1.5,
                1.25,
            ),
            Some(AssistantPhysicalSize {
                width: 525,
                height: 400,
            })
        );
    }
}

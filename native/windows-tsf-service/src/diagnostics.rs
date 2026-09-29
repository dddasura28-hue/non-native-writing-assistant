use windows::core::PCWSTR;
use windows::Win32::System::Diagnostics::Debug::OutputDebugStringW;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Event {
    Activated {
        secure: bool,
        generation: u64,
    },
    Deactivated {
        generation: u64,
    },
    ContextChanged {
        generation: u64,
    },
    DocumentInitialized {
        generation: u64,
    },
    DocumentUninitialized {
        generation: u64,
        was_current: bool,
    },
    Snapshot {
        generation: u64,
        text_units: usize,
        cursor: usize,
        selection_start: usize,
        selection_end: usize,
        composition_start: usize,
        composition_end: usize,
        composition_active: bool,
    },
    CaptureSkipped {
        generation: u64,
        reason: &'static str,
    },
}

impl Event {
    fn message(self) -> String {
        match self {
            Self::Activated { secure, generation } => format!(
                "[non-native-writing-tsf] activated secure={secure} generation={generation}"
            ),
            Self::Deactivated { generation } => format!(
                "[non-native-writing-tsf] deactivated generation={generation}"
            ),
            Self::ContextChanged { generation } => format!(
                "[non-native-writing-tsf] context-changed generation={generation}"
            ),
            Self::DocumentInitialized { generation } => format!(
                "[non-native-writing-tsf] document-initialized generation={generation}"
            ),
            Self::DocumentUninitialized {
                generation,
                was_current,
            } => format!(
                "[non-native-writing-tsf] document-uninitialized generation={generation} was_current={was_current}"
            ),
            Self::Snapshot {
                generation,
                text_units,
                cursor,
                selection_start,
                selection_end,
                composition_start,
                composition_end,
                composition_active,
            } => format!(
                "[non-native-writing-tsf] snapshot generation={generation} text_units={text_units} cursor={cursor} selection=[{selection_start},{selection_end}) composition=[{composition_start},{composition_end}) composition_active={composition_active}"
            ),
            Self::CaptureSkipped { generation, reason } => format!(
                "[non-native-writing-tsf] capture-skipped generation={generation} reason={reason}"
            ),
        }
    }
}

pub(crate) fn emit(event: Event) {
    let mut wide: Vec<u16> = event.message().encode_utf16().collect();
    wide.push(0);
    unsafe { OutputDebugStringW(PCWSTR(wide.as_ptr())) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_contain_metadata_only() {
        let source = "private source 中文 A😀B";
        let message = Event::Snapshot {
            generation: 4,
            text_units: source.encode_utf16().count(),
            cursor: 3,
            selection_start: 1,
            selection_end: 3,
            composition_start: 0,
            composition_end: 0,
            composition_active: false,
        }
        .message();

        assert!(!message.contains(source));
        assert!(!message.contains("中文"));
        assert!(!message.contains('😀'));
    }
}

//! Compile-time inventory of the `windows` crate TSF surface needed by a
//! future in-process text-service DLL. This module does not activate TSF or
//! register a text service.

#[cfg(target_os = "windows")]
pub(super) fn assert_required_bindings_are_available() {
    use windows::core::Interface;
    use windows::Win32::UI::TextServices::{
        CLSID_TF_InputProcessorProfiles, IEnumITfCompositionView, ITfCategoryMgr,
        ITfCompositionSink, ITfCompositionView, ITfContext, ITfContextComposition,
        ITfContextOwnerCompositionSink, ITfDocumentMgr, ITfEditRecord, ITfEditSession,
        ITfInputProcessorProfileMgr, ITfInputProcessorProfiles, ITfProperty, ITfRange,
        ITfReadOnlyProperty, ITfSource, ITfTextEditSink, ITfTextInputProcessor,
        ITfTextInputProcessorEx, ITfThreadMgr, ITfThreadMgrEventSink, ITfThreadMgrEx,
        GUID_PROP_COMPOSING, GUID_TFCAT_TIPCAP_SECUREMODE, GUID_TFCAT_TIP_KEYBOARD, TF_AE_END,
        TF_AE_NONE, TF_AE_START, TF_ES_ASYNC, TF_ES_READ, TF_ES_READWRITE, TF_ES_SYNC,
        TF_SELECTION, TF_SELECTIONSTYLE, TF_TMAE_SECUREMODE,
    };

    fn require_interface<T: Interface>() {}

    require_interface::<ITfTextInputProcessor>();
    require_interface::<ITfTextInputProcessorEx>();
    require_interface::<ITfThreadMgr>();
    require_interface::<ITfThreadMgrEx>();
    require_interface::<ITfDocumentMgr>();
    require_interface::<ITfContext>();
    require_interface::<ITfRange>();
    require_interface::<ITfEditSession>();
    require_interface::<ITfTextEditSink>();
    require_interface::<ITfContextComposition>();
    require_interface::<IEnumITfCompositionView>();
    require_interface::<ITfCompositionView>();
    require_interface::<ITfCompositionSink>();
    require_interface::<ITfContextOwnerCompositionSink>();
    require_interface::<ITfEditRecord>();
    require_interface::<ITfProperty>();
    require_interface::<ITfReadOnlyProperty>();
    require_interface::<ITfSource>();
    require_interface::<ITfThreadMgrEventSink>();
    require_interface::<ITfInputProcessorProfiles>();
    require_interface::<ITfInputProcessorProfileMgr>();
    require_interface::<ITfCategoryMgr>();

    let _ = CLSID_TF_InputProcessorProfiles;
    let _ = GUID_PROP_COMPOSING;
    let _ = GUID_TFCAT_TIP_KEYBOARD;
    let _ = GUID_TFCAT_TIPCAP_SECUREMODE;
    let _ = TF_SELECTION::default();
    let _ = TF_SELECTIONSTYLE::default();
    let _ = TF_AE_NONE;
    let _ = TF_AE_START;
    let _ = TF_AE_END;
    let _ = TF_ES_READ;
    let _ = TF_ES_READWRITE;
    let _ = TF_ES_ASYNC;
    let _ = TF_ES_SYNC;
    let _ = TF_TMAE_SECUREMODE;
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(target_os = "windows")]
    fn windows_rs_exposes_the_required_tsf_interfaces() {
        super::assert_required_bindings_are_available();
    }
}

#![cfg(windows)]
#![allow(linker_messages)]

#[cfg(not(target_arch = "x86_64"))]
compile_error!("Windows TSF Native Component Prototype v1 supports x64 only");

mod capture;
mod component;
mod diagnostics;
pub mod identity;
mod lifetime;
pub mod registration;
mod registration_workflow;

use component::TextServiceClassFactory;
use identity::TEXT_SERVICE_CLSID;
use std::panic::{catch_unwind, AssertUnwindSafe};
use windows::core::{Interface, GUID, HRESULT};
use windows::Win32::Foundation::{
    CLASS_E_CLASSNOTAVAILABLE, E_POINTER, E_UNEXPECTED, S_FALSE, S_OK,
};
use windows::Win32::System::Com::IClassFactory;

/// Returns the prototype TSF COM class factory. This export does not register or activate the TIP.
///
/// # Safety
///
/// The caller must supply readable CLSID/IID pointers and a writable COM out pointer, following the
/// `DllGetClassObject` contract. Null pointers are rejected with `E_POINTER`.
#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    class_id: *const GUID,
    interface_id: *const GUID,
    object: *mut *mut core::ffi::c_void,
) -> HRESULT {
    catch_unwind(AssertUnwindSafe(|| {
        if class_id.is_null() || interface_id.is_null() || object.is_null() {
            return E_POINTER;
        }
        unsafe { object.write(std::ptr::null_mut()) };
        if unsafe { *class_id } != TEXT_SERVICE_CLSID {
            return CLASS_E_CLASSNOTAVAILABLE;
        }

        let factory: IClassFactory = TextServiceClassFactory::new().into();
        unsafe { factory.query(interface_id, object) }
    }))
    .unwrap_or(E_UNEXPECTED)
}

/// Reports whether all COM objects and explicit server locks have been released.
#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    catch_unwind(AssertUnwindSafe(|| {
        if lifetime::can_unload() {
            S_OK
        } else {
            S_FALSE
        }
    }))
    .unwrap_or(E_UNEXPECTED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::core::IUnknown;

    #[test]
    fn exported_factory_rejects_unknown_class_and_supports_iunknown() {
        let _guard = lifetime::test_lock();
        assert_eq!(DllCanUnloadNow(), S_OK);

        let mut raw = std::ptr::null_mut();
        let unknown_class = GUID::from_u128(0x11111111_2222_3333_4444_555555555555);
        let result = unsafe { DllGetClassObject(&unknown_class, &IUnknown::IID, &mut raw) };
        assert_eq!(result, CLASS_E_CLASSNOTAVAILABLE);
        assert!(raw.is_null());

        let result = unsafe { DllGetClassObject(&TEXT_SERVICE_CLSID, &IUnknown::IID, &mut raw) };
        assert_eq!(result, S_OK);
        assert!(!raw.is_null());
        assert_eq!(DllCanUnloadNow(), S_FALSE);
        let factory = unsafe { IUnknown::from_raw(raw) };
        drop(factory);
        assert_eq!(DllCanUnloadNow(), S_OK);
    }

    #[test]
    fn null_factory_arguments_are_rejected_without_dereference() {
        let _guard = lifetime::test_lock();
        let result =
            unsafe { DllGetClassObject(std::ptr::null(), &IUnknown::IID, std::ptr::null_mut()) };
        assert_eq!(result, E_POINTER);
    }
}

//! Explicit development registration. Nothing in this module runs at DLL load, build, test, or app startup.

use crate::identity::{
    clsid_registry_name, EN_US_LANGID, EN_US_PROFILE_GUID, SERVICE_DESCRIPTION, TEXT_SERVICE_CLSID,
    ZH_CN_LANGID, ZH_CN_PROFILE_GUID,
};
use std::path::Path;
use windows::core::{w, Error, Result, PCWSTR};
use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_LOCAL_MACHINE,
    KEY_WOW64_64KEY, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows::Win32::UI::TextServices::{
    CLSID_TF_CategoryMgr, CLSID_TF_InputProcessorProfiles, ITfCategoryMgr,
    ITfInputProcessorProfiles, GUID_TFCAT_TIP_KEYBOARD,
};

struct ComApartment;

impl ComApartment {
    fn initialize() -> Result<Self> {
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        result.ok()?;
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct RegistryKey(HKEY);

impl Drop for RegistryKey {
    fn drop(&mut self) {
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

fn utf16z(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn utf16_bytes(value: &[u16]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(value.as_ptr().cast(), value.len() * 2) }
}

fn registry_path() -> String {
    format!(
        "SOFTWARE\\Classes\\CLSID\\{}\\InprocServer32",
        clsid_registry_name()
    )
}

fn register_com_server(dll_path: &Path) -> Result<()> {
    let subkey = utf16z(&registry_path());
    let mut raw_key = HKEY::default();
    unsafe {
        RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(subkey.as_ptr()),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE | KEY_WOW64_64KEY,
            None,
            &mut raw_key,
            None,
        )
        .ok()?;
    }
    let key = RegistryKey(raw_key);
    let dll = utf16z(&dll_path.to_string_lossy());
    let apartment = utf16z("Apartment");
    unsafe {
        RegSetValueExW(key.0, PCWSTR::null(), None, REG_SZ, Some(utf16_bytes(&dll))).ok()?;
        RegSetValueExW(
            key.0,
            w!("ThreadingModel"),
            None,
            REG_SZ,
            Some(utf16_bytes(&apartment)),
        )
        .ok()?;
    }
    Ok(())
}

fn unregister_com_server() -> Result<()> {
    let path = utf16z(&format!(
        "SOFTWARE\\Classes\\CLSID\\{}",
        clsid_registry_name()
    ));
    let result = unsafe { RegDeleteTreeW(HKEY_LOCAL_MACHINE, PCWSTR(path.as_ptr())) };
    if result.is_ok() || result == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(Error::from(result))
    }
}

unsafe fn system_profiles() -> Result<ITfInputProcessorProfiles> {
    unsafe { CoCreateInstance(&CLSID_TF_InputProcessorProfiles, None, CLSCTX_INPROC_SERVER) }
}

unsafe fn category_manager() -> Result<ITfCategoryMgr> {
    unsafe { CoCreateInstance(&CLSID_TF_CategoryMgr, None, CLSCTX_INPROC_SERVER) }
}

unsafe fn register_profile(
    profiles: &ITfInputProcessorProfiles,
    language: u16,
    profile: &windows::core::GUID,
    description: &str,
) -> Result<()> {
    let description: Vec<u16> = description.encode_utf16().collect();
    unsafe {
        profiles.AddLanguageProfile(
            &TEXT_SERVICE_CLSID,
            language,
            profile,
            &description,
            &[],
            0,
        )?;
        profiles.EnableLanguageProfile(&TEXT_SERVICE_CLSID, language, profile, true)
    }
}

/// Installs the x64 development prototype for deliberate manual validation.
///
/// This function does not activate the profile or change the user's current input method.
pub fn register(dll_path: &Path) -> Result<()> {
    if !dll_path.is_absolute() || !dll_path.is_file() {
        return Err(Error::new(
            windows::Win32::Foundation::E_INVALIDARG,
            "register requires an existing absolute DLL path",
        ));
    }
    if dll_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("dll"))
    {
        return Err(Error::new(
            windows::Win32::Foundation::E_INVALIDARG,
            "register requires a DLL path",
        ));
    }

    let _apartment = ComApartment::initialize()?;
    register_com_server(dll_path)?;
    let result = unsafe {
        let profiles = system_profiles()?;
        profiles.Register(&TEXT_SERVICE_CLSID)?;
        register_profile(
            &profiles,
            EN_US_LANGID,
            &EN_US_PROFILE_GUID,
            &format!("{SERVICE_DESCRIPTION} — English"),
        )?;
        register_profile(
            &profiles,
            ZH_CN_LANGID,
            &ZH_CN_PROFILE_GUID,
            &format!("{SERVICE_DESCRIPTION} — Chinese"),
        )?;
        let categories = category_manager()?;
        categories.RegisterCategory(
            &TEXT_SERVICE_CLSID,
            &GUID_TFCAT_TIP_KEYBOARD,
            &TEXT_SERVICE_CLSID,
        )
    };
    if result.is_err() {
        let _ = unsafe { unregister_inner() };
    }
    result
}

fn keep_first_error(first_error: &mut Option<Error>, result: Result<()>) {
    if let Err(error) = result {
        if first_error.is_none() {
            *first_error = Some(error);
        }
    }
}

unsafe fn unregister_inner() -> Result<()> {
    let mut first_error: Option<Error> = None;

    match unsafe { category_manager() } {
        Ok(categories) => unsafe {
            keep_first_error(
                &mut first_error,
                categories.UnregisterCategory(
                    &TEXT_SERVICE_CLSID,
                    &GUID_TFCAT_TIP_KEYBOARD,
                    &TEXT_SERVICE_CLSID,
                ),
            );
        },
        Err(error) => first_error = Some(error),
    }

    match unsafe { system_profiles() } {
        Ok(profiles) => unsafe {
            keep_first_error(
                &mut first_error,
                profiles.EnableLanguageProfile(
                    &TEXT_SERVICE_CLSID,
                    EN_US_LANGID,
                    &EN_US_PROFILE_GUID,
                    false,
                ),
            );
            keep_first_error(
                &mut first_error,
                profiles.RemoveLanguageProfile(
                    &TEXT_SERVICE_CLSID,
                    EN_US_LANGID,
                    &EN_US_PROFILE_GUID,
                ),
            );
            keep_first_error(
                &mut first_error,
                profiles.EnableLanguageProfile(
                    &TEXT_SERVICE_CLSID,
                    ZH_CN_LANGID,
                    &ZH_CN_PROFILE_GUID,
                    false,
                ),
            );
            keep_first_error(
                &mut first_error,
                profiles.RemoveLanguageProfile(
                    &TEXT_SERVICE_CLSID,
                    ZH_CN_LANGID,
                    &ZH_CN_PROFILE_GUID,
                ),
            );
            keep_first_error(&mut first_error, profiles.Unregister(&TEXT_SERVICE_CLSID));
        },
        Err(error) if first_error.is_none() => first_error = Some(error),
        Err(_) => {}
    }
    keep_first_error(&mut first_error, unregister_com_server());

    first_error.map_or(Ok(()), Err)
}

/// Removes both development language profiles, the TSF category, service registration, and x64
/// COM in-process server registration. It does not alter unrelated input methods.
pub fn unregister() -> Result<()> {
    let _apartment = ComApartment::initialize()?;
    unsafe { unregister_inner() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_identity_is_stable_and_scoped_to_this_development_class() {
        let path = registry_path();
        assert!(path.starts_with("SOFTWARE\\Classes\\CLSID\\{"));
        assert!(path.ends_with("\\InprocServer32"));
        assert!(path.contains(&clsid_registry_name()));
    }

    #[test]
    fn registration_requires_an_explicit_absolute_dll_path_before_any_system_write() {
        let result = register(Path::new("relative.dll"));
        assert!(result.is_err());
    }
}

//! Explicit development registration. Nothing in this module runs at DLL load, build, test, or app startup.

use crate::identity::{clsid_registry_name, SERVICE_DESCRIPTION, TEXT_SERVICE_CLSID};
use crate::registration_workflow::{
    self, ExistingComRegistration, OperationError, Profile, RegistrationBackend,
};
use std::path::Path;
use windows::core::{w, Error, Interface, PCWSTR};
use windows::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, E_FAIL, E_INVALIDARG, S_FALSE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IEnumGUID, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY, KEY_WRITE, REG_OPTION_NON_VOLATILE,
    REG_SAM_FLAGS, REG_SZ, REG_VALUE_TYPE,
};
use windows::Win32::UI::TextServices::{
    CLSID_TF_CategoryMgr, CLSID_TF_InputProcessorProfiles, ITfCategoryMgr,
    ITfInputProcessorProfiles, GUID_TFCAT_TIP_KEYBOARD, TF_LANGUAGEPROFILE,
};

pub use crate::registration_workflow::{CommandFailure, CommandReport, Diagnostic};

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

fn clsid_registry_path() -> String {
    format!("SOFTWARE\\Classes\\CLSID\\{}", clsid_registry_name())
}

fn inproc_registry_path() -> String {
    format!("{}\\InprocServer32", clsid_registry_path())
}

fn windows_error(error: Error) -> OperationError {
    OperationError::new(error.code(), error.message())
}

fn win32_error(error: windows::Win32::Foundation::WIN32_ERROR) -> OperationError {
    windows_error(Error::from(error))
}

fn open_registry_key(
    path: &str,
    access: REG_SAM_FLAGS,
) -> Result<Option<RegistryKey>, OperationError> {
    let path = utf16z(path);
    let mut raw_key = HKEY::default();
    let result = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(path.as_ptr()),
            None,
            access | KEY_WOW64_64KEY,
            &mut raw_key,
        )
    };
    if result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND {
        Ok(None)
    } else if result == ERROR_SUCCESS {
        Ok(Some(RegistryKey(raw_key)))
    } else {
        Err(win32_error(result))
    }
}

fn read_registry_string(key: &RegistryKey, name: PCWSTR) -> Result<String, OperationError> {
    let mut value_type = REG_VALUE_TYPE::default();
    let mut byte_count = 0u32;
    let result = unsafe {
        RegQueryValueExW(
            key.0,
            name,
            None,
            Some(&mut value_type),
            None,
            Some(&mut byte_count),
        )
    };
    if result != ERROR_SUCCESS {
        return Err(win32_error(result));
    }
    if value_type != REG_SZ || byte_count == 0 || !byte_count.is_multiple_of(2) {
        return Err(OperationError::new(
            E_FAIL,
            "registry value is not a non-empty UTF-16 REG_SZ",
        ));
    }

    let mut bytes = vec![0u8; byte_count as usize];
    let result = unsafe {
        RegQueryValueExW(
            key.0,
            name,
            None,
            Some(&mut value_type),
            Some(bytes.as_mut_ptr()),
            Some(&mut byte_count),
        )
    };
    if result != ERROR_SUCCESS {
        return Err(win32_error(result));
    }
    let units = unsafe {
        std::slice::from_raw_parts(bytes.as_ptr().cast::<u16>(), byte_count as usize / 2)
    };
    let units = units.strip_suffix(&[0]).unwrap_or(units);
    String::from_utf16(units)
        .map_err(|_| OperationError::new(E_FAIL, "registry value contains invalid UTF-16"))
}

#[derive(Debug)]
struct ComRegistration {
    dll_path: String,
    threading_model: String,
}

fn read_com_registration() -> Result<Option<ComRegistration>, OperationError> {
    let Some(key) = open_registry_key(&inproc_registry_path(), KEY_READ)? else {
        return Ok(None);
    };
    Ok(Some(ComRegistration {
        dll_path: read_registry_string(&key, PCWSTR::null())?,
        threading_model: read_registry_string(&key, w!("ThreadingModel"))?,
    }))
}

fn write_com_registration(dll_path: &str) -> Result<(), OperationError> {
    let subkey = utf16z(&inproc_registry_path());
    let mut raw_key = HKEY::default();
    let result = unsafe {
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
    };
    if result != ERROR_SUCCESS {
        return Err(win32_error(result));
    }
    let key = RegistryKey(raw_key);
    let dll = utf16z(dll_path);
    let apartment = utf16z("Apartment");
    let result =
        unsafe { RegSetValueExW(key.0, PCWSTR::null(), None, REG_SZ, Some(utf16_bytes(&dll))) };
    if result != ERROR_SUCCESS {
        return Err(win32_error(result));
    }
    let result = unsafe {
        RegSetValueExW(
            key.0,
            w!("ThreadingModel"),
            None,
            REG_SZ,
            Some(utf16_bytes(&apartment)),
        )
    };
    if result == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(win32_error(result))
    }
}

fn remove_com_registration() -> Result<(), OperationError> {
    let path = utf16z(&clsid_registry_path());
    let result = unsafe { RegDeleteTreeW(HKEY_LOCAL_MACHINE, PCWSTR(path.as_ptr())) };
    if result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND {
        Ok(())
    } else {
        Err(win32_error(result))
    }
}

fn guid_enumerator_contains(
    enumerator: &IEnumGUID,
    expected: &windows::core::GUID,
) -> Result<bool, OperationError> {
    loop {
        let mut values = [windows::core::GUID::zeroed()];
        let mut fetched = 0u32;
        let result = unsafe { enumerator.Next(&mut values, Some(&mut fetched)) };
        if result == S_FALSE || fetched == 0 {
            return Ok(false);
        }
        result.ok().map_err(windows_error)?;
        if values[0] == *expected {
            return Ok(true);
        }
    }
}

#[derive(Default)]
struct WindowsRegistrationBackend {
    com_initialized: bool,
    profiles: Option<ITfInputProcessorProfiles>,
    categories: Option<ITfCategoryMgr>,
}

impl WindowsRegistrationBackend {
    fn profiles(&self) -> Result<&ITfInputProcessorProfiles, OperationError> {
        self.profiles.as_ref().ok_or_else(|| {
            OperationError::new(E_FAIL, "ITfInputProcessorProfiles has not been created")
        })
    }

    fn categories(&self) -> Result<&ITfCategoryMgr, OperationError> {
        self.categories
            .as_ref()
            .ok_or_else(|| OperationError::new(E_FAIL, "ITfCategoryMgr has not been created"))
    }
}

impl Drop for WindowsRegistrationBackend {
    fn drop(&mut self) {
        self.categories.take();
        self.profiles.take();
        if self.com_initialized {
            unsafe { CoUninitialize() };
        }
    }
}

impl RegistrationBackend for WindowsRegistrationBackend {
    fn initialize_com(&mut self) -> Result<(), OperationError> {
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        result.ok().map_err(windows_error)?;
        self.com_initialized = true;
        Ok(())
    }

    fn probe_com_registration(
        &mut self,
        expected_dll_path: &str,
    ) -> Result<ExistingComRegistration, OperationError> {
        if open_registry_key(&clsid_registry_path(), KEY_READ)?.is_some()
            && open_registry_key(&inproc_registry_path(), KEY_READ)?.is_none()
        {
            return Ok(ExistingComRegistration::Conflicting);
        }
        match read_com_registration()? {
            None => Ok(ExistingComRegistration::Absent),
            Some(existing)
                if existing.dll_path == expected_dll_path
                    && existing.threading_model == "Apartment" =>
            {
                Ok(ExistingComRegistration::Exact)
            }
            Some(_) => Ok(ExistingComRegistration::Conflicting),
        }
    }

    fn write_com_registration(&mut self, dll_path: &str) -> Result<(), OperationError> {
        write_com_registration(dll_path)
    }

    fn verify_com_registration(&mut self, dll_path: &str) -> Result<(), OperationError> {
        match read_com_registration()? {
            Some(existing)
                if existing.dll_path == dll_path && existing.threading_model == "Apartment" =>
            {
                Ok(())
            }
            Some(_) => Err(OperationError::new(
                E_FAIL,
                "InprocServer32 does not exactly match the supplied DLL path and ThreadingModel=Apartment",
            )),
            None => Err(OperationError::new(
                E_FAIL,
                "prototype InprocServer32 key was not found after registration",
            )),
        }
    }

    fn com_registration_exists(&mut self) -> Result<bool, OperationError> {
        Ok(open_registry_key(&clsid_registry_path(), KEY_READ)?.is_some())
    }

    fn remove_com_registration(&mut self) -> Result<(), OperationError> {
        remove_com_registration()
    }

    fn create_profiles(&mut self) -> Result<(), OperationError> {
        let profiles = unsafe {
            CoCreateInstance(&CLSID_TF_InputProcessorProfiles, None, CLSCTX_INPROC_SERVER)
        }
        .map_err(windows_error)?;
        self.profiles = Some(profiles);
        Ok(())
    }

    fn service_registered(&mut self) -> Result<bool, OperationError> {
        let enumerator =
            unsafe { self.profiles()?.EnumInputProcessorInfo() }.map_err(windows_error)?;
        guid_enumerator_contains(&enumerator, &TEXT_SERVICE_CLSID)
    }

    fn register_service(&mut self) -> Result<(), OperationError> {
        unsafe { self.profiles()?.Register(&TEXT_SERVICE_CLSID) }.map_err(windows_error)
    }

    fn unregister_service(&mut self) -> Result<(), OperationError> {
        unsafe { self.profiles()?.Unregister(&TEXT_SERVICE_CLSID) }.map_err(windows_error)
    }

    fn profile_registered(&mut self, profile: Profile) -> Result<bool, OperationError> {
        let enumerator = unsafe { self.profiles()?.EnumLanguageProfiles(profile.language()) }
            .map_err(windows_error)?;
        loop {
            let mut values = [TF_LANGUAGEPROFILE::default()];
            let mut fetched = 0u32;
            unsafe { enumerator.Next(&mut values, &mut fetched) }.map_err(windows_error)?;
            if fetched == 0 {
                return Ok(false);
            }
            if values[0].clsid == TEXT_SERVICE_CLSID && values[0].guidProfile == profile.guid() {
                return Ok(true);
            }
        }
    }

    fn add_profile(&mut self, profile: Profile) -> Result<(), OperationError> {
        let description = format!("{SERVICE_DESCRIPTION} — {}", profile.description_suffix())
            .encode_utf16()
            .collect::<Vec<_>>();
        let profiles = self.profiles()?;
        let result = unsafe {
            (Interface::vtable(profiles).AddLanguageProfile)(
                Interface::as_raw(profiles),
                &TEXT_SERVICE_CLSID,
                profile.language(),
                &profile.guid(),
                PCWSTR(description.as_ptr()),
                description.len() as u32,
                PCWSTR::null(),
                0,
                0,
            )
        };
        result.ok().map_err(windows_error)
    }

    fn profile_enabled(&mut self, profile: Profile) -> Result<bool, OperationError> {
        unsafe {
            self.profiles()?.IsEnabledLanguageProfile(
                &TEXT_SERVICE_CLSID,
                profile.language(),
                &profile.guid(),
            )
        }
        .map(|enabled| enabled.as_bool())
        .map_err(windows_error)
    }

    fn set_profile_enabled(
        &mut self,
        profile: Profile,
        enabled: bool,
    ) -> Result<(), OperationError> {
        unsafe {
            self.profiles()?.EnableLanguageProfile(
                &TEXT_SERVICE_CLSID,
                profile.language(),
                &profile.guid(),
                enabled,
            )
        }
        .map_err(windows_error)
    }

    fn remove_profile(&mut self, profile: Profile) -> Result<(), OperationError> {
        unsafe {
            self.profiles()?.RemoveLanguageProfile(
                &TEXT_SERVICE_CLSID,
                profile.language(),
                &profile.guid(),
            )
        }
        .map_err(windows_error)
    }

    fn create_category_manager(&mut self) -> Result<(), OperationError> {
        let categories =
            unsafe { CoCreateInstance(&CLSID_TF_CategoryMgr, None, CLSCTX_INPROC_SERVER) }
                .map_err(windows_error)?;
        self.categories = Some(categories);
        Ok(())
    }

    fn category_registered(&mut self) -> Result<bool, OperationError> {
        let enumerator = unsafe { self.categories()?.EnumCategoriesInItem(&TEXT_SERVICE_CLSID) }
            .map_err(windows_error)?;
        guid_enumerator_contains(&enumerator, &GUID_TFCAT_TIP_KEYBOARD)
    }

    fn register_category(&mut self) -> Result<(), OperationError> {
        unsafe {
            self.categories()?.RegisterCategory(
                &TEXT_SERVICE_CLSID,
                &GUID_TFCAT_TIP_KEYBOARD,
                &TEXT_SERVICE_CLSID,
            )
        }
        .map_err(windows_error)
    }

    fn unregister_category(&mut self) -> Result<(), OperationError> {
        unsafe {
            self.categories()?.UnregisterCategory(
                &TEXT_SERVICE_CLSID,
                &GUID_TFCAT_TIP_KEYBOARD,
                &TEXT_SERVICE_CLSID,
            )
        }
        .map_err(windows_error)
    }
}

/// Installs the x64 development prototype for deliberate manual validation.
///
/// This function does not activate the profile or change the user's current input method.
pub fn register(dll_path: &Path) -> Result<CommandReport, CommandFailure> {
    if !dll_path.is_absolute() || !dll_path.is_file() {
        return Err(registration_workflow::validation_failure(
            OperationError::new(
                E_INVALIDARG,
                "register requires an existing absolute DLL path",
            ),
        ));
    }
    if dll_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("dll"))
    {
        return Err(registration_workflow::validation_failure(
            OperationError::new(E_INVALIDARG, "register requires a DLL path"),
        ));
    }

    let dll_path = dll_path.to_string_lossy();
    let mut backend = WindowsRegistrationBackend::default();
    registration_workflow::run_register(&mut backend, &dll_path)
}

/// Removes both development language profiles, the TSF category, service registration, and x64
/// COM in-process server registration. It does not alter unrelated input methods.
pub fn unregister() -> Result<CommandReport, CommandFailure> {
    let mut backend = WindowsRegistrationBackend::default();
    registration_workflow::run_unregister(&mut backend)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registration_workflow::Stage;

    #[test]
    fn registry_identity_is_stable_and_scoped_to_this_development_class() {
        let path = inproc_registry_path();
        assert!(path.starts_with("SOFTWARE\\Classes\\CLSID\\{"));
        assert!(path.ends_with("\\InprocServer32"));
        assert!(path.contains(&clsid_registry_name()));
    }

    #[test]
    fn registration_requires_an_explicit_absolute_dll_path_before_any_system_write() {
        let result = register(Path::new("relative.dll"));
        assert_eq!(result.unwrap_err().stage(), Stage::ValidateDllPath.name());
    }
}

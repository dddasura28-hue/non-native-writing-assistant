use keyring::{Entry, Error as KeyringError};

pub const CREDENTIAL_SERVICE: &str = "com.nonnativewriting.assistant.provider-credentials";
const MAX_SECRET_REF_LEN: usize = 128;

trait CredentialBackend {
    fn set(&self, secret_ref: &str, secret: &str) -> Result<(), ()>;
    fn get(&self, secret_ref: &str) -> Result<Option<String>, ()>;
    fn delete(&self, secret_ref: &str) -> Result<(), ()>;
}

struct NativeCredentialBackend;

impl NativeCredentialBackend {
    fn entry(secret_ref: &str) -> Result<Entry, ()> {
        Entry::new(CREDENTIAL_SERVICE, secret_ref).map_err(|_| ())
    }
}

impl CredentialBackend for NativeCredentialBackend {
    fn set(&self, secret_ref: &str, secret: &str) -> Result<(), ()> {
        Self::entry(secret_ref)?
            .set_password(secret)
            .map_err(|_| ())
    }

    fn get(&self, secret_ref: &str) -> Result<Option<String>, ()> {
        match Self::entry(secret_ref)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(_) => Err(()),
        }
    }

    fn delete(&self, secret_ref: &str) -> Result<(), ()> {
        match Self::entry(secret_ref)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

#[tauri::command]
pub fn set_provider_secret(secret_ref: String, secret: String) -> Result<(), String> {
    set_secret(&NativeCredentialBackend, &secret_ref, &secret)
}

#[tauri::command]
pub fn get_provider_secret(secret_ref: String) -> Result<Option<String>, String> {
    get_secret(&NativeCredentialBackend, &secret_ref)
}

#[tauri::command]
pub fn has_provider_secret(secret_ref: String) -> Result<bool, String> {
    get_secret(&NativeCredentialBackend, &secret_ref).map(|secret| secret.is_some())
}

#[tauri::command]
pub fn delete_provider_secret(secret_ref: String) -> Result<(), String> {
    delete_secret(&NativeCredentialBackend, &secret_ref)
}

fn set_secret(
    backend: &impl CredentialBackend,
    secret_ref: &str,
    secret: &str,
) -> Result<(), String> {
    validate_secret_ref(secret_ref)?;
    if secret.trim().is_empty() {
        return Err("Credential must not be empty.".into());
    }
    backend
        .set(secret_ref, secret)
        .map_err(|_| "The operating system credential store could not save the credential.".into())
}

fn get_secret(
    backend: &impl CredentialBackend,
    secret_ref: &str,
) -> Result<Option<String>, String> {
    validate_secret_ref(secret_ref)?;
    backend
        .get(secret_ref)
        .map_err(|_| "The operating system credential store could not read the credential.".into())
}

fn delete_secret(backend: &impl CredentialBackend, secret_ref: &str) -> Result<(), String> {
    validate_secret_ref(secret_ref)?;
    backend.delete(secret_ref).map_err(|_| {
        "The operating system credential store could not remove the credential.".into()
    })
}

fn validate_secret_ref(secret_ref: &str) -> Result<(), String> {
    let valid_length = !secret_ref.is_empty() && secret_ref.len() <= MAX_SECRET_REF_LEN;
    let valid_characters = secret_ref.chars().enumerate().all(|(index, character)| {
        character.is_ascii_alphanumeric()
            || (index > 0 && matches!(character, '.' | '_' | ':' | '-'))
    });
    if valid_length && valid_characters {
        Ok(())
    } else {
        Err("The credential reference is invalid.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeCredentialBackend {
        values: Mutex<HashMap<String, String>>,
        fails: bool,
    }

    impl CredentialBackend for FakeCredentialBackend {
        fn set(&self, secret_ref: &str, secret: &str) -> Result<(), ()> {
            if self.fails {
                return Err(());
            }
            self.values
                .lock()
                .unwrap()
                .insert(secret_ref.into(), secret.into());
            Ok(())
        }

        fn get(&self, secret_ref: &str) -> Result<Option<String>, ()> {
            if self.fails {
                return Err(());
            }
            Ok(self.values.lock().unwrap().get(secret_ref).cloned())
        }

        fn delete(&self, secret_ref: &str) -> Result<(), ()> {
            if self.fails {
                return Err(());
            }
            self.values.lock().unwrap().remove(secret_ref);
            Ok(())
        }
    }

    #[test]
    fn service_namespace_is_fixed() {
        assert_eq!(
            CREDENTIAL_SERVICE,
            "com.nonnativewriting.assistant.provider-credentials"
        );
    }

    #[test]
    fn validates_secret_references() {
        assert!(validate_secret_ref("provider-credential.profile_1").is_ok());
        assert!(validate_secret_ref("").is_err());
        assert!(validate_secret_ref("-starts-with-punctuation").is_err());
        assert!(validate_secret_ref("spaces are forbidden").is_err());
    }

    #[test]
    fn fake_backend_supports_set_get_delete_and_missing() {
        let backend = FakeCredentialBackend::default();
        assert_eq!(get_secret(&backend, "profile-one").unwrap(), None);
        set_secret(&backend, "profile-one", "super-secret").unwrap();
        assert_eq!(
            get_secret(&backend, "profile-one").unwrap(),
            Some("super-secret".into())
        );
        delete_secret(&backend, "profile-one").unwrap();
        assert_eq!(get_secret(&backend, "profile-one").unwrap(), None);
    }

    #[test]
    fn backend_errors_are_safe_and_do_not_contain_secrets() {
        let backend = FakeCredentialBackend {
            fails: true,
            ..Default::default()
        };
        let secret = "must-never-appear";
        let error = set_secret(&backend, "profile-one", secret).unwrap_err();
        assert!(!error.contains(secret));
        assert_eq!(
            error,
            "The operating system credential store could not save the credential."
        );
    }
}

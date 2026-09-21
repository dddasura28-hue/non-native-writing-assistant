use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE_NAME: &str = "provider-settings.json";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSettings {
    pub active_profile_id: Option<String>,
    pub profiles: Vec<ProviderProfile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub provider_id: String,
    pub model_id: String,
    pub secret_ref: String,
    pub base_url: Option<String>,
    pub compatibility_mode: Option<String>,
    pub enabled: bool,
}

#[tauri::command]
pub fn load_provider_settings(app: AppHandle) -> Result<ProviderSettings, String> {
    load_from_path(&settings_path(&app)?)
}

#[tauri::command]
pub fn save_provider_settings(app: AppHandle, settings: ProviderSettings) -> Result<(), String> {
    save_to_path(&settings_path(&app)?, &settings)
}

pub fn load_for_transport(app: &AppHandle) -> Result<ProviderSettings, String> {
    load_from_path(&settings_path(app)?)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(SETTINGS_FILE_NAME))
        .map_err(|_| "The provider settings location is unavailable.".into())
}

fn load_from_path(path: &Path) -> Result<ProviderSettings, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProviderSettings::default())
        }
        Err(_) => return Err("Provider settings could not be read.".into()),
    };
    Ok(serde_json::from_str(&contents).unwrap_or_default())
}

fn save_to_path(path: &Path, settings: &ProviderSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Provider settings could not be saved.".to_string())?;
    }
    let serialized = serde_json::to_vec_pretty(settings)
        .map_err(|_| "Provider settings could not be saved.".to_string())?;
    fs::write(path, serialized).map_err(|_| "Provider settings could not be saved.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_settings_fall_back_to_empty() {
        let directory = std::env::temp_dir().join(format!(
            "non-native-writing-settings-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("malformed.json");
        fs::write(&path, "{not json").unwrap();
        let loaded = load_from_path(&path).unwrap();
        assert!(loaded.profiles.is_empty());
        assert!(loaded.active_profile_id.is_none());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn settings_schema_has_no_secret_value_field() {
        let profile = ProviderProfile {
            id: "one".into(),
            name: "OpenAI".into(),
            provider_id: "openai".into(),
            model_id: "model".into(),
            secret_ref: "provider-credential-one".into(),
            base_url: None,
            compatibility_mode: None,
            enabled: true,
        };
        let serialized = serde_json::to_string(&ProviderSettings {
            active_profile_id: Some("one".into()),
            profiles: vec![profile],
        })
        .unwrap();
        assert!(serialized.contains("secretRef"));
        assert!(!serialized.contains("apiKey"));
        assert!(!serialized.contains("Authorization"));
    }

    #[test]
    fn settings_can_be_saved_and_replaced() {
        let directory = std::env::temp_dir().join(format!(
            "non-native-writing-settings-save-{}",
            std::process::id()
        ));
        let path = directory.join("provider-settings.json");
        let mut settings = ProviderSettings::default();
        save_to_path(&path, &settings).unwrap();
        settings.active_profile_id = Some("replacement".into());
        save_to_path(&path, &settings).unwrap();
        assert_eq!(
            load_from_path(&path).unwrap().active_profile_id.as_deref(),
            Some("replacement")
        );
        let _ = fs::remove_dir_all(directory);
    }
}

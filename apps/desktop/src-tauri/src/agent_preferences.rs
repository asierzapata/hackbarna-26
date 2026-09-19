use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::agent::{AuthMode, Provider};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub provider: Option<Provider>,
    pub mode: Option<AuthMode>,
    pub model_id: Option<String>,
    #[serde(default)]
    pub auto_connect: bool,
}

pub fn load(app: &AppHandle) -> Result<Preferences, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("agent-preferences.json");
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Could not read saved AI preferences".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(_) => Err("Could not read saved AI preferences".into()),
    }
}

pub fn save(app: &AppHandle, preferences: &Preferences) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let temporary = dir.join("agent-preferences.json.tmp");
    std::fs::write(&temporary, serde_json::to_vec(preferences).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(temporary, dir.join("agent-preferences.json")).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn entry(app: &AppHandle, provider: Provider) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&format!("{}.agent", app.config().identifier), match provider {
        Provider::Devin => "devin-api-key",
        Provider::Openai => "openai-api-key",
    }).map_err(|_| "Could not access macOS Keychain".into())
}

#[cfg(target_os = "macos")]
pub fn read_key(app: &AppHandle, provider: Provider) -> Result<String, String> {
    entry(app, provider)?.get_password().map_err(|_| "Saved API key is unavailable. Unlock macOS Keychain or sign in again.".into())
}

#[cfg(target_os = "macos")]
pub fn write_key(app: &AppHandle, provider: Provider, key: &str) -> Result<(), String> {
    entry(app, provider)?.set_password(key).map_err(|_| "Could not save API key in macOS Keychain. Allow Keychain access and try again.".into())
}

#[cfg(target_os = "macos")]
pub fn delete_key(app: &AppHandle, provider: Provider) -> Result<(), String> {
    match entry(app, provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove saved API key from macOS Keychain".into()),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn read_key(_: &AppHandle, _: Provider) -> Result<String, String> {
    Err("Remembered API keys currently require macOS Keychain".into())
}

#[cfg(not(target_os = "macos"))]
pub fn write_key(_: &AppHandle, _: Provider, _: &str) -> Result<(), String> {
    Err("Remembered API keys currently require macOS Keychain".into())
}

#[cfg(not(target_os = "macos"))]
pub fn delete_key(_: &AppHandle, _: Provider) -> Result<(), String> { Ok(()) }

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Models {
    pub available: Vec<Model>,
    pub current: Option<String>,
    #[serde(skip)]
    pub config_id: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct Model {
    pub id: String,
    pub label: String,
}

impl Models {
    pub fn parse(result: &Value) -> Self {
        if let Some(option) = result.get("configOptions").and_then(Value::as_array).and_then(|options| {
            options.iter().find(|o| o.get("category").and_then(Value::as_str) == Some("model") && o.get("type").and_then(Value::as_str) == Some("select"))
        }) {
            fn choices(values: &Value, models: &mut Vec<Model>) {
                if let Some(options) = values.as_array() {
                    for option in options {
                        if let Some(id) = option.get("value").and_then(Value::as_str) {
                            models.push(Model { id: id.into(), label: option.get("name").and_then(Value::as_str).unwrap_or(id).into() });
                        } else if let Some(group) = option.get("options") {
                            choices(group, models);
                        }
                    }
                }
            }
            let mut available = Vec::new();
            choices(&option["options"], &mut available);
            return Self {
                available,
                current: option.get("currentValue").and_then(Value::as_str).map(str::to_string),
                config_id: option.get("id").and_then(Value::as_str).map(str::to_string),
            };
        }
        let models = &result["models"];
        Self {
            available: models.get("availableModels").and_then(Value::as_array).into_iter().flatten().filter_map(|model| {
                let id = model.get("modelId")?.as_str()?;
                Some(Model { id: id.into(), label: model.get("name").and_then(Value::as_str).unwrap_or(id).into() })
            }).collect(),
            current: models.get("currentModelId").and_then(Value::as_str).map(str::to_string),
            config_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_grouped_model_config_without_exposing_other_options() {
        let models = Models::parse(&json!({ "configOptions": [
            { "id": "mode", "category": "mode", "type": "select", "options": [{ "value": "danger", "name": "Danger" }] },
            { "id": "llm", "category": "model", "type": "select", "currentValue": "b", "options": [
                { "value": "a", "name": "Model A" }, { "group": "Others", "options": [{ "value": "b", "name": "Model B" }] }
            ] }
        ] }));
        assert_eq!(models.available.len(), 2);
        assert_eq!(models.available[1].label, "Model B");
        assert_eq!(models.current.as_deref(), Some("b"));
        assert_eq!(models.config_id.as_deref(), Some("llm"));
    }

    #[test]
    fn supports_legacy_models_and_missing_capability() {
        let models = Models::parse(&json!({ "models": { "currentModelId": "a", "availableModels": [{ "modelId": "a", "name": "A" }] } }));
        assert_eq!(models.available[0].id, "a");
        assert!(models.config_id.is_none());
        assert!(Models::parse(&json!({})).available.is_empty());
    }

    #[test]
    fn preferences_contain_no_credentials_and_default_to_no_reconnect() {
        let preferences: Preferences = serde_json::from_value(json!({"provider":"devin", "mode":"subscription", "modelId":"a"})).unwrap();
        assert!(!preferences.auto_connect);
        let value = serde_json::to_value(preferences).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 4);
        assert!(value.get("apiKey").is_none());
    }
}

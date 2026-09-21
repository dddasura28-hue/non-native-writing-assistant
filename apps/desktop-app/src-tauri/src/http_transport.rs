use crate::provider_settings::{load_for_transport, ProviderProfile};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::AppHandle;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpTransportRequest {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpTransportResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

#[tauri::command]
pub async fn send_provider_http_request(
    app: AppHandle,
    request: HttpTransportRequest,
) -> Result<HttpTransportResponse, String> {
    if request.method != "POST" {
        return Err("The provider request method is not allowed.".into());
    }
    let settings = load_for_transport(&app)?;
    let active_id = settings
        .active_profile_id
        .ok_or_else(|| "A valid provider configuration is required.".to_string())?;
    let profile = settings
        .profiles
        .iter()
        .find(|profile| profile.id == active_id && profile.enabled)
        .ok_or_else(|| "A valid provider configuration is required.".to_string())?;
    validate_request_url(&request.url, profile)?;

    let headers = validated_headers(request.headers)?;
    let client = Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|_| "The provider network client could not be initialized.".to_string())?;
    let response = client
        .post(request.url)
        .headers(headers)
        .body(request.body)
        .send()
        .await
        .map_err(|_| "The provider network request failed.".to_string())?;
    let status = response.status().as_u16();
    let response_headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_owned(), value.to_owned()))
        })
        .collect();
    let body = response
        .text()
        .await
        .map_err(|_| "The provider response could not be read.".to_string())?;
    Ok(HttpTransportResponse {
        status,
        headers: response_headers,
        body,
    })
}

fn validated_headers(headers: HashMap<String, String>) -> Result<HeaderMap, String> {
    let mut output = HeaderMap::new();
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "The provider request contains an invalid header.".to_string())?;
        let value = HeaderValue::from_str(&value)
            .map_err(|_| "The provider request contains an invalid header.".to_string())?;
        output.insert(name, value);
    }
    Ok(output)
}

fn validate_request_url(request_url: &str, profile: &ProviderProfile) -> Result<(), String> {
    let base_url = profile
        .base_url
        .as_deref()
        .ok_or_else(|| "A provider base URL is required.".to_string())?;
    let request =
        Url::parse(request_url).map_err(|_| "The provider request URL is invalid.".to_string())?;
    let base = Url::parse(base_url).map_err(|_| "The provider base URL is invalid.".to_string())?;
    validate_safe_url(&request)?;
    validate_safe_url(&base)?;
    let base_path = base.path().trim_end_matches('/');
    let request_path = request.path();
    let path_matches = request_path == base_path
        || request_path
            .strip_prefix(base_path)
            .is_some_and(|suffix| suffix.starts_with('/'));
    if request.scheme() != base.scheme()
        || request.host_str() != base.host_str()
        || request.port_or_known_default() != base.port_or_known_default()
        || !path_matches
    {
        return Err("The provider request does not match the active profile endpoint.".into());
    }
    Ok(())
}

fn validate_safe_url(url: &Url) -> Result<(), String> {
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    let safe_scheme = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !safe_scheme
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err("The provider endpoint must use HTTPS or explicit loopback HTTP.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(provider_id: &str, base_url: Option<&str>) -> ProviderProfile {
        ProviderProfile {
            id: "profile".into(),
            name: "Profile".into(),
            provider_id: provider_id.into(),
            model_id: "model".into(),
            secret_ref: "provider-credential-profile".into(),
            base_url: base_url.map(str::to_owned),
            compatibility_mode: Some("json-schema".into()),
            enabled: true,
        }
    }

    #[test]
    fn permits_only_the_active_profile_endpoint() {
        let openai = profile("openai", Some("https://api.openai.com/v1"));
        assert!(validate_request_url("https://api.openai.com/v1/responses", &openai).is_ok());
        assert!(validate_request_url("https://evil.example/v1/responses", &openai).is_err());
    }

    #[test]
    fn custom_endpoint_requires_https_except_for_exact_loopback() {
        assert!(validate_request_url(
            "https://api.deepseek.com/v1/chat/completions",
            &profile("openai-compatible", Some("https://api.deepseek.com/v1"))
        )
        .is_ok());
        assert!(validate_request_url(
            "http://localhost:11434/v1/chat/completions",
            &profile("openai-compatible", Some("http://localhost:11434/v1"))
        )
        .is_ok());
        assert!(validate_request_url(
            "http://api.example.com/v1/chat/completions",
            &profile("openai-compatible", Some("http://api.example.com/v1"))
        )
        .is_err());
    }
}

//! Rust-owned remote model transport and normalization boundary.
//!
//! The webview must never construct provider HTTP requests or receive provider credentials.
//! This first executable slice certifies one-shot OpenAI Responses requests against a fake
//! loopback server. Credential persistence, streaming, UI invocation, and live-provider calls
//! remain deliberately unavailable until their separate gates pass.

#![allow(dead_code)] // The runtime remains intentionally unwired until credential-vault review.

use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;

pub const OPENAI_ADAPTER_STATUS: &str = "request-conformance";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteProviderId {
    OpenAi,
}

/// Secret wrapper whose debug representation cannot disclose the credential.
pub struct ProviderSecret(String);

impl ProviderSecret {
    pub fn new(value: String) -> Result<Self, ProviderError> {
        if value.trim().is_empty() || value.contains(['\r', '\n']) {
            return Err(ProviderError::InvalidSecret);
        }
        Ok(Self(value))
    }

    fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProviderSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderSecret([REDACTED])")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransmissionApproval {
    pub provider: RemoteProviderId,
    pub content_categories: Vec<String>,
    pub accepted: bool,
}

impl TransmissionApproval {
    fn validate_for(&self, provider: RemoteProviderId) -> Result<(), ProviderError> {
        if !self.accepted || self.provider != provider {
            return Err(ProviderError::DisclosureRequired);
        }
        if self.content_categories.is_empty()
            || self.content_categories.len() > 20
            || self
                .content_categories
                .iter()
                .any(|category| category.trim().is_empty() || category.chars().count() > 100)
        {
            return Err(ProviderError::InvalidDisclosure);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InputRole {
    Developer,
    User,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderInput {
    pub role: InputRole,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationRequest {
    pub model: String,
    pub input: Vec<ProviderInput>,
    pub max_output_tokens: u32,
}

impl GenerationRequest {
    fn validate(&self) -> Result<(), ProviderError> {
        if self.model.trim().is_empty()
            || self.model.chars().count() > 200
            || self.input.is_empty()
            || self.input.len() > 200
            || self
                .input
                .iter()
                .any(|item| item.content.is_empty() || item.content.len() > 4 * 1024 * 1024)
            || !(1..=1_000_000).contains(&self.max_output_tokens)
        {
            return Err(ProviderError::InvalidRequest);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedResponse {
    pub provider: RemoteProviderId,
    pub id: String,
    pub status: String,
    pub model: Option<String>,
    pub text: String,
    pub refusals: Vec<String>,
    pub unknown_output_types: Vec<String>,
    pub usage: Option<NormalizedUsage>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderError {
    InvalidSecret,
    InvalidRequest,
    DisclosureRequired,
    InvalidDisclosure,
    UnsafeEndpoint,
    Transport,
    HttpStatus(u16),
    ResponseTooLarge,
    MalformedResponse,
}

impl fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSecret => formatter.write_str("Provider credential is invalid"),
            Self::InvalidRequest => formatter.write_str("Provider request is invalid"),
            Self::DisclosureRequired => {
                formatter.write_str("Matching remote-content disclosure approval is required")
            }
            Self::InvalidDisclosure => formatter.write_str("Disclosure categories are invalid"),
            Self::UnsafeEndpoint => formatter
                .write_str("Remote providers require HTTPS; tests may use literal loopback HTTP"),
            Self::Transport => formatter.write_str("Provider transport failed"),
            Self::HttpStatus(status) => write!(formatter, "Provider returned HTTP status {status}"),
            Self::ResponseTooLarge => {
                formatter.write_str("Provider response exceeded the size limit")
            }
            Self::MalformedResponse => formatter.write_str("Provider response was malformed"),
        }
    }
}

fn validate_endpoint(endpoint: &Url) -> Result<(), ProviderError> {
    let literal_loopback = matches!(endpoint.host_str(), Some("127.0.0.1" | "::1"));
    let allowed_scheme =
        endpoint.scheme() == "https" || (endpoint.scheme() == "http" && literal_loopback);
    if !allowed_scheme
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || endpoint.path() != "/v1/responses"
    {
        return Err(ProviderError::UnsafeEndpoint);
    }
    Ok(())
}

fn openai_body(request: &GenerationRequest) -> Value {
    json!({
        "model": request.model,
        "input": request.input.iter().map(|item| json!({
            "role": item.role,
            "content": item.content,
        })).collect::<Vec<_>>(),
        "max_output_tokens": request.max_output_tokens,
        "store": false,
    })
}

async fn bounded_body(response: reqwest::Response) -> Result<Vec<u8>, ProviderError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ProviderError::ResponseTooLarge);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ProviderError::Transport)?;
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(ProviderError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn normalize_openai(value: Value) -> Result<NormalizedResponse, ProviderError> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or(ProviderError::MalformedResponse)?
        .to_owned();
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .filter(|status| !status.is_empty())
        .ok_or(ProviderError::MalformedResponse)?
        .to_owned();
    let output = value
        .get("output")
        .and_then(Value::as_array)
        .ok_or(ProviderError::MalformedResponse)?;
    let mut text = String::new();
    let mut refusals = Vec::new();
    let mut unknown_output_types = Vec::new();
    for item in output {
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("missing");
        if item_type != "message" {
            unknown_output_types.push(item_type.to_owned());
            continue;
        }
        let content = item
            .get("content")
            .and_then(Value::as_array)
            .ok_or(ProviderError::MalformedResponse)?;
        for part in content {
            match part.get("type").and_then(Value::as_str) {
                Some("output_text") => {
                    let delta = part
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or(ProviderError::MalformedResponse)?;
                    text.push_str(delta);
                }
                Some("refusal") => {
                    let refusal = part
                        .get("refusal")
                        .and_then(Value::as_str)
                        .ok_or(ProviderError::MalformedResponse)?;
                    refusals.push(refusal.to_owned());
                }
                Some(other) => unknown_output_types.push(format!("message:{other}")),
                None => unknown_output_types.push("message:missing".to_owned()),
            }
        }
    }
    let usage = match value.get("usage") {
        None | Some(Value::Null) => None,
        Some(usage) => Some(NormalizedUsage {
            input_tokens: usage
                .get("input_tokens")
                .and_then(Value::as_u64)
                .ok_or(ProviderError::MalformedResponse)?,
            output_tokens: usage
                .get("output_tokens")
                .and_then(Value::as_u64)
                .ok_or(ProviderError::MalformedResponse)?,
            total_tokens: usage
                .get("total_tokens")
                .and_then(Value::as_u64)
                .ok_or(ProviderError::MalformedResponse)?,
        }),
    };
    Ok(NormalizedResponse {
        provider: RemoteProviderId::OpenAi,
        id,
        status,
        model: value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
        text,
        refusals,
        unknown_output_types,
        usage,
    })
}

pub async fn execute_openai_response(
    client: &Client,
    endpoint: &Url,
    secret: &ProviderSecret,
    request: &GenerationRequest,
    approval: &TransmissionApproval,
) -> Result<NormalizedResponse, ProviderError> {
    validate_endpoint(endpoint)?;
    request.validate()?;
    approval.validate_for(RemoteProviderId::OpenAi)?;
    let response = client
        .post(endpoint.clone())
        .bearer_auth(secret.expose())
        .header("content-type", "application/json")
        .json(&openai_body(request))
        .send()
        .await
        .map_err(|_| ProviderError::Transport)?;
    if !response.status().is_success() {
        return Err(ProviderError::HttpStatus(response.status().as_u16()));
    }
    let body = bounded_body(response).await?;
    let value = serde_json::from_slice(&body).map_err(|_| ProviderError::MalformedResponse)?;
    normalize_openai(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    fn request() -> GenerationRequest {
        GenerationRequest {
            model: "research-model".to_owned(),
            input: vec![ProviderInput {
                role: InputRole::User,
                content: "Compare the cited claims.".to_owned(),
            }],
            max_output_tokens: 700,
        }
    }

    fn approval() -> TransmissionApproval {
        TransmissionApproval {
            provider: RemoteProviderId::OpenAi,
            content_categories: vec!["selected research excerpts".to_owned()],
            accepted: true,
        }
    }

    fn fake_server(status: &str, body: &str) -> (Url, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback fake provider");
        let address = listener.local_addr().expect("fake provider address");
        let (sender, receiver) = mpsc::channel();
        let status = status.to_owned();
        let body = body.to_owned();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept provider request");
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 2048];
            let header_end;
            loop {
                let read = stream.read(&mut buffer).expect("read provider request");
                assert!(read > 0, "provider request ended before headers");
                bytes.extend_from_slice(&buffer[..read]);
                if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                    header_end = position + 4;
                    break;
                }
            }
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().expect("content length"))
                })
                .expect("content length header");
            while bytes.len() < header_end + content_length {
                let read = stream.read(&mut buffer).expect("read provider body");
                assert!(read > 0, "provider request ended before body");
                bytes.extend_from_slice(&buffer[..read]);
            }
            sender
                .send(String::from_utf8(bytes).expect("UTF-8 request fixture"))
                .expect("send captured request");
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .expect("write fake response");
        });
        (
            Url::parse(&format!("http://{address}/v1/responses")).expect("fake URL"),
            receiver,
        )
    }

    #[test]
    fn secret_debug_is_redacted_and_header_injection_fails_closed() {
        let canary = "sk-secret-canary";
        let secret = ProviderSecret::new(canary.to_owned()).expect("valid fixture secret");
        let rendered = format!("{secret:?}");
        assert!(!rendered.contains(canary));
        assert!(rendered.contains("REDACTED"));
        assert!(matches!(
            ProviderSecret::new("bad\r\nheader".to_owned()),
            Err(ProviderError::InvalidSecret)
        ));
    }

    #[test]
    fn endpoint_and_disclosure_fail_before_transport() {
        let client = Client::new();
        let secret = ProviderSecret::new("fixture-key".to_owned()).expect("secret");
        let endpoint = Url::parse("http://api.openai.com/v1/responses").expect("URL");
        let result = tauri::async_runtime::block_on(execute_openai_response(
            &client,
            &endpoint,
            &secret,
            &request(),
            &approval(),
        ));
        assert_eq!(result, Err(ProviderError::UnsafeEndpoint));

        let endpoint = Url::parse("https://api.openai.com/v1/responses").expect("URL");
        let mut rejected = approval();
        rejected.accepted = false;
        let result = tauri::async_runtime::block_on(execute_openai_response(
            &client,
            &endpoint,
            &secret,
            &request(),
            &rejected,
        ));
        assert_eq!(result, Err(ProviderError::DisclosureRequired));
    }

    #[test]
    fn fake_server_proves_storage_off_wire_shape_and_normalization() {
        let (endpoint, captured) = fake_server(
            "200 OK",
            r#"{"id":"resp_test","status":"completed","model":"research-model","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Supported finding.","annotations":[]}]}],"usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}"#,
        );
        let secret_canary = "sk-wire-canary";
        let secret = ProviderSecret::new(secret_canary.to_owned()).expect("secret");
        let response = tauri::async_runtime::block_on(execute_openai_response(
            &Client::new(),
            &endpoint,
            &secret,
            &request(),
            &approval(),
        ))
        .expect("normalized fake-provider response");
        assert_eq!(response.text, "Supported finding.");
        assert_eq!(response.usage.expect("usage").total_tokens, 16);

        let raw = captured.recv().expect("captured request");
        let (headers, body) = raw.split_once("\r\n\r\n").expect("HTTP request");
        assert!(headers.starts_with("POST /v1/responses HTTP/1.1"));
        assert!(headers
            .to_ascii_lowercase()
            .contains(&format!("authorization: bearer {}", secret_canary)));
        let body: Value = serde_json::from_str(body).expect("request JSON");
        assert_eq!(body["store"], false);
        assert_eq!(body["model"], "research-model");
        assert_eq!(body["input"][0]["role"], "user");
        assert_eq!(body["max_output_tokens"], 700);
    }

    #[test]
    fn provider_error_body_and_secret_are_not_returned() {
        let response_canary = "response-body-canary";
        let secret_canary = "secret-canary";
        let (endpoint, _captured) = fake_server(
            "401 Unauthorized",
            &format!(r#"{{"error":"{response_canary}"}}"#),
        );
        let error = tauri::async_runtime::block_on(execute_openai_response(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new(secret_canary.to_owned()).expect("secret"),
            &request(),
            &approval(),
        ))
        .expect_err("401 must fail");
        let rendered = error.to_string();
        assert_eq!(error, ProviderError::HttpStatus(401));
        assert!(!rendered.contains(response_canary));
        assert!(!rendered.contains(secret_canary));
    }

    #[test]
    fn malformed_response_fails_closed() {
        let (endpoint, _captured) = fake_server("200 OK", r#"{"id":"resp_missing_output"}"#);
        let result = tauri::async_runtime::block_on(execute_openai_response(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
            &request(),
            &approval(),
        ));
        assert_eq!(result, Err(ProviderError::MalformedResponse));
    }

    #[test]
    fn partial_usage_accounting_fails_closed() {
        let value = json!({
            "id": "resp_partial_usage",
            "status": "completed",
            "output": [],
            "usage": { "input_tokens": 12, "output_tokens": 4 }
        });
        assert_eq!(
            normalize_openai(value),
            Err(ProviderError::MalformedResponse)
        );
    }
}

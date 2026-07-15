//! Rust-owned remote model transport and normalization boundary.
//!
//! The webview must never construct provider HTTP requests or receive provider credentials.
//! Executable slices certify OpenAI Responses request/stream plus Anthropic Messages, Gemini
//! Interactions, and xAI Responses one-shot contracts against fake loopback servers. Product credential integration, frontend event
//! delivery, UI invocation, and live-provider calls remain deliberately unavailable until their
//! separate gates pass.

#![allow(dead_code)] // The runtime remains intentionally unwired until product-boundary review.

use crate::provider_stream::{NormalizedStreamEvent, OpenAiSseDecoder};
use futures_util::{
    future::{AbortHandle, AbortRegistration, Abortable},
    StreamExt,
};
use reqwest::{header::CONTENT_TYPE, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fmt, time::Duration};
use zeroize::Zeroize;

pub const OPENAI_ADAPTER_STATUS: &str = "request-and-stream-control-conformance";
pub const ANTHROPIC_ADAPTER_STATUS: &str = "request-control-conformance";
pub const GEMINI_ADAPTER_STATUS: &str = "request-control-conformance";
pub const XAI_ADAPTER_STATUS: &str = "request-control-conformance";
pub const DEFAULT_PROVIDER_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_STREAM_BYTES: usize = 32 * 1024 * 1024;
const MAX_PROVIDER_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RemoteProviderId {
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "gemini")]
    Gemini,
    #[serde(rename = "xai")]
    Xai,
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

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }

    pub fn matches(&self, expected: &str) -> bool {
        self.0 == expected
    }
}

impl fmt::Debug for ProviderSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderSecret([REDACTED])")
    }
}

impl Drop for ProviderSecret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// One-use execution controls. The cancellation half can be held by the caller without exposing
/// the request, response, or credential to the webview.
pub struct ProviderExecution {
    timeout: Duration,
    cancellation: AbortRegistration,
}

#[derive(Clone)]
pub struct ProviderCancellation(AbortHandle);

impl ProviderCancellation {
    pub fn cancel(&self) {
        self.0.abort();
    }
}

pub fn provider_execution(
    timeout: Duration,
) -> Result<(ProviderExecution, ProviderCancellation), ProviderError> {
    if timeout.is_zero() || timeout > MAX_PROVIDER_TIMEOUT {
        return Err(ProviderError::InvalidExecution);
    }
    let (handle, registration) = AbortHandle::new_pair();
    Ok((
        ProviderExecution {
            timeout,
            cancellation: registration,
        },
        ProviderCancellation(handle),
    ))
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
    InvalidExecution,
    Timeout,
    Cancelled,
    RemoteStreamFailed,
    Transport,
    HttpStatus(u16),
    ResponseTooLarge,
    MalformedResponse,
}

pub(crate) fn normalized_usage(value: &Value) -> Result<Option<NormalizedUsage>, ProviderError> {
    match value.get("usage") {
        None | Some(Value::Null) => Ok(None),
        Some(usage) => Ok(Some(NormalizedUsage {
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
        })),
    }
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
            Self::InvalidExecution => {
                formatter.write_str("Provider execution controls are invalid")
            }
            Self::Timeout => formatter.write_str("Provider request timed out"),
            Self::Cancelled => formatter.write_str("Provider request was cancelled"),
            Self::RemoteStreamFailed => formatter.write_str("Provider stream failed"),
            Self::Transport => formatter.write_str("Provider transport failed"),
            Self::HttpStatus(status) => write!(formatter, "Provider returned HTTP status {status}"),
            Self::ResponseTooLarge => {
                formatter.write_str("Provider response exceeded the size limit")
            }
            Self::MalformedResponse => formatter.write_str("Provider response was malformed"),
        }
    }
}

fn classify_transport_error(error: &reqwest::Error) -> ProviderError {
    if error.is_timeout() {
        ProviderError::Timeout
    } else {
        ProviderError::Transport
    }
}

fn checked_stream_total(received_bytes: usize, chunk_bytes: usize) -> Result<usize, ProviderError> {
    received_bytes
        .checked_add(chunk_bytes)
        .filter(|total| *total <= MAX_STREAM_BYTES)
        .ok_or(ProviderError::ResponseTooLarge)
}

fn validate_endpoint(endpoint: &Url, expected_path: &str) -> Result<(), ProviderError> {
    let literal_loopback = matches!(endpoint.host_str(), Some("127.0.0.1" | "::1"));
    let allowed_scheme =
        endpoint.scheme() == "https" || (endpoint.scheme() == "http" && literal_loopback);
    if !allowed_scheme
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || endpoint.path() != expected_path
    {
        return Err(ProviderError::UnsafeEndpoint);
    }
    Ok(())
}

fn openai_body(request: &GenerationRequest, stream: bool) -> Value {
    json!({
        "model": request.model,
        "input": request.input.iter().map(|item| json!({
            "role": item.role,
            "content": item.content,
        })).collect::<Vec<_>>(),
        "max_output_tokens": request.max_output_tokens,
        "store": false,
        "stream": stream,
    })
}

fn anthropic_body(request: &GenerationRequest) -> Result<Value, ProviderError> {
    let messages = request
        .input
        .iter()
        .filter(|item| item.role == InputRole::User)
        .map(|item| json!({ "role": "user", "content": item.content }))
        .collect::<Vec<_>>();
    if messages.is_empty() {
        return Err(ProviderError::InvalidRequest);
    }
    let system = request
        .input
        .iter()
        .filter(|item| item.role == InputRole::Developer)
        .map(|item| json!({ "type": "text", "text": item.content }))
        .collect::<Vec<_>>();
    let mut body = json!({
        "model": request.model,
        "messages": messages,
        "max_tokens": request.max_output_tokens,
        "stream": false,
    });
    if !system.is_empty() {
        body["system"] = Value::Array(system);
    }
    Ok(body)
}

fn gemini_body(request: &GenerationRequest) -> Result<Value, ProviderError> {
    let input = request
        .input
        .iter()
        .filter(|item| item.role == InputRole::User)
        .map(|item| item.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    if input.is_empty() {
        return Err(ProviderError::InvalidRequest);
    }
    let system_instruction = request
        .input
        .iter()
        .filter(|item| item.role == InputRole::Developer)
        .map(|item| item.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut body = json!({
        "model": request.model,
        "input": input,
        "generation_config": {
            "max_output_tokens": request.max_output_tokens,
            "thinking_summaries": "none",
        },
        "stream": false,
        "store": false,
        "background": false,
    });
    if !system_instruction.is_empty() {
        body["system_instruction"] = Value::String(system_instruction);
    }
    Ok(body)
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
        let chunk = chunk.map_err(|error| classify_transport_error(&error))?;
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(ProviderError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn normalize_responses_api(
    value: Value,
    provider: RemoteProviderId,
) -> Result<NormalizedResponse, ProviderError> {
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
    let usage = normalized_usage(&value)?;
    Ok(NormalizedResponse {
        provider,
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

fn normalize_openai(value: Value) -> Result<NormalizedResponse, ProviderError> {
    normalize_responses_api(value, RemoteProviderId::OpenAi)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XaiNormalizedResponse {
    pub response: NormalizedResponse,
    pub zero_data_retention: bool,
}

fn normalize_anthropic(value: Value) -> Result<NormalizedResponse, ProviderError> {
    if value.get("type").and_then(Value::as_str) != Some("message")
        || value.get("role").and_then(Value::as_str) != Some("assistant")
    {
        return Err(ProviderError::MalformedResponse);
    }
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or(ProviderError::MalformedResponse)?
        .to_owned();
    let stop_reason = value
        .get("stop_reason")
        .and_then(Value::as_str)
        .filter(|reason| !reason.is_empty())
        .ok_or(ProviderError::MalformedResponse)?
        .to_owned();
    let content = value
        .get("content")
        .and_then(Value::as_array)
        .ok_or(ProviderError::MalformedResponse)?;
    let mut text = String::new();
    let mut unknown_output_types = Vec::new();
    for block in content {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => text.push_str(
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::MalformedResponse)?,
            ),
            Some(other) => unknown_output_types.push(other.to_owned()),
            None => unknown_output_types.push("missing".to_owned()),
        }
    }
    let usage = value.get("usage").ok_or(ProviderError::MalformedResponse)?;
    let input_tokens = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .ok_or(ProviderError::MalformedResponse)?;
    let output_tokens = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .ok_or(ProviderError::MalformedResponse)?;
    let total_tokens = input_tokens
        .checked_add(output_tokens)
        .ok_or(ProviderError::MalformedResponse)?;
    Ok(NormalizedResponse {
        provider: RemoteProviderId::Anthropic,
        id,
        status: stop_reason.clone(),
        model: value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
        text,
        refusals: (stop_reason == "refusal")
            .then(|| "provider-refusal".to_owned())
            .into_iter()
            .collect(),
        unknown_output_types,
        usage: Some(NormalizedUsage {
            input_tokens,
            output_tokens,
            total_tokens,
        }),
    })
}

fn normalize_gemini(value: Value) -> Result<NormalizedResponse, ProviderError> {
    if value.get("object").and_then(Value::as_str) != Some("interaction") {
        return Err(ProviderError::MalformedResponse);
    }
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
    let steps = value
        .get("steps")
        .and_then(Value::as_array)
        .ok_or(ProviderError::MalformedResponse)?;
    let mut text = String::new();
    let mut unknown_output_types = Vec::new();
    for step in steps {
        match step.get("type").and_then(Value::as_str) {
            Some("model_output") => {
                let content = step
                    .get("content")
                    .and_then(Value::as_array)
                    .ok_or(ProviderError::MalformedResponse)?;
                for block in content {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => text.push_str(
                            block
                                .get("text")
                                .and_then(Value::as_str)
                                .ok_or(ProviderError::MalformedResponse)?,
                        ),
                        Some(other) => unknown_output_types.push(format!("model_output:{other}")),
                        None => unknown_output_types.push("model_output:missing".to_owned()),
                    }
                }
            }
            Some(other) => unknown_output_types.push(other.to_owned()),
            None => unknown_output_types.push("missing".to_owned()),
        }
    }
    let usage = match value.get("usage") {
        None | Some(Value::Null) => None,
        Some(usage) => {
            let input_tokens = usage
                .get("total_input_tokens")
                .and_then(Value::as_u64)
                .ok_or(ProviderError::MalformedResponse)?;
            let output_tokens = usage
                .get("total_output_tokens")
                .and_then(Value::as_u64)
                .ok_or(ProviderError::MalformedResponse)?;
            let total_tokens = usage
                .get("total_tokens")
                .and_then(Value::as_u64)
                .ok_or(ProviderError::MalformedResponse)?;
            if total_tokens
                < input_tokens
                    .checked_add(output_tokens)
                    .ok_or(ProviderError::MalformedResponse)?
            {
                return Err(ProviderError::MalformedResponse);
            }
            Some(NormalizedUsage {
                input_tokens,
                output_tokens,
                total_tokens,
            })
        }
    };
    Ok(NormalizedResponse {
        provider: RemoteProviderId::Gemini,
        id,
        status,
        model: value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
        text,
        refusals: Vec::new(),
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
    let (execution, _cancellation) = provider_execution(DEFAULT_PROVIDER_TIMEOUT)?;
    execute_openai_response_controlled(client, endpoint, secret, request, approval, execution).await
}

pub async fn execute_openai_response_controlled(
    client: &Client,
    endpoint: &Url,
    secret: &ProviderSecret,
    request: &GenerationRequest,
    approval: &TransmissionApproval,
    execution: ProviderExecution,
) -> Result<NormalizedResponse, ProviderError> {
    validate_endpoint(endpoint, "/v1/responses")?;
    request.validate()?;
    approval.validate_for(RemoteProviderId::OpenAi)?;
    let operation = async {
        let response = client
            .post(endpoint.clone())
            .timeout(execution.timeout)
            .bearer_auth(secret.expose())
            .header("content-type", "application/json")
            .json(&openai_body(request, false))
            .send()
            .await
            .map_err(|error| classify_transport_error(&error))?;
        if !response.status().is_success() {
            return Err(ProviderError::HttpStatus(response.status().as_u16()));
        }
        let body = bounded_body(response).await?;
        let value = serde_json::from_slice(&body).map_err(|_| ProviderError::MalformedResponse)?;
        normalize_openai(value)
    };
    Abortable::new(operation, execution.cancellation)
        .await
        .map_err(|_| ProviderError::Cancelled)?
}

pub async fn execute_openai_stream_controlled<F>(
    client: &Client,
    endpoint: &Url,
    secret: &ProviderSecret,
    request: &GenerationRequest,
    approval: &TransmissionApproval,
    execution: ProviderExecution,
    mut on_event: F,
) -> Result<(), ProviderError>
where
    F: FnMut(NormalizedStreamEvent) -> Result<(), ProviderError>,
{
    validate_endpoint(endpoint, "/v1/responses")?;
    request.validate()?;
    approval.validate_for(RemoteProviderId::OpenAi)?;
    let operation = async {
        let response = client
            .post(endpoint.clone())
            .timeout(execution.timeout)
            .bearer_auth(secret.expose())
            .header("content-type", "application/json")
            .json(&openai_body(request, true))
            .send()
            .await
            .map_err(|error| classify_transport_error(&error))?;
        if !response.status().is_success() {
            return Err(ProviderError::HttpStatus(response.status().as_u16()));
        }
        let is_event_stream = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"));
        if !is_event_stream {
            return Err(ProviderError::MalformedResponse);
        }

        let mut decoder = OpenAiSseDecoder::new();
        let mut stream = response.bytes_stream();
        let mut received_bytes = 0_usize;
        let mut saw_start = false;
        let mut saw_finish = false;
        let mut saw_end = false;
        let mut saw_provider_error = false;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| classify_transport_error(&error))?;
            received_bytes = checked_stream_total(received_bytes, chunk.len())?;
            for event in decoder.push(&chunk)? {
                match &event {
                    NormalizedStreamEvent::MessageStart { .. } => {
                        if saw_start || saw_finish || saw_end {
                            return Err(ProviderError::MalformedResponse);
                        }
                        saw_start = true;
                    }
                    NormalizedStreamEvent::TextDelta { .. } => {
                        if !saw_start || saw_finish || saw_end {
                            return Err(ProviderError::MalformedResponse);
                        }
                    }
                    NormalizedStreamEvent::Usage { .. } => {
                        if !saw_start || saw_finish || saw_end {
                            return Err(ProviderError::MalformedResponse);
                        }
                    }
                    NormalizedStreamEvent::Finish { .. } => {
                        if !saw_start || saw_finish || saw_end {
                            return Err(ProviderError::MalformedResponse);
                        }
                        saw_finish = true;
                    }
                    NormalizedStreamEvent::StreamEnd => {
                        if !saw_finish || saw_end {
                            return Err(ProviderError::MalformedResponse);
                        }
                        saw_end = true;
                    }
                    NormalizedStreamEvent::ProviderWarning { .. } => {
                        if saw_end {
                            return Err(ProviderError::MalformedResponse);
                        }
                    }
                    NormalizedStreamEvent::ProviderError { .. } => {
                        if saw_end || saw_provider_error {
                            return Err(ProviderError::MalformedResponse);
                        }
                        saw_provider_error = true;
                    }
                }
                on_event(event)?;
            }
        }
        decoder.finish()?;
        if saw_provider_error {
            return Err(ProviderError::RemoteStreamFailed);
        }
        if !saw_start || !saw_finish || !saw_end {
            return Err(ProviderError::MalformedResponse);
        }
        Ok(())
    };
    Abortable::new(operation, execution.cancellation)
        .await
        .map_err(|_| ProviderError::Cancelled)?
}

pub async fn execute_anthropic_response(
    client: &Client,
    endpoint: &Url,
    secret: &ProviderSecret,
    request: &GenerationRequest,
    approval: &TransmissionApproval,
) -> Result<NormalizedResponse, ProviderError> {
    let (execution, _cancellation) = provider_execution(DEFAULT_PROVIDER_TIMEOUT)?;
    execute_anthropic_response_controlled(client, endpoint, secret, request, approval, execution)
        .await
}

pub async fn execute_anthropic_response_controlled(
    client: &Client,
    endpoint: &Url,
    secret: &ProviderSecret,
    request: &GenerationRequest,
    approval: &TransmissionApproval,
    execution: ProviderExecution,
) -> Result<NormalizedResponse, ProviderError> {
    validate_endpoint(endpoint, "/v1/messages")?;
    request.validate()?;
    approval.validate_for(RemoteProviderId::Anthropic)?;
    let body = anthropic_body(request)?;
    let operation = async {
        let response = client
            .post(endpoint.clone())
            .timeout(execution.timeout)
            .header("x-api-key", secret.expose())
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| classify_transport_error(&error))?;
        if !response.status().is_success() {
            return Err(ProviderError::HttpStatus(response.status().as_u16()));
        }
        let body = bounded_body(response).await?;
        let value = serde_json::from_slice(&body).map_err(|_| ProviderError::MalformedResponse)?;
        normalize_anthropic(value)
    };
    Abortable::new(operation, execution.cancellation)
        .await
        .map_err(|_| ProviderError::Cancelled)?
}

pub async fn execute_gemini_response(
    client: &Client,
    endpoint: &Url,
    secret: &ProviderSecret,
    request: &GenerationRequest,
    approval: &TransmissionApproval,
) -> Result<NormalizedResponse, ProviderError> {
    let (execution, _cancellation) = provider_execution(DEFAULT_PROVIDER_TIMEOUT)?;
    execute_gemini_response_controlled(client, endpoint, secret, request, approval, execution).await
}

pub async fn execute_gemini_response_controlled(
    client: &Client,
    endpoint: &Url,
    secret: &ProviderSecret,
    request: &GenerationRequest,
    approval: &TransmissionApproval,
    execution: ProviderExecution,
) -> Result<NormalizedResponse, ProviderError> {
    validate_endpoint(endpoint, "/v1/interactions")?;
    request.validate()?;
    approval.validate_for(RemoteProviderId::Gemini)?;
    let body = gemini_body(request)?;
    let operation = async {
        let response = client
            .post(endpoint.clone())
            .timeout(execution.timeout)
            .header("x-goog-api-key", secret.expose())
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| classify_transport_error(&error))?;
        if !response.status().is_success() {
            return Err(ProviderError::HttpStatus(response.status().as_u16()));
        }
        let body = bounded_body(response).await?;
        let value = serde_json::from_slice(&body).map_err(|_| ProviderError::MalformedResponse)?;
        normalize_gemini(value)
    };
    Abortable::new(operation, execution.cancellation)
        .await
        .map_err(|_| ProviderError::Cancelled)?
}

pub async fn execute_xai_response(
    client: &Client,
    endpoint: &Url,
    secret: &ProviderSecret,
    request: &GenerationRequest,
    approval: &TransmissionApproval,
) -> Result<XaiNormalizedResponse, ProviderError> {
    let (execution, _cancellation) = provider_execution(DEFAULT_PROVIDER_TIMEOUT)?;
    execute_xai_response_controlled(client, endpoint, secret, request, approval, execution).await
}

pub async fn execute_xai_response_controlled(
    client: &Client,
    endpoint: &Url,
    secret: &ProviderSecret,
    request: &GenerationRequest,
    approval: &TransmissionApproval,
    execution: ProviderExecution,
) -> Result<XaiNormalizedResponse, ProviderError> {
    validate_endpoint(endpoint, "/v1/responses")?;
    request.validate()?;
    approval.validate_for(RemoteProviderId::Xai)?;
    let operation = async {
        let response = client
            .post(endpoint.clone())
            .timeout(execution.timeout)
            .bearer_auth(secret.expose())
            .header("content-type", "application/json")
            .json(&openai_body(request, false))
            .send()
            .await
            .map_err(|error| classify_transport_error(&error))?;
        if !response.status().is_success() {
            return Err(ProviderError::HttpStatus(response.status().as_u16()));
        }
        let zero_data_retention = match response
            .headers()
            .get("x-zero-data-retention")
            .and_then(|value| value.to_str().ok())
        {
            Some("true") => true,
            Some("false") => false,
            _ => return Err(ProviderError::MalformedResponse),
        };
        let body = bounded_body(response).await?;
        let value = serde_json::from_slice(&body).map_err(|_| ProviderError::MalformedResponse)?;
        Ok(XaiNormalizedResponse {
            response: normalize_responses_api(value, RemoteProviderId::Xai)?,
            zero_data_retention,
        })
    };
    Abortable::new(operation, execution.cancellation)
        .await
        .map_err(|_| ProviderError::Cancelled)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::thread;

    enum FakeResponsePlan {
        CompleteAfter(Duration),
        StallBody(Duration),
    }

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

    fn anthropic_approval() -> TransmissionApproval {
        TransmissionApproval {
            provider: RemoteProviderId::Anthropic,
            content_categories: vec!["selected research excerpts".to_owned()],
            accepted: true,
        }
    }

    fn gemini_approval() -> TransmissionApproval {
        TransmissionApproval {
            provider: RemoteProviderId::Gemini,
            content_categories: vec!["selected research excerpts".to_owned()],
            accepted: true,
        }
    }

    fn xai_approval() -> TransmissionApproval {
        TransmissionApproval {
            provider: RemoteProviderId::Xai,
            content_categories: vec!["selected research excerpts".to_owned()],
            accepted: true,
        }
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
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
        String::from_utf8(bytes).expect("UTF-8 request fixture")
    }

    fn fake_server(status: &str, body: &str) -> (Url, mpsc::Receiver<String>) {
        fake_server_with_plan(
            "/v1/responses",
            status,
            body,
            FakeResponsePlan::CompleteAfter(Duration::ZERO),
        )
    }

    fn fake_server_delayed(
        status: &str,
        body: &str,
        response_delay: Duration,
    ) -> (Url, mpsc::Receiver<String>) {
        fake_server_with_plan(
            "/v1/responses",
            status,
            body,
            FakeResponsePlan::CompleteAfter(response_delay),
        )
    }

    fn fake_server_with_plan(
        path: &str,
        status: &str,
        body: &str,
        response_plan: FakeResponsePlan,
    ) -> (Url, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback fake provider");
        let address = listener.local_addr().expect("fake provider address");
        let (sender, receiver) = mpsc::channel();
        let status = status.to_owned();
        let body = body.to_owned();
        let path = path.to_owned();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept provider request");
            sender
                .send(read_http_request(&mut stream))
                .expect("send captured request");
            match response_plan {
                FakeResponsePlan::CompleteAfter(response_delay) => {
                    thread::sleep(response_delay);
                    let result = write!(
                        stream,
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    if response_delay.is_zero() {
                        result.expect("write fake response");
                    }
                }
                FakeResponsePlan::StallBody(response_delay) => {
                    let split = body.len() / 2;
                    write!(
                        stream,
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        &body[..split]
                    )
                    .expect("write fake response prefix");
                    stream.flush().expect("flush fake response prefix");
                    thread::sleep(response_delay);
                    let _ = stream.write_all(body[split..].as_bytes());
                }
            }
        });
        (
            Url::parse(&format!("http://{address}{path}")).expect("fake URL"),
            receiver,
        )
    }

    fn fake_stream_server(
        content_type: &str,
        chunks: Vec<(Duration, Vec<u8>)>,
    ) -> (Url, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback stream provider");
        let address = listener.local_addr().expect("stream provider address");
        let (sender, receiver) = mpsc::channel();
        let content_type = content_type.to_owned();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept stream request");
            sender
                .send(read_http_request(&mut stream))
                .expect("send captured stream request");
            let content_length = chunks.iter().map(|(_, chunk)| chunk.len()).sum::<usize>();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
            )
            .expect("write stream response headers");
            stream.flush().expect("flush stream response headers");
            for (delay, chunk) in chunks {
                thread::sleep(delay);
                if stream.write_all(&chunk).is_err() {
                    break;
                }
                if stream.flush().is_err() {
                    break;
                }
            }
        });
        (
            Url::parse(&format!("http://{address}/v1/responses")).expect("stream fake URL"),
            receiver,
        )
    }

    fn fake_xai_server(
        zdr_header: Option<&str>,
        status: &str,
        body: &str,
        response_delay: Duration,
    ) -> (Url, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback xAI provider");
        let address = listener.local_addr().expect("xAI provider address");
        let (sender, receiver) = mpsc::channel();
        let status = status.to_owned();
        let body = body.to_owned();
        let zdr_header = zdr_header.map(str::to_owned);
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept xAI request");
            sender
                .send(read_http_request(&mut stream))
                .expect("send captured xAI request");
            thread::sleep(response_delay);
            let zdr = zdr_header
                .map(|value| format!("X-Zero-Data-Retention: {value}\r\n"))
                .unwrap_or_default();
            let result = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{zdr}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            if response_delay.is_zero() {
                result.expect("write xAI response");
            }
        });
        (
            Url::parse(&format!("http://{address}/v1/responses")).expect("xAI fake URL"),
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
    fn provider_ids_match_the_public_descriptor_contract() {
        assert_eq!(
            serde_json::to_value(RemoteProviderId::OpenAi).unwrap(),
            "openai"
        );
        assert_eq!(
            serde_json::to_value(RemoteProviderId::Anthropic).unwrap(),
            "anthropic"
        );
        assert_eq!(
            serde_json::to_value(RemoteProviderId::Gemini).unwrap(),
            "gemini"
        );
        assert_eq!(serde_json::to_value(RemoteProviderId::Xai).unwrap(), "xai");
        assert_eq!(
            serde_json::from_value::<RemoteProviderId>(json!("openai")).unwrap(),
            RemoteProviderId::OpenAi
        );
        assert!(serde_json::from_value::<RemoteProviderId>(json!("open-ai")).is_err());
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

    #[test]
    fn invalid_timeout_fails_before_transport() {
        assert!(matches!(
            provider_execution(Duration::ZERO),
            Err(ProviderError::InvalidExecution)
        ));
        assert!(matches!(
            provider_execution(MAX_PROVIDER_TIMEOUT + Duration::from_millis(1)),
            Err(ProviderError::InvalidExecution)
        ));
    }

    #[test]
    fn fake_server_proves_request_timeout_is_distinct_and_sanitized() {
        let (endpoint, _captured) = fake_server_delayed(
            "200 OK",
            r#"{"id":"too_late","status":"completed","output":[]}"#,
            Duration::from_millis(250),
        );
        let (execution, _cancellation) =
            provider_execution(Duration::from_millis(40)).expect("execution controls");
        let result = tauri::async_runtime::block_on(execute_openai_response_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("timeout-secret-canary".to_owned()).expect("secret"),
            &request(),
            &approval(),
            execution,
        ));
        assert_eq!(result, Err(ProviderError::Timeout));
        assert!(!result
            .unwrap_err()
            .to_string()
            .contains("timeout-secret-canary"));
    }

    #[test]
    fn fake_server_proves_timeout_covers_a_stalled_response_body() {
        let (endpoint, _captured) = fake_server_with_plan(
            "/v1/responses",
            "200 OK",
            r#"{"id":"body_too_late","status":"completed","output":[]}"#,
            FakeResponsePlan::StallBody(Duration::from_millis(250)),
        );
        let (execution, _cancellation) =
            provider_execution(Duration::from_millis(40)).expect("execution controls");
        let result = tauri::async_runtime::block_on(execute_openai_response_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("body-timeout-secret-canary".to_owned()).expect("secret"),
            &request(),
            &approval(),
            execution,
        ));
        assert_eq!(result, Err(ProviderError::Timeout));
        assert!(!result
            .unwrap_err()
            .to_string()
            .contains("body-timeout-secret-canary"));
    }

    #[test]
    fn fake_server_proves_in_flight_cancellation_is_distinct_and_idempotent() {
        let (endpoint, captured) = fake_server_delayed(
            "200 OK",
            r#"{"id":"cancelled","status":"completed","output":[]}"#,
            Duration::from_millis(250),
        );
        let (execution, cancellation) =
            provider_execution(Duration::from_secs(2)).expect("execution controls");
        let cancel_from_task = cancellation.clone();
        thread::spawn(move || {
            captured.recv().expect("request reached fake server");
            cancel_from_task.cancel();
            cancel_from_task.cancel();
        });
        let result = tauri::async_runtime::block_on(execute_openai_response_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("cancel-secret-canary".to_owned()).expect("secret"),
            &request(),
            &approval(),
            execution,
        ));
        assert_eq!(result, Err(ProviderError::Cancelled));
        assert!(!result
            .unwrap_err()
            .to_string()
            .contains("cancel-secret-canary"));
    }

    #[test]
    fn fake_network_stream_dispatches_normalized_events_and_storage_off_request() {
        let fixture = concat!(
            "event: response.created\n",
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stream\"}}\n\n",
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Evidence: 雪\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",",
            "\"usage\":{\"input_tokens\":9,\"output_tokens\":3,\"total_tokens\":12}}}\n\n",
            "data: [DONE]\n\n"
        )
        .as_bytes()
        .to_vec();
        let snow = "雪".as_bytes();
        let split = fixture
            .windows(snow.len())
            .position(|window| window == snow)
            .expect("Unicode fixture")
            + 1;
        let chunks = vec![
            (Duration::ZERO, fixture[..split].to_vec()),
            (Duration::from_millis(5), fixture[split..].to_vec()),
        ];
        let (endpoint, captured) = fake_stream_server("text/event-stream; charset=utf-8", chunks);
        let (execution, _cancellation) =
            provider_execution(Duration::from_secs(2)).expect("execution controls");
        let mut events = Vec::new();
        tauri::async_runtime::block_on(execute_openai_stream_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("stream-wire-canary".to_owned()).expect("secret"),
            &request(),
            &approval(),
            execution,
            |event| {
                events.push(event);
                Ok(())
            },
        ))
        .expect("normalized network stream");
        assert_eq!(
            events,
            vec![
                NormalizedStreamEvent::MessageStart {
                    provider: RemoteProviderId::OpenAi,
                    response_id: "resp_stream".to_owned(),
                },
                NormalizedStreamEvent::TextDelta {
                    text: "Evidence: 雪".to_owned(),
                },
                NormalizedStreamEvent::Usage {
                    usage: NormalizedUsage {
                        input_tokens: 9,
                        output_tokens: 3,
                        total_tokens: 12,
                    },
                },
                NormalizedStreamEvent::Finish {
                    status: "completed".to_owned(),
                },
                NormalizedStreamEvent::StreamEnd,
            ]
        );
        let raw = captured.recv().expect("captured stream request");
        let (_, body) = raw.split_once("\r\n\r\n").expect("stream HTTP request");
        let body: Value = serde_json::from_str(body).expect("stream request JSON");
        assert_eq!(body["stream"], true);
        assert_eq!(body["store"], false);
    }

    #[test]
    fn fake_network_stream_rejects_wrong_media_type_and_missing_terminal_events() {
        let complete =
            b"data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp\"}}\n\n".to_vec();
        let (endpoint, _captured) =
            fake_stream_server("application/json", vec![(Duration::ZERO, complete.clone())]);
        let (execution, _cancellation) =
            provider_execution(Duration::from_secs(2)).expect("execution controls");
        let wrong_type = tauri::async_runtime::block_on(execute_openai_stream_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
            &request(),
            &approval(),
            execution,
            |_| Ok(()),
        ));
        assert_eq!(wrong_type, Err(ProviderError::MalformedResponse));

        let (endpoint, _captured) =
            fake_stream_server("text/event-stream", vec![(Duration::ZERO, complete)]);
        let (execution, _cancellation) =
            provider_execution(Duration::from_secs(2)).expect("execution controls");
        let truncated = tauri::async_runtime::block_on(execute_openai_stream_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
            &request(),
            &approval(),
            execution,
            |_| Ok(()),
        ));
        assert_eq!(truncated, Err(ProviderError::MalformedResponse));

        let wrong_order = concat!(
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp\"}}\n\n",
            "data: [DONE]\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
        )
        .as_bytes()
        .to_vec();
        let (endpoint, _captured) =
            fake_stream_server("text/event-stream", vec![(Duration::ZERO, wrong_order)]);
        let (execution, _cancellation) =
            provider_execution(Duration::from_secs(2)).expect("execution controls");
        let out_of_order = tauri::async_runtime::block_on(execute_openai_stream_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
            &request(),
            &approval(),
            execution,
            |_| Ok(()),
        ));
        assert_eq!(out_of_order, Err(ProviderError::MalformedResponse));
    }

    #[test]
    fn stream_byte_accounting_rejects_limit_and_integer_overflow() {
        assert_eq!(
            checked_stream_total(MAX_STREAM_BYTES - 1, 1),
            Ok(MAX_STREAM_BYTES)
        );
        assert_eq!(
            checked_stream_total(MAX_STREAM_BYTES - 1, 2),
            Err(ProviderError::ResponseTooLarge)
        );
        assert_eq!(
            checked_stream_total(usize::MAX, 1),
            Err(ProviderError::ResponseTooLarge)
        );
    }

    #[test]
    fn fake_network_stream_can_cancel_between_dispatched_events() {
        let first = concat!(
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_cancel\"}}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"first\"}\n\n"
        )
        .as_bytes()
        .to_vec();
        let terminal = concat!(
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
            "data: [DONE]\n\n"
        )
        .as_bytes()
        .to_vec();
        let (endpoint, _captured) = fake_stream_server(
            "text/event-stream",
            vec![
                (Duration::ZERO, first),
                (Duration::from_millis(250), terminal),
            ],
        );
        let (execution, cancellation) =
            provider_execution(Duration::from_secs(2)).expect("execution controls");
        let cancellation_from_consumer = cancellation.clone();
        let mut events = Vec::new();
        let result = tauri::async_runtime::block_on(execute_openai_stream_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("stream-cancel-canary".to_owned()).expect("secret"),
            &request(),
            &approval(),
            execution,
            |event| {
                let should_cancel = matches!(event, NormalizedStreamEvent::TextDelta { .. });
                events.push(event);
                if should_cancel {
                    cancellation_from_consumer.cancel();
                }
                Ok(())
            },
        ));
        assert_eq!(result, Err(ProviderError::Cancelled));
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events.last(),
            Some(NormalizedStreamEvent::TextDelta { text }) if text == "first"
        ));
    }

    #[test]
    fn fake_network_stream_surfaces_sanitized_provider_error_and_fails_distinctly() {
        let canary = "network-provider-error-body-canary";
        let fixture = format!(
            "data: {{\"type\":\"error\",\"code\":\"rate_limit\",\"message\":\"{canary}\"}}\n\n"
        )
        .into_bytes();
        let (endpoint, _captured) =
            fake_stream_server("text/event-stream", vec![(Duration::ZERO, fixture)]);
        let (execution, _cancellation) =
            provider_execution(Duration::from_secs(2)).expect("execution controls");
        let mut events = Vec::new();
        let result = tauri::async_runtime::block_on(execute_openai_stream_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
            &request(),
            &approval(),
            execution,
            |event| {
                events.push(event);
                Ok(())
            },
        ));
        assert_eq!(result, Err(ProviderError::RemoteStreamFailed));
        assert_eq!(
            events,
            vec![NormalizedStreamEvent::ProviderError {
                code: Some("rate_limit".to_owned())
            }]
        );
        assert!(!format!("{events:?} {result:?}").contains(canary));
    }

    #[test]
    fn anthropic_fake_server_proves_headers_system_shape_and_normalization() {
        let (endpoint, captured) = fake_server_with_plan(
            "/v1/messages",
            "200 OK",
            r#"{"id":"msg_test","type":"message","role":"assistant","model":"claude-test","content":[{"type":"text","text":"Supported finding."},{"type":"thinking","thinking":"not retained"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":3}}"#,
            FakeResponsePlan::CompleteAfter(Duration::ZERO),
        );
        let anthropic_request = GenerationRequest {
            model: "claude-test".to_owned(),
            input: vec![
                ProviderInput {
                    role: InputRole::Developer,
                    content: "Use only the supplied evidence.".to_owned(),
                },
                ProviderInput {
                    role: InputRole::User,
                    content: "Compare the cited claims.".to_owned(),
                },
            ],
            max_output_tokens: 700,
        };
        let secret_canary = "sk-ant-wire-canary";
        let response = tauri::async_runtime::block_on(execute_anthropic_response(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new(secret_canary.to_owned()).expect("secret"),
            &anthropic_request,
            &anthropic_approval(),
        ))
        .expect("normalized Anthropic response");
        assert_eq!(response.provider, RemoteProviderId::Anthropic);
        assert_eq!(response.text, "Supported finding.");
        assert_eq!(response.status, "end_turn");
        assert_eq!(response.unknown_output_types, vec!["thinking"]);
        assert_eq!(response.usage.expect("usage").total_tokens, 13);

        let raw = captured.recv().expect("captured Anthropic request");
        let (headers, body) = raw.split_once("\r\n\r\n").expect("HTTP request");
        let headers = headers.to_ascii_lowercase();
        assert!(headers.starts_with("post /v1/messages http/1.1"));
        assert!(headers.contains(&format!("x-api-key: {secret_canary}")));
        assert!(headers.contains("anthropic-version: 2023-06-01"));
        assert!(!headers.contains("authorization:"));
        let body: Value = serde_json::from_str(body).expect("Anthropic request JSON");
        assert_eq!(body["model"], "claude-test");
        assert_eq!(body["system"][0]["type"], "text");
        assert_eq!(body["system"][0]["text"], "Use only the supplied evidence.");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["max_tokens"], 700);
        assert_eq!(body["stream"], false);
        assert!(body.get("store").is_none());
    }

    #[test]
    fn anthropic_fails_disclosure_and_missing_user_input_before_transport() {
        let endpoint = Url::parse("https://api.anthropic.com/v1/messages").expect("URL");
        let secret = ProviderSecret::new("fixture-key".to_owned()).expect("secret");
        let wrong_disclosure = tauri::async_runtime::block_on(execute_anthropic_response(
            &Client::new(),
            &endpoint,
            &secret,
            &request(),
            &approval(),
        ));
        assert_eq!(wrong_disclosure, Err(ProviderError::DisclosureRequired));

        let developer_only = GenerationRequest {
            model: "claude-test".to_owned(),
            input: vec![ProviderInput {
                role: InputRole::Developer,
                content: "No user turn.".to_owned(),
            }],
            max_output_tokens: 10,
        };
        let missing_user = tauri::async_runtime::block_on(execute_anthropic_response(
            &Client::new(),
            &endpoint,
            &secret,
            &developer_only,
            &anthropic_approval(),
        ));
        assert_eq!(missing_user, Err(ProviderError::InvalidRequest));
    }

    #[test]
    fn anthropic_errors_and_usage_overflow_fail_closed_without_body_leakage() {
        let response_canary = "anthropic-error-body-canary";
        let (endpoint, _captured) = fake_server_with_plan(
            "/v1/messages",
            "429 Too Many Requests",
            &format!(r#"{{"type":"error","error":{{"message":"{response_canary}"}}}}"#),
            FakeResponsePlan::CompleteAfter(Duration::ZERO),
        );
        let error = tauri::async_runtime::block_on(execute_anthropic_response(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("anthropic-secret-canary".to_owned()).expect("secret"),
            &request(),
            &anthropic_approval(),
        ))
        .expect_err("429 must fail");
        assert_eq!(error, ProviderError::HttpStatus(429));
        assert!(!error.to_string().contains(response_canary));

        let overflow = json!({
            "id": "msg_overflow",
            "type": "message",
            "role": "assistant",
            "model": "claude-test",
            "content": [],
            "stop_reason": "end_turn",
            "usage": { "input_tokens": u64::MAX, "output_tokens": 1 }
        });
        assert_eq!(
            normalize_anthropic(overflow),
            Err(ProviderError::MalformedResponse)
        );
    }

    #[test]
    fn anthropic_controlled_request_times_out_and_cancels_distinctly() {
        let response = r#"{"id":"msg_late","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#;
        let (endpoint, _captured) = fake_server_with_plan(
            "/v1/messages",
            "200 OK",
            response,
            FakeResponsePlan::CompleteAfter(Duration::from_millis(250)),
        );
        let (execution, _cancellation) =
            provider_execution(Duration::from_millis(40)).expect("execution controls");
        let timeout = tauri::async_runtime::block_on(execute_anthropic_response_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
            &request(),
            &anthropic_approval(),
            execution,
        ));
        assert_eq!(timeout, Err(ProviderError::Timeout));

        let (endpoint, captured) = fake_server_with_plan(
            "/v1/messages",
            "200 OK",
            response,
            FakeResponsePlan::CompleteAfter(Duration::from_millis(250)),
        );
        let (execution, cancellation) =
            provider_execution(Duration::from_secs(2)).expect("execution controls");
        let cancel_from_task = cancellation.clone();
        thread::spawn(move || {
            captured.recv().expect("request reached fake server");
            cancel_from_task.cancel();
        });
        let cancelled = tauri::async_runtime::block_on(execute_anthropic_response_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
            &request(),
            &anthropic_approval(),
            execution,
        ));
        assert_eq!(cancelled, Err(ProviderError::Cancelled));
    }

    #[test]
    fn gemini_fake_server_proves_stable_storage_off_shape_and_normalization() {
        let (endpoint, captured) = fake_server_with_plan(
            "/v1/interactions",
            "200 OK",
            r#"{"id":"int_test","object":"interaction","model":"gemini-test","status":"completed","steps":[{"type":"thought","content":"not retained"},{"type":"model_output","content":[{"type":"text","text":"Supported finding."},{"type":"image","data":"not retained"}]}],"usage":{"total_input_tokens":10,"total_output_tokens":3,"total_thought_tokens":2,"total_tokens":15}}"#,
            FakeResponsePlan::CompleteAfter(Duration::ZERO),
        );
        let gemini_request = GenerationRequest {
            model: "gemini-test".to_owned(),
            input: vec![
                ProviderInput {
                    role: InputRole::Developer,
                    content: "Use only the supplied evidence.".to_owned(),
                },
                ProviderInput {
                    role: InputRole::User,
                    content: "Compare the cited claims.".to_owned(),
                },
            ],
            max_output_tokens: 700,
        };
        let secret_canary = "gemini-wire-canary";
        let response = tauri::async_runtime::block_on(execute_gemini_response(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new(secret_canary.to_owned()).expect("secret"),
            &gemini_request,
            &gemini_approval(),
        ))
        .expect("normalized Gemini response");
        assert_eq!(response.provider, RemoteProviderId::Gemini);
        assert_eq!(response.text, "Supported finding.");
        assert_eq!(response.status, "completed");
        assert_eq!(
            response.unknown_output_types,
            vec!["thought", "model_output:image"]
        );
        assert_eq!(response.usage.expect("usage").total_tokens, 15);

        let raw = captured.recv().expect("captured Gemini request");
        let (headers, body) = raw.split_once("\r\n\r\n").expect("HTTP request");
        let headers = headers.to_ascii_lowercase();
        assert!(headers.starts_with("post /v1/interactions http/1.1"));
        assert!(headers.contains(&format!("x-goog-api-key: {secret_canary}")));
        assert!(!headers.contains("authorization:"));
        let body: Value = serde_json::from_str(body).expect("Gemini request JSON");
        assert_eq!(body["model"], "gemini-test");
        assert_eq!(body["input"], "Compare the cited claims.");
        assert_eq!(
            body["system_instruction"],
            "Use only the supplied evidence."
        );
        assert_eq!(body["generation_config"]["max_output_tokens"], 700);
        assert_eq!(body["generation_config"]["thinking_summaries"], "none");
        assert_eq!(body["stream"], false);
        assert_eq!(body["store"], false);
        assert_eq!(body["background"], false);
    }

    #[test]
    fn gemini_fails_beta_path_disclosure_and_missing_user_input_before_transport() {
        let client = Client::new();
        let secret = ProviderSecret::new("fixture-key".to_owned()).expect("secret");
        let beta = Url::parse("https://generativelanguage.googleapis.com/v1beta/interactions")
            .expect("URL");
        let wrong_version = tauri::async_runtime::block_on(execute_gemini_response(
            &client,
            &beta,
            &secret,
            &request(),
            &gemini_approval(),
        ));
        assert_eq!(wrong_version, Err(ProviderError::UnsafeEndpoint));

        let endpoint =
            Url::parse("https://generativelanguage.googleapis.com/v1/interactions").expect("URL");
        let wrong_disclosure = tauri::async_runtime::block_on(execute_gemini_response(
            &client,
            &endpoint,
            &secret,
            &request(),
            &approval(),
        ));
        assert_eq!(wrong_disclosure, Err(ProviderError::DisclosureRequired));

        let developer_only = GenerationRequest {
            model: "gemini-test".to_owned(),
            input: vec![ProviderInput {
                role: InputRole::Developer,
                content: "No user turn.".to_owned(),
            }],
            max_output_tokens: 10,
        };
        let missing_user = tauri::async_runtime::block_on(execute_gemini_response(
            &client,
            &endpoint,
            &secret,
            &developer_only,
            &gemini_approval(),
        ));
        assert_eq!(missing_user, Err(ProviderError::InvalidRequest));
    }

    #[test]
    fn gemini_errors_and_inconsistent_usage_fail_closed_without_body_leakage() {
        let response_canary = "gemini-error-body-canary";
        let (endpoint, _captured) = fake_server_with_plan(
            "/v1/interactions",
            "403 Forbidden",
            &format!(r#"{{"error":{{"message":"{response_canary}"}}}}"#),
            FakeResponsePlan::CompleteAfter(Duration::ZERO),
        );
        let error = tauri::async_runtime::block_on(execute_gemini_response(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("gemini-secret-canary".to_owned()).expect("secret"),
            &request(),
            &gemini_approval(),
        ))
        .expect_err("403 must fail");
        assert_eq!(error, ProviderError::HttpStatus(403));
        assert!(!error.to_string().contains(response_canary));

        let inconsistent = json!({
            "id": "int_bad_usage",
            "object": "interaction",
            "model": "gemini-test",
            "status": "completed",
            "steps": [],
            "usage": {
                "total_input_tokens": 10,
                "total_output_tokens": 3,
                "total_tokens": 12
            }
        });
        assert_eq!(
            normalize_gemini(inconsistent),
            Err(ProviderError::MalformedResponse)
        );
    }

    #[test]
    fn gemini_controlled_request_times_out_and_cancels_distinctly() {
        let response = r#"{"id":"int_late","object":"interaction","model":"gemini-test","status":"completed","steps":[]}"#;
        let (endpoint, _captured) = fake_server_with_plan(
            "/v1/interactions",
            "200 OK",
            response,
            FakeResponsePlan::CompleteAfter(Duration::from_millis(250)),
        );
        let (execution, _cancellation) =
            provider_execution(Duration::from_millis(40)).expect("execution controls");
        let timeout = tauri::async_runtime::block_on(execute_gemini_response_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
            &request(),
            &gemini_approval(),
            execution,
        ));
        assert_eq!(timeout, Err(ProviderError::Timeout));

        let (endpoint, captured) = fake_server_with_plan(
            "/v1/interactions",
            "200 OK",
            response,
            FakeResponsePlan::CompleteAfter(Duration::from_millis(250)),
        );
        let (execution, cancellation) =
            provider_execution(Duration::from_secs(2)).expect("execution controls");
        let cancel_from_task = cancellation.clone();
        thread::spawn(move || {
            captured.recv().expect("request reached fake server");
            cancel_from_task.cancel();
        });
        let cancelled = tauri::async_runtime::block_on(execute_gemini_response_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
            &request(),
            &gemini_approval(),
            execution,
        ));
        assert_eq!(cancelled, Err(ProviderError::Cancelled));
    }

    #[test]
    fn xai_fake_server_proves_storage_off_wire_shape_and_retention_attestation() {
        let response_body = r#"{"id":"resp_xai","status":"completed","model":"grok-test","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Supported finding."}]}],"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}"#;
        let (endpoint, captured) =
            fake_xai_server(Some("false"), "200 OK", response_body, Duration::ZERO);
        let secret_canary = "xai-wire-canary";
        let result = tauri::async_runtime::block_on(execute_xai_response(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new(secret_canary.to_owned()).expect("secret"),
            &request(),
            &xai_approval(),
        ))
        .expect("normalized xAI response");
        assert_eq!(result.response.provider, RemoteProviderId::Xai);
        assert_eq!(result.response.text, "Supported finding.");
        assert!(!result.zero_data_retention);

        let raw = captured.recv().expect("captured xAI request");
        let (headers, body) = raw.split_once("\r\n\r\n").expect("HTTP request");
        let headers = headers.to_ascii_lowercase();
        assert!(headers.starts_with("post /v1/responses http/1.1"));
        assert!(headers.contains(&format!("authorization: bearer {secret_canary}")));
        let body: Value = serde_json::from_str(body).expect("xAI request JSON");
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], false);
        assert!(body.get("previous_response_id").is_none());
        assert!(body.get("prompt_cache_key").is_none());
    }

    #[test]
    fn xai_requires_boolean_retention_header_and_surfaces_zdr_true() {
        let response_body = r#"{"id":"resp_xai","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}"#;
        let (endpoint, _captured) =
            fake_xai_server(Some("true"), "200 OK", response_body, Duration::ZERO);
        let result = tauri::async_runtime::block_on(execute_xai_response(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
            &request(),
            &xai_approval(),
        ))
        .expect("ZDR-attested response");
        assert!(result.zero_data_retention);

        for header in [None, Some("unknown")] {
            let (endpoint, _captured) =
                fake_xai_server(header, "200 OK", response_body, Duration::ZERO);
            let result = tauri::async_runtime::block_on(execute_xai_response(
                &Client::new(),
                &endpoint,
                &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
                &request(),
                &xai_approval(),
            ));
            assert_eq!(result, Err(ProviderError::MalformedResponse));
        }
    }

    #[test]
    fn xai_disclosure_and_error_body_fail_closed() {
        let endpoint = Url::parse("https://api.x.ai/v1/responses").expect("URL");
        let disclosure = tauri::async_runtime::block_on(execute_xai_response(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
            &request(),
            &approval(),
        ));
        assert_eq!(disclosure, Err(ProviderError::DisclosureRequired));

        let response_canary = "xai-error-body-canary";
        let (endpoint, _captured) = fake_xai_server(
            Some("false"),
            "401 Unauthorized",
            &format!(r#"{{"error":{{"message":"{response_canary}"}}}}"#),
            Duration::ZERO,
        );
        let error = tauri::async_runtime::block_on(execute_xai_response(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("xai-secret-canary".to_owned()).expect("secret"),
            &request(),
            &xai_approval(),
        ))
        .expect_err("401 must fail");
        assert_eq!(error, ProviderError::HttpStatus(401));
        assert!(!error.to_string().contains(response_canary));
    }

    #[test]
    fn xai_controlled_request_times_out_and_cancels_distinctly() {
        let response = r#"{"id":"resp_late","status":"completed","output":[]}"#;
        let (endpoint, _captured) = fake_xai_server(
            Some("false"),
            "200 OK",
            response,
            Duration::from_millis(250),
        );
        let (execution, _cancellation) =
            provider_execution(Duration::from_millis(40)).expect("execution controls");
        let timeout = tauri::async_runtime::block_on(execute_xai_response_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
            &request(),
            &xai_approval(),
            execution,
        ));
        assert_eq!(timeout, Err(ProviderError::Timeout));

        let (endpoint, captured) = fake_xai_server(
            Some("false"),
            "200 OK",
            response,
            Duration::from_millis(250),
        );
        let (execution, cancellation) =
            provider_execution(Duration::from_secs(2)).expect("execution controls");
        let cancel_from_task = cancellation.clone();
        thread::spawn(move || {
            captured.recv().expect("request reached fake server");
            cancel_from_task.cancel();
        });
        let cancelled = tauri::async_runtime::block_on(execute_xai_response_controlled(
            &Client::new(),
            &endpoint,
            &ProviderSecret::new("fixture-key".to_owned()).expect("secret"),
            &request(),
            &xai_approval(),
            execution,
        ));
        assert_eq!(cancelled, Err(ProviderError::Cancelled));
    }
}

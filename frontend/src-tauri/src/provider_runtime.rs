//! Product boundary for opt-in remote model tasks.
//!
//! This is intentionally narrower than the transport module: built-in endpoints only, one default
//! OS-vault credential per provider, explicit disclosure approval, one-shot execution, caller
//! cancellation, sanitized output, and a content-free provenance record authored in Rust.

use crate::credential_vault::{CredentialId, CredentialVault, OsCredentialVault};
use crate::model_provider::{
    execute_anthropic_response_controlled, execute_gemini_response_controlled,
    execute_openai_response_controlled, execute_xai_response_controlled, provider_execution,
    GenerationRequest, InputRole, NormalizedResponse, ProviderCancellation, ProviderError,
    ProviderInput, RemoteProviderId, TransmissionApproval, ANTHROPIC_ADAPTER_STATUS,
    GEMINI_ADAPTER_STATUS, OPENAI_ADAPTER_STATUS, XAI_ADAPTER_STATUS,
};
use chrono::{SecondsFormat, Utc};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const DEFAULT_PROFILE: &str = "default";

#[derive(Default)]
pub struct ProviderRuntimeState(Mutex<HashMap<String, ProviderCancellation>>);

#[derive(Clone, Debug)]
pub struct ProviderTaskRequest {
    pub run_id: String,
    pub call_id: String,
    pub task_type: String,
    pub provider: RemoteProviderId,
    pub source_snapshot_ids: Vec<String>,
    pub timeout_ms: u64,
    pub content_categories: Vec<String>,
    pub generation: GenerationRequest,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResearchSource {
    pub snapshot_id: String,
    pub label: String,
    pub excerpt: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResearchTaskRequest {
    pub run_id: String,
    pub call_id: String,
    pub task_type: String,
    pub provider: RemoteProviderId,
    pub timeout_ms: u64,
    pub model: String,
    pub developer_instructions: Option<String>,
    pub question: String,
    pub sources: Vec<ProviderResearchSource>,
    pub max_output_tokens: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTaskOutcome {
    pub response: Option<NormalizedResponse>,
    pub zero_data_retention: Option<bool>,
    pub error_code: Option<String>,
    pub run_record: Value,
}

struct ProviderProfile {
    endpoint: &'static str,
    transport: &'static str,
    adapter_status: &'static str,
    policy_url: &'static str,
    policy_checked_at: &'static str,
    storage_request: &'static str,
    zero_retention: &'static str,
}

fn profile(provider: RemoteProviderId) -> ProviderProfile {
    match provider {
        RemoteProviderId::OpenAi => ProviderProfile {
            endpoint: "https://api.openai.com/v1/responses",
            transport: "openai-responses",
            adapter_status: OPENAI_ADAPTER_STATUS,
            policy_url:
                "https://platform.openai.com/docs/models/default-usage-policies-by-endpoint",
            policy_checked_at: "2026-07-15T00:00:00.000Z",
            storage_request: "disabled",
            zero_retention: "requested",
        },
        RemoteProviderId::Anthropic => ProviderProfile {
            endpoint: "https://api.anthropic.com/v1/messages",
            transport: "anthropic-messages",
            adapter_status: ANTHROPIC_ADAPTER_STATUS,
            policy_url: "https://platform.claude.com/docs/en/manage-claude/api-and-data-retention",
            policy_checked_at: "2026-07-15T00:00:00.000Z",
            storage_request: "provider-controlled",
            zero_retention: "unknown",
        },
        RemoteProviderId::Gemini => ProviderProfile {
            endpoint: "https://generativelanguage.googleapis.com/v1/interactions",
            transport: "gemini-interactions",
            adapter_status: GEMINI_ADAPTER_STATUS,
            policy_url: "https://ai.google.dev/gemini-api/terms",
            policy_checked_at: "2026-07-15T00:00:00.000Z",
            storage_request: "disabled",
            zero_retention: "unknown",
        },
        RemoteProviderId::Xai => ProviderProfile {
            endpoint: "https://api.x.ai/v1/responses",
            transport: "xai-responses",
            adapter_status: XAI_ADAPTER_STATUS,
            policy_url: "https://docs.x.ai/developers/faq/security",
            policy_checked_at: "2026-07-15T00:00:00.000Z",
            storage_request: "disabled",
            zero_retention: "requested",
        },
    }
}

fn valid_id(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 200 && !value.chars().any(char::is_control)
}

fn valid_task_type(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z'))
        && value.len() <= 128
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
}

fn validate_task(request: &ProviderTaskRequest) -> Result<(), String> {
    let unique_sources: HashSet<_> = request.source_snapshot_ids.iter().collect();
    if !valid_id(&request.run_id)
        || !valid_id(&request.call_id)
        || !valid_task_type(&request.task_type)
        || request.source_snapshot_ids.len() > 10_000
        || unique_sources.len() != request.source_snapshot_ids.len()
        || request.source_snapshot_ids.iter().any(|id| !valid_id(id))
        || request.generation.model.trim().is_empty()
        || request.generation.model.chars().count() > 200
        || request.generation.model.chars().any(char::is_control)
        || request.generation.input.is_empty()
        || request.generation.input.len() > 200
        || request
            .generation
            .input
            .iter()
            .any(|item| item.content.is_empty() || item.content.len() > 4 * 1024 * 1024)
        || !(1..=1_000_000).contains(&request.generation.max_output_tokens)
        || request.content_categories.is_empty()
        || request.content_categories.len() > 20
        || request.content_categories.iter().any(|category| {
            category.trim().is_empty()
                || category.chars().count() > 100
                || category.chars().any(char::is_control)
        })
    {
        return Err(
            "Provider task identity, model, disclosure, or source provenance is invalid".to_owned(),
        );
    }
    Ok(())
}

fn build_research_task(
    request: ProviderResearchTaskRequest,
) -> Result<ProviderTaskRequest, String> {
    if !valid_id(&request.run_id)
        || !valid_id(&request.call_id)
        || !valid_task_type(&request.task_type)
        || request.question.trim().is_empty()
        || request.question.len() > 4 * 1024 * 1024
        || request.sources.len() > 200
        || request
            .developer_instructions
            .as_ref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > 4 * 1024 * 1024)
        || request.sources.iter().any(|source| {
            !valid_id(&source.snapshot_id)
                || source.label.trim().is_empty()
                || source.label.chars().count() > 500
                || source.label.chars().any(char::is_control)
                || source.excerpt.trim().is_empty()
                || source.excerpt.len() > 4 * 1024 * 1024
        })
    {
        return Err("Remote research task content or identity is invalid".to_owned());
    }
    let source_snapshot_ids: Vec<_> = request
        .sources
        .iter()
        .map(|source| source.snapshot_id.clone())
        .collect();
    if source_snapshot_ids.iter().collect::<HashSet<_>>().len() != source_snapshot_ids.len() {
        return Err("Remote research task source snapshots must be unique".to_owned());
    }
    let user_content = serde_json::to_string(&json!({
        "question": request.question,
        "sources": request.sources.iter().map(|source| json!({
            "snapshotId": source.snapshot_id,
            "label": source.label,
            "excerpt": source.excerpt
        })).collect::<Vec<_>>()
    }))
    .map_err(|_| "Remote research task could not be serialized".to_owned())?;
    if user_content.len() > 4 * 1024 * 1024 {
        return Err("Remote research task exceeds the bounded input size".to_owned());
    }
    let mut input = Vec::with_capacity(2);
    let mut content_categories = Vec::with_capacity(3);
    if let Some(instructions) = request.developer_instructions {
        input.push(ProviderInput {
            role: InputRole::Developer,
            content: instructions,
        });
        content_categories.push("task instructions".to_owned());
    }
    input.push(ProviderInput {
        role: InputRole::User,
        content: user_content,
    });
    content_categories.push("research question".to_owned());
    if !source_snapshot_ids.is_empty() {
        content_categories.push("selected source excerpts and labels".to_owned());
    }
    let task = ProviderTaskRequest {
        run_id: request.run_id,
        call_id: request.call_id,
        task_type: request.task_type,
        provider: request.provider,
        source_snapshot_ids,
        timeout_ms: request.timeout_ms,
        content_categories,
        generation: GenerationRequest {
            model: request.model,
            input,
            max_output_tokens: request.max_output_tokens,
        },
    };
    validate_task(&task)?;
    Ok(task)
}

fn provider_name(provider: RemoteProviderId) -> &'static str {
    match provider {
        RemoteProviderId::OpenAi => "OpenAI",
        RemoteProviderId::Anthropic => "Anthropic",
        RemoteProviderId::Gemini => "Google Gemini",
        RemoteProviderId::Xai => "xAI",
    }
}

fn disclosure_message(request: &ProviderTaskRequest, endpoint: &Url) -> String {
    let provider_profile = profile(request.provider);
    format!(
        "Send this research request to a remote model?\n\nProvider: {}\nModel: {}\nDestination: {}\nContent categories: {}\nRequests: 1\nStorage request: {}\nZero-retention status: {}\nPolicy reviewed: {}\nPolicy: {}\n\nThe selected research content leaves this device only if you choose Send once.",
        provider_name(request.provider),
        request.generation.model,
        endpoint,
        request.content_categories.join(", "),
        provider_profile.storage_request,
        provider_profile.zero_retention,
        provider_profile.policy_checked_at,
        provider_profile.policy_url,
    )
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn error_code(error: &ProviderError) -> &'static str {
    match error {
        ProviderError::InvalidSecret => "invalid-secret",
        ProviderError::InvalidRequest => "invalid-request",
        ProviderError::DisclosureRequired => "disclosure-required",
        ProviderError::InvalidDisclosure => "invalid-disclosure",
        ProviderError::UnsafeEndpoint => "unsafe-endpoint",
        ProviderError::InvalidExecution => "invalid-execution",
        ProviderError::Timeout => "timeout",
        ProviderError::Cancelled => "cancelled",
        ProviderError::RemoteStreamFailed => "remote-stream-failed",
        ProviderError::Transport => "transport",
        ProviderError::HttpStatus(_) => "http-status",
        ProviderError::ResponseTooLarge => "response-too-large",
        ProviderError::MalformedResponse => "malformed-response",
    }
}

fn terminal_status(error: Option<&ProviderError>) -> &'static str {
    match error {
        None => "completed",
        Some(ProviderError::Timeout) => "timeout",
        Some(ProviderError::Cancelled) => "cancelled",
        Some(_) => "failed",
    }
}

fn run_record(
    request: &ProviderTaskRequest,
    endpoint: &Url,
    disclosure_accepted: bool,
    started_at: &str,
    completed_at: &str,
    response: Option<&NormalizedResponse>,
    zero_data_retention: Option<bool>,
    error: Option<&ProviderError>,
) -> Value {
    let provider_profile = profile(request.provider);
    let input_sha = serde_json::to_vec(&request.generation)
        .map(|bytes| sha256(&bytes))
        .unwrap_or_else(|_| sha256(b"serialization-failed"));
    let usage = response.and_then(|value| value.usage.as_ref());
    let error_code = error.map(error_code);
    let execution_mode = if matches!(endpoint.host_str(), Some("127.0.0.1" | "::1")) {
        "loopback-conformance"
    } else {
        "product"
    };
    let (zero_retention, attestation) = match zero_data_retention {
        Some(true) => (
            "attested",
            json!({ "kind": "response-header", "name": "x-zero-data-retention", "value": true }),
        ),
        Some(false) => (
            "not-attested",
            json!({ "kind": "response-header", "name": "x-zero-data-retention", "value": false }),
        ),
        None => (provider_profile.zero_retention, Value::Null),
    };
    json!({
        "recordVersion": 1,
        "runId": request.run_id,
        "callId": request.call_id,
        "executionMode": execution_mode,
        "provider": {
            "id": request.provider,
            "transport": provider_profile.transport,
            "model": request.generation.model,
            "adapterStatus": provider_profile.adapter_status,
            "remote": true
        },
        "request": {
            "taskType": request.task_type,
            "startedAt": started_at,
            "completedAt": completed_at,
            "sourceSnapshotIds": request.source_snapshot_ids,
            "inputSha256": input_sha,
            "maxOutputTokens": request.generation.max_output_tokens,
            "timeoutMs": request.timeout_ms,
            "stream": false
        },
        "disclosure": {
            "required": true,
            "approved": disclosure_accepted,
            "approvedAt": if disclosure_accepted { Some(started_at) } else { None },
            "destination": endpoint.as_str(),
            "policyUrl": provider_profile.policy_url,
            "policyCheckedAt": provider_profile.policy_checked_at
        },
        "dataHandling": {
            "storageRequest": provider_profile.storage_request,
            "zeroRetention": zero_retention,
            "attestation": attestation
        },
        "result": {
            "status": terminal_status(error),
            "outputSha256": response.map(|value| sha256(value.text.as_bytes())),
            "errorCode": error_code
        },
        "usage": {
            "inputTokens": usage.map(|value| value.input_tokens),
            "outputTokens": usage.map(|value| value.output_tokens),
            "totalTokens": usage.map(|value| value.total_tokens),
            "costUsd": Value::Null
        }
    })
}

#[doc(hidden)]
pub async fn execute_with<V: CredentialVault>(
    vault: &V,
    state: &ProviderRuntimeState,
    client: &Client,
    endpoint: Url,
    request: ProviderTaskRequest,
    disclosure_accepted: bool,
) -> Result<ProviderTaskOutcome, String> {
    validate_task(&request)?;
    let started_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    if !disclosure_accepted {
        let error = ProviderError::DisclosureRequired;
        let completed_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        return Ok(ProviderTaskOutcome {
            run_record: run_record(
                &request,
                &endpoint,
                false,
                &started_at,
                &completed_at,
                None,
                None,
                Some(&error),
            ),
            response: None,
            zero_data_retention: None,
            error_code: Some(error_code(&error).to_owned()),
        });
    }
    let (execution, cancellation) = provider_execution(Duration::from_millis(request.timeout_ms))
        .map_err(|error| error.to_string())?;
    let credential_id = CredentialId::new(request.provider, DEFAULT_PROFILE.to_owned())
        .map_err(|error| error.to_string())?;
    let secret = vault
        .get(&credential_id)
        .map_err(|error| error.to_string())?;
    {
        let mut calls = state
            .0
            .lock()
            .map_err(|_| "Provider cancellation registry is unavailable".to_owned())?;
        if calls.contains_key(&request.call_id) {
            return Err("Provider call ID is already active".to_owned());
        }
        calls.insert(request.call_id.clone(), cancellation);
    }
    let approval = TransmissionApproval {
        provider: request.provider,
        content_categories: request.content_categories.clone(),
        accepted: true,
    };
    let result = match request.provider {
        RemoteProviderId::OpenAi => execute_openai_response_controlled(
            client,
            &endpoint,
            &secret,
            &request.generation,
            &approval,
            execution,
        )
        .await
        .map(|response| (response, None)),
        RemoteProviderId::Anthropic => execute_anthropic_response_controlled(
            client,
            &endpoint,
            &secret,
            &request.generation,
            &approval,
            execution,
        )
        .await
        .map(|response| (response, None)),
        RemoteProviderId::Gemini => execute_gemini_response_controlled(
            client,
            &endpoint,
            &secret,
            &request.generation,
            &approval,
            execution,
        )
        .await
        .map(|response| (response, None)),
        RemoteProviderId::Xai => execute_xai_response_controlled(
            client,
            &endpoint,
            &secret,
            &request.generation,
            &approval,
            execution,
        )
        .await
        .map(|value| (value.response, Some(value.zero_data_retention))),
    };
    if let Ok(mut calls) = state.0.lock() {
        calls.remove(&request.call_id);
    }
    let completed_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    match result {
        Ok((response, zero_data_retention)) => Ok(ProviderTaskOutcome {
            run_record: run_record(
                &request,
                &endpoint,
                true,
                &started_at,
                &completed_at,
                Some(&response),
                zero_data_retention,
                None,
            ),
            response: Some(response),
            zero_data_retention,
            error_code: None,
        }),
        Err(error) => Ok(ProviderTaskOutcome {
            run_record: run_record(
                &request,
                &endpoint,
                true,
                &started_at,
                &completed_at,
                None,
                None,
                Some(&error),
            ),
            response: None,
            zero_data_retention: None,
            error_code: Some(error_code(&error).to_owned()),
        }),
    }
}

#[tauri::command]
pub async fn provider_generate(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProviderRuntimeState>,
    request: ProviderResearchTaskRequest,
) -> Result<ProviderTaskOutcome, String> {
    let endpoint = Url::parse(profile(request.provider).endpoint)
        .map_err(|_| "Built-in provider endpoint is invalid".to_owned())?;
    let request = build_research_task(request)?;
    let message = disclosure_message(&request, &endpoint);
    let approved = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title("Remote model disclosure")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Send once".to_owned(),
                "Cancel".to_owned(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|_| "Remote model disclosure dialog could not be shown".to_owned())?;
    execute_with(
        &OsCredentialVault,
        &state,
        &Client::new(),
        endpoint,
        request,
        approved,
    )
    .await
}

#[tauri::command]
pub fn provider_cancel(
    state: tauri::State<'_, ProviderRuntimeState>,
    call_id: String,
) -> Result<bool, String> {
    if !valid_id(&call_id) {
        return Err("Provider call ID is invalid".to_owned());
    }
    let calls = state
        .0
        .lock()
        .map_err(|_| "Provider cancellation registry is unavailable".to_owned())?;
    if let Some(handle) = calls.get(&call_id) {
        handle.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn provider_credential_set(provider: RemoteProviderId, secret: String) -> Result<(), String> {
    let id = CredentialId::new(provider, DEFAULT_PROFILE.to_owned())
        .map_err(|error| error.to_string())?;
    let secret =
        crate::model_provider::ProviderSecret::new(secret).map_err(|error| error.to_string())?;
    OsCredentialVault
        .set(&id, &secret)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn provider_credential_status(provider: RemoteProviderId) -> Result<bool, String> {
    let id = CredentialId::new(provider, DEFAULT_PROFILE.to_owned())
        .map_err(|error| error.to_string())?;
    match OsCredentialVault.get(&id) {
        Ok(secret) => {
            drop(secret);
            Ok(true)
        }
        Err(crate::credential_vault::CredentialVaultError::NotFound) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn provider_credential_delete(provider: RemoteProviderId) -> Result<(), String> {
    let id = CredentialId::new(provider, DEFAULT_PROFILE.to_owned())
        .map_err(|error| error.to_string())?;
    OsCredentialVault
        .delete(&id)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential_vault::{CredentialVault, CredentialVaultError};
    use crate::model_provider::{InputRole, ProviderInput, ProviderSecret};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[derive(Default)]
    struct MemoryVault(Mutex<HashMap<String, String>>);

    impl CredentialVault for MemoryVault {
        fn set(
            &self,
            id: &CredentialId,
            secret: &ProviderSecret,
        ) -> Result<(), CredentialVaultError> {
            self.0
                .lock()
                .unwrap()
                .insert(format!("{id:?}"), secret.expose().to_owned());
            Ok(())
        }
        fn get(&self, id: &CredentialId) -> Result<ProviderSecret, CredentialVaultError> {
            self.0
                .lock()
                .unwrap()
                .get(&format!("{id:?}"))
                .cloned()
                .ok_or(CredentialVaultError::NotFound)
                .and_then(|value| {
                    ProviderSecret::new(value).map_err(|_| CredentialVaultError::InvalidSecret)
                })
        }
        fn delete(&self, id: &CredentialId) -> Result<(), CredentialVaultError> {
            self.0
                .lock()
                .unwrap()
                .remove(&format!("{id:?}"))
                .map(|_| ())
                .ok_or(CredentialVaultError::NotFound)
        }
    }

    fn task() -> ProviderTaskRequest {
        ProviderTaskRequest {
            run_id: "runtime-run-001".to_owned(),
            call_id: "runtime-call-001".to_owned(),
            task_type: "adversarial.candidate".to_owned(),
            provider: RemoteProviderId::OpenAi,
            source_snapshot_ids: vec!["source-a".to_owned()],
            timeout_ms: 5_000,
            content_categories: vec!["selected research excerpts".to_owned()],
            generation: GenerationRequest {
                model: "fixture-model".to_owned(),
                input: vec![ProviderInput {
                    role: InputRole::User,
                    content: "fixture question".to_owned(),
                }],
                max_output_tokens: 128,
            },
        }
    }

    fn research_task() -> ProviderResearchTaskRequest {
        ProviderResearchTaskRequest {
            run_id: "research-run-001".to_owned(),
            call_id: "research-call-001".to_owned(),
            task_type: "adversarial.candidate".to_owned(),
            provider: RemoteProviderId::OpenAi,
            timeout_ms: 5_000,
            model: "fixture-model".to_owned(),
            developer_instructions: Some("Audit claims against the supplied source.".to_owned()),
            question: "Which conclusion is supported?".to_owned(),
            sources: vec![ProviderResearchSource {
                snapshot_id: "source-snapshot-001".to_owned(),
                label: "Source A".to_owned(),
                excerpt: "The bounded fixture evidence.".to_owned(),
            }],
            max_output_tokens: 128,
        }
    }

    #[test]
    fn runtime_uses_vault_executes_transport_and_authors_content_free_record() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let endpoint = Url::parse(&format!(
            "http://{}/v1/responses",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = vec![0_u8; 16 * 1024];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer runtime-secret-canary"));
            let body = r#"{"id":"response-fixture","status":"completed","model":"fixture-model","output":[{"type":"message","content":[{"type":"output_text","text":"bounded answer"}]}],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let vault = MemoryVault::default();
        let id = CredentialId::new(RemoteProviderId::OpenAi, DEFAULT_PROFILE.to_owned()).unwrap();
        vault
            .set(
                &id,
                &ProviderSecret::new("runtime-secret-canary".to_owned()).unwrap(),
            )
            .unwrap();
        let outcome = tauri::async_runtime::block_on(execute_with(
            &vault,
            &ProviderRuntimeState::default(),
            &Client::new(),
            endpoint,
            task(),
            true,
        ))
        .expect("runtime outcome");
        server.join().unwrap();
        assert_eq!(
            outcome.response.as_ref().map(|value| value.text.as_str()),
            Some("bounded answer")
        );
        assert_eq!(outcome.run_record["result"]["status"], "completed");
        assert_eq!(outcome.run_record["usage"]["totalTokens"], 6);
        let serialized = serde_json::to_string(&outcome).unwrap();
        assert!(!serialized.contains("runtime-secret-canary"));
        assert!(!serialized.contains("fixture question"));
        assert!(!serialized.contains("selected research excerpts"));
    }

    #[test]
    fn runtime_records_disclosure_denial_without_contacting_network() {
        struct VaultMustNotBeRead;
        impl CredentialVault for VaultMustNotBeRead {
            fn set(
                &self,
                _: &CredentialId,
                _: &ProviderSecret,
            ) -> Result<(), CredentialVaultError> {
                panic!("denied task must not write credentials")
            }
            fn get(&self, _: &CredentialId) -> Result<ProviderSecret, CredentialVaultError> {
                panic!("denied task must not read credentials")
            }
            fn delete(&self, _: &CredentialId) -> Result<(), CredentialVaultError> {
                panic!("denied task must not delete credentials")
            }
        }
        let endpoint = Url::parse("http://127.0.0.1:9/v1/responses").unwrap();
        let outcome = tauri::async_runtime::block_on(execute_with(
            &VaultMustNotBeRead,
            &ProviderRuntimeState::default(),
            &Client::new(),
            endpoint,
            task(),
            false,
        ))
        .expect("typed denial");
        assert_eq!(outcome.error_code.as_deref(), Some("disclosure-required"));
        assert_eq!(outcome.run_record["result"]["status"], "failed");
        assert_eq!(outcome.run_record["disclosure"]["approved"], false);
    }

    #[test]
    fn disclosure_is_bounded_informative_and_content_free() {
        let request = task();
        let endpoint = Url::parse(profile(request.provider).endpoint).unwrap();
        let message = disclosure_message(&request, &endpoint);
        assert!(message.contains("Provider: OpenAI"));
        assert!(message.contains("Model: fixture-model"));
        assert!(message.contains("Content categories: selected research excerpts"));
        assert!(message.contains("Requests: 1"));
        assert!(message.contains("Storage request: disabled"));
        assert!(message.contains("Policy reviewed:"));
        assert!(message.contains("https://platform.openai.com/"));
        assert!(!message.contains("fixture question"));
    }

    #[test]
    fn disclosure_fields_reject_control_characters_before_dialog_or_transport() {
        let mut request = task();
        request.content_categories = vec!["selected excerpts\nDestination: attacker".to_owned()];
        assert!(validate_task(&request).is_err());

        let mut request = task();
        request.generation.model = "fixture\nRequests: 0".to_owned();
        assert!(validate_task(&request).is_err());
    }

    #[test]
    fn research_task_derives_disclosure_and_provenance_from_actual_payload() {
        let task = build_research_task(research_task()).expect("derived task");
        assert_eq!(task.source_snapshot_ids, ["source-snapshot-001"]);
        assert_eq!(
            task.content_categories,
            [
                "task instructions",
                "research question",
                "selected source excerpts and labels"
            ]
        );
        assert_eq!(task.generation.input.len(), 2);
        let user = &task.generation.input[1].content;
        assert!(user.contains("Which conclusion is supported?"));
        assert!(user.contains("source-snapshot-001"));
        assert!(user.contains("The bounded fixture evidence."));
    }

    #[test]
    fn research_task_rejects_forged_or_misleading_source_metadata() {
        let mut duplicate = research_task();
        duplicate.sources.push(duplicate.sources[0].clone());
        assert!(build_research_task(duplicate).is_err());

        let mut misleading = research_task();
        misleading.sources[0].label = "Source A\nRequests: 0".to_owned();
        assert!(build_research_task(misleading).is_err());
    }
}

//! Product boundary for opt-in remote model tasks.
//!
//! This is intentionally narrower than the transport module: built-in endpoints only, one default
//! OS-vault credential per provider, explicit disclosure approval, one-shot execution, caller
//! cancellation, sanitized output, and a content-free provenance record authored in Rust.

use crate::credential_vault::{CredentialId, CredentialVault, OsCredentialVault};
use crate::model_provider::{
    execute_anthropic_response_controlled, execute_gemini_response_controlled,
    execute_openai_response_controlled, execute_xai_response_controlled, provider_execution,
    GenerationRequest, NormalizedResponse, ProviderCancellation, ProviderError, RemoteProviderId,
    TransmissionApproval, ANTHROPIC_ADAPTER_STATUS, GEMINI_ADAPTER_STATUS, OPENAI_ADAPTER_STATUS,
    XAI_ADAPTER_STATUS,
};
use chrono::{SecondsFormat, Utc};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

const DEFAULT_PROFILE: &str = "default";

#[derive(Default)]
pub struct ProviderRuntimeState(Mutex<HashMap<String, ProviderCancellation>>);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTaskRequest {
    pub run_id: String,
    pub call_id: String,
    pub task_type: String,
    pub provider: RemoteProviderId,
    pub source_snapshot_ids: Vec<String>,
    pub timeout_ms: u64,
    pub disclosure_accepted: bool,
    pub content_categories: Vec<String>,
    pub generation: GenerationRequest,
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
    !value.trim().is_empty() && value.chars().count() <= 200
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
    {
        return Err("Provider task identity or source provenance is invalid".to_owned());
    }
    Ok(())
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
            "approved": request.disclosure_accepted,
            "approvedAt": if request.disclosure_accepted { Some(started_at) } else { None },
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

async fn execute_with<V: CredentialVault>(
    vault: &V,
    state: &ProviderRuntimeState,
    client: &Client,
    endpoint: Url,
    request: ProviderTaskRequest,
) -> Result<ProviderTaskOutcome, String> {
    validate_task(&request)?;
    let credential_id = CredentialId::new(request.provider, DEFAULT_PROFILE.to_owned())
        .map_err(|error| error.to_string())?;
    let secret = vault
        .get(&credential_id)
        .map_err(|error| error.to_string())?;
    let (execution, cancellation) = provider_execution(Duration::from_millis(request.timeout_ms))
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
    let started_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let approval = TransmissionApproval {
        provider: request.provider,
        content_categories: request.content_categories.clone(),
        accepted: request.disclosure_accepted,
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

#[allow(dead_code)] // Registered only after the native disclosure UI can authorize each call.
pub async fn provider_generate(
    state: tauri::State<'_, ProviderRuntimeState>,
    request: ProviderTaskRequest,
) -> Result<ProviderTaskOutcome, String> {
    let endpoint = Url::parse(profile(request.provider).endpoint)
        .map_err(|_| "Built-in provider endpoint is invalid".to_owned())?;
    execute_with(
        &OsCredentialVault,
        &state,
        &Client::new(),
        endpoint,
        request,
    )
    .await
}

#[allow(dead_code)] // Registered with provider_generate after the disclosure UI lands.
pub fn provider_cancel(
    state: tauri::State<'_, ProviderRuntimeState>,
    call_id: String,
) -> Result<bool, String> {
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
            disclosure_accepted: true,
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
        let vault = MemoryVault::default();
        let id = CredentialId::new(RemoteProviderId::OpenAi, DEFAULT_PROFILE.to_owned()).unwrap();
        vault
            .set(&id, &ProviderSecret::new("fixture-key".to_owned()).unwrap())
            .unwrap();
        let mut denied = task();
        denied.disclosure_accepted = false;
        let endpoint = Url::parse("http://127.0.0.1:9/v1/responses").unwrap();
        let outcome = tauri::async_runtime::block_on(execute_with(
            &vault,
            &ProviderRuntimeState::default(),
            &Client::new(),
            endpoint,
            denied,
        ))
        .expect("typed denial");
        assert_eq!(outcome.error_code.as_deref(), Some("disclosure-required"));
        assert_eq!(outcome.run_record["result"]["status"], "failed");
        assert_eq!(outcome.run_record["disclosure"]["approved"], false);
    }
}

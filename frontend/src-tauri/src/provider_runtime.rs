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
use std::time::{Duration, Instant};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const DEFAULT_PROFILE: &str = "default";

const BATCH_AUTHORIZATION_LIFETIME: Duration = Duration::from_secs(30 * 60);
const MAX_BATCH_AUTHORIZATIONS: usize = 64;

#[derive(Default)]
pub struct ProviderRuntimeState {
    calls: Mutex<HashMap<String, ProviderCancellation>>,
    batch_authorizations: Mutex<HashMap<String, ProviderBatchAuthorization>>,
}

#[derive(Clone, Debug)]
struct ProviderBatchAuthorization {
    run_id: String,
    scope_sha256: String,
    source_snapshot_ids: Vec<String>,
    routes: Vec<ProviderBatchRouteStatus>,
    remaining_calls: u32,
    #[cfg_attr(not(test), allow(dead_code))]
    used_call_ids: HashSet<String>,
    expires_at: Instant,
    expires_at_text: String,
}

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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResearchSource {
    pub snapshot_id: String,
    pub label: String,
    pub excerpt: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBatchRoute {
    pub provider: RemoteProviderId,
    pub model: String,
    pub max_calls: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAdversarialAuthorizationRequest {
    pub run_id: String,
    pub question: String,
    pub sources: Vec<ProviderResearchSource>,
    pub routes: Vec<ProviderBatchRoute>,
    pub total_remote_calls: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBatchAuthorizationOutcome {
    pub authorization_id: Option<String>,
    pub approved: bool,
    pub expires_at: Option<String>,
    pub scope_sha256: String,
    pub total_remote_calls: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBatchAuthorizationStatus {
    pub run_id: String,
    pub scope_sha256: String,
    pub source_snapshot_ids: Vec<String>,
    pub routes: Vec<ProviderBatchRouteStatus>,
    pub remaining_calls: u32,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBatchRouteStatus {
    pub provider: RemoteProviderId,
    pub model: String,
    pub max_calls: u32,
    pub remaining_calls: u32,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug)]
struct ProviderBatchCallScope {
    authorization_id: String,
    run_id: String,
    call_id: String,
    provider: RemoteProviderId,
    model: String,
    source_snapshot_ids: Vec<String>,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug, Eq, PartialEq)]
enum ProviderBatchReservationError {
    InvalidScope,
    Missing,
    Expired,
    DuplicateCall,
    BudgetExhausted,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug, Eq, PartialEq)]
struct ProviderBatchReservation {
    call_id: String,
    remaining_route_calls: u32,
    remaining_total_calls: u32,
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

fn validate_batch_authorization(
    request: &ProviderAdversarialAuthorizationRequest,
) -> Result<(), String> {
    let unique_sources: HashSet<_> = request
        .sources
        .iter()
        .map(|source| source.snapshot_id.as_str())
        .collect();
    let unique_routes: HashSet<_> = request
        .routes
        .iter()
        .map(|route| format!("{:?}\0{}", route.provider, route.model))
        .collect();
    let summed_calls = request
        .routes
        .iter()
        .try_fold(0_u32, |sum, route| sum.checked_add(route.max_calls));
    if !valid_id(&request.run_id)
        || request.question.trim().is_empty()
        || request.question.len() > 4 * 1024 * 1024
        || request.sources.is_empty()
        || request.sources.len() > 200
        || unique_sources.len() != request.sources.len()
        || request.sources.iter().any(|source| {
            !valid_id(&source.snapshot_id)
                || source.label.trim().is_empty()
                || source.label.chars().count() > 500
                || source.label.chars().any(char::is_control)
                || source.excerpt.trim().is_empty()
                || source.excerpt.len() > 4 * 1024 * 1024
        })
        || request.routes.is_empty()
        || request.routes.len() > 20
        || unique_routes.len() != request.routes.len()
        || request.routes.iter().any(|route| {
            route.model.trim().is_empty()
                || route.model.chars().count() > 200
                || route.model.chars().any(char::is_control)
                || !(1..=100).contains(&route.max_calls)
        })
        || !(1..=100).contains(&request.total_remote_calls)
        || summed_calls != Some(request.total_remote_calls)
    {
        return Err("Remote adversarial authorization scope is invalid".to_owned());
    }
    Ok(())
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

fn batch_disclosure_message(request: &ProviderAdversarialAuthorizationRequest) -> String {
    let routes = request
        .routes
        .iter()
        .map(|route| {
            let provider_profile = profile(route.provider);
            format!(
                "- {} / {}: up to {} requests; storage {}; zero retention {}; policy reviewed {}; {}",
                provider_name(route.provider),
                route.model,
                route.max_calls,
                provider_profile.storage_request,
                provider_profile.zero_retention,
                provider_profile.policy_checked_at,
                provider_profile.policy_url,
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Authorize this adversarial review batch?\n\nRemote requests: up to {}\nFrozen source snapshots: {}\nAuthorization lifetime: 30 minutes\n\nRoutes:\n{}\n\nContent categories: research question; selected source excerpts and labels; remote model outputs and review artifacts.\n\nEach listed provider receives only calls within this approved scope. Changing a route, increasing the call budget, or changing the frozen source identity requires a new authorization. No credential is read until an authorized call begins.",
        request.total_remote_calls,
        request.sources.len(),
        routes,
    )
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn random_authorization_id() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| "Remote batch authorization ID could not be created".to_owned())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn authorize_batch_with(
    state: &ProviderRuntimeState,
    request: ProviderAdversarialAuthorizationRequest,
    approved: bool,
) -> Result<ProviderBatchAuthorizationOutcome, String> {
    validate_batch_authorization(&request)?;
    let scope_sha256 = serde_json::to_vec(&request)
        .map(|bytes| sha256(&bytes))
        .map_err(|_| "Remote batch authorization scope could not be serialized".to_owned())?;
    if !approved {
        return Ok(ProviderBatchAuthorizationOutcome {
            authorization_id: None,
            approved: false,
            expires_at: None,
            scope_sha256,
            total_remote_calls: request.total_remote_calls,
        });
    }
    let authorization_id = random_authorization_id()?;
    let expires_instant = Instant::now() + BATCH_AUTHORIZATION_LIFETIME;
    let expires_at = (Utc::now()
        + chrono::Duration::from_std(BATCH_AUTHORIZATION_LIFETIME)
            .map_err(|_| "Remote batch authorization lifetime is invalid".to_owned())?)
    .to_rfc3339_opts(SecondsFormat::Millis, true);
    let authorization = ProviderBatchAuthorization {
        run_id: request.run_id,
        scope_sha256: scope_sha256.clone(),
        source_snapshot_ids: request
            .sources
            .into_iter()
            .map(|source| source.snapshot_id)
            .collect(),
        routes: request
            .routes
            .into_iter()
            .map(|route| ProviderBatchRouteStatus {
                provider: route.provider,
                model: route.model,
                max_calls: route.max_calls,
                remaining_calls: route.max_calls,
            })
            .collect(),
        remaining_calls: request.total_remote_calls,
        used_call_ids: HashSet::new(),
        expires_at: expires_instant,
        expires_at_text: expires_at.clone(),
    };
    let mut authorizations = state
        .batch_authorizations
        .lock()
        .map_err(|_| "Remote batch authorization registry is unavailable".to_owned())?;
    authorizations.retain(|_, authorization| authorization.expires_at > Instant::now());
    if authorizations.len() >= MAX_BATCH_AUTHORIZATIONS {
        return Err("Too many remote batch authorizations are active".to_owned());
    }
    authorizations.insert(authorization_id.clone(), authorization);
    Ok(ProviderBatchAuthorizationOutcome {
        authorization_id: Some(authorization_id),
        approved: true,
        expires_at: Some(expires_at),
        scope_sha256,
        total_remote_calls: request.total_remote_calls,
    })
}

fn valid_authorization_id(authorization_id: &str) -> bool {
    authorization_id.len() == 64
        && authorization_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg_attr(not(test), allow(dead_code))]
fn reserve_batch_call(
    state: &ProviderRuntimeState,
    scope: ProviderBatchCallScope,
) -> Result<ProviderBatchReservation, ProviderBatchReservationError> {
    if !valid_authorization_id(&scope.authorization_id)
        || !valid_id(&scope.run_id)
        || !valid_id(&scope.call_id)
        || scope.model.trim().is_empty()
        || scope.model.chars().count() > 200
        || scope.model.chars().any(char::is_control)
        || scope.source_snapshot_ids.is_empty()
        || scope.source_snapshot_ids.len() > 200
        || scope.source_snapshot_ids.iter().any(|id| !valid_id(id))
        || scope
            .source_snapshot_ids
            .iter()
            .collect::<HashSet<_>>()
            .len()
            != scope.source_snapshot_ids.len()
    {
        return Err(ProviderBatchReservationError::InvalidScope);
    }
    let mut authorizations = state
        .batch_authorizations
        .lock()
        .map_err(|_| ProviderBatchReservationError::Missing)?;
    let Some(authorization) = authorizations.get_mut(&scope.authorization_id) else {
        return Err(ProviderBatchReservationError::Missing);
    };
    if authorization.expires_at <= Instant::now() {
        authorizations.remove(&scope.authorization_id);
        return Err(ProviderBatchReservationError::Expired);
    }
    let same_sources = authorization.source_snapshot_ids.len() == scope.source_snapshot_ids.len()
        && authorization
            .source_snapshot_ids
            .iter()
            .all(|id| scope.source_snapshot_ids.contains(id));
    if authorization.run_id != scope.run_id || !same_sources {
        return Err(ProviderBatchReservationError::InvalidScope);
    }
    if authorization.used_call_ids.contains(&scope.call_id) {
        return Err(ProviderBatchReservationError::DuplicateCall);
    }
    let Some(route) = authorization
        .routes
        .iter_mut()
        .find(|route| route.provider == scope.provider && route.model == scope.model)
    else {
        return Err(ProviderBatchReservationError::InvalidScope);
    };
    if authorization.remaining_calls == 0 || route.remaining_calls == 0 {
        return Err(ProviderBatchReservationError::BudgetExhausted);
    }
    authorization.used_call_ids.insert(scope.call_id.clone());
    authorization.remaining_calls -= 1;
    route.remaining_calls -= 1;
    Ok(ProviderBatchReservation {
        call_id: scope.call_id,
        remaining_route_calls: route.remaining_calls,
        remaining_total_calls: authorization.remaining_calls,
    })
}

fn revoke_batch_with(state: &ProviderRuntimeState, authorization_id: &str) -> Result<bool, String> {
    if !valid_authorization_id(authorization_id) {
        return Err("Remote batch authorization ID is invalid".to_owned());
    }
    let mut authorizations = state
        .batch_authorizations
        .lock()
        .map_err(|_| "Remote batch authorization registry is unavailable".to_owned())?;
    Ok(authorizations.remove(authorization_id).is_some())
}

fn batch_status_with(
    state: &ProviderRuntimeState,
    authorization_id: &str,
) -> Result<Option<ProviderBatchAuthorizationStatus>, String> {
    if !valid_authorization_id(authorization_id) {
        return Err("Remote batch authorization ID is invalid".to_owned());
    }
    let mut authorizations = state
        .batch_authorizations
        .lock()
        .map_err(|_| "Remote batch authorization registry is unavailable".to_owned())?;
    if authorizations
        .get(authorization_id)
        .is_some_and(|authorization| authorization.expires_at <= Instant::now())
    {
        authorizations.remove(authorization_id);
        return Ok(None);
    }
    Ok(authorizations
        .get(authorization_id)
        .map(|authorization| ProviderBatchAuthorizationStatus {
            run_id: authorization.run_id.clone(),
            scope_sha256: authorization.scope_sha256.clone(),
            source_snapshot_ids: authorization.source_snapshot_ids.clone(),
            routes: authorization.routes.clone(),
            remaining_calls: authorization.remaining_calls,
            expires_at: authorization.expires_at_text.clone(),
        }))
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
            .calls
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
    if let Ok(mut calls) = state.calls.lock() {
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
pub async fn provider_adversarial_authorize(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProviderRuntimeState>,
    request: ProviderAdversarialAuthorizationRequest,
) -> Result<ProviderBatchAuthorizationOutcome, String> {
    validate_batch_authorization(&request)?;
    let message = batch_disclosure_message(&request);
    let approved = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title("Adversarial review disclosure")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Authorize batch".to_owned(),
                "Cancel".to_owned(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|_| "Remote batch disclosure dialog could not be shown".to_owned())?;
    authorize_batch_with(&state, request, approved)
}

#[tauri::command]
pub fn provider_adversarial_revoke(
    state: tauri::State<'_, ProviderRuntimeState>,
    authorization_id: String,
) -> Result<bool, String> {
    revoke_batch_with(&state, &authorization_id)
}

#[tauri::command]
pub fn provider_adversarial_authorization_status(
    state: tauri::State<'_, ProviderRuntimeState>,
    authorization_id: String,
) -> Result<Option<ProviderBatchAuthorizationStatus>, String> {
    batch_status_with(&state, &authorization_id)
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
        .calls
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
    use std::sync::Arc;
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

    fn batch_authorization() -> ProviderAdversarialAuthorizationRequest {
        ProviderAdversarialAuthorizationRequest {
            run_id: "adversarial-run-001".to_owned(),
            question: "Which conclusion is supported?".to_owned(),
            sources: vec![ProviderResearchSource {
                snapshot_id: "source-snapshot-001".to_owned(),
                label: "Private fixture label".to_owned(),
                excerpt: "private-source-content-canary".to_owned(),
            }],
            routes: vec![
                ProviderBatchRoute {
                    provider: RemoteProviderId::OpenAi,
                    model: "proposal-model".to_owned(),
                    max_calls: 4,
                },
                ProviderBatchRoute {
                    provider: RemoteProviderId::Anthropic,
                    model: "judge-model".to_owned(),
                    max_calls: 3,
                },
            ],
            total_remote_calls: 7,
        }
    }

    fn batch_call(
        authorization_id: &str,
        call_id: &str,
        provider: RemoteProviderId,
        model: &str,
    ) -> ProviderBatchCallScope {
        ProviderBatchCallScope {
            authorization_id: authorization_id.to_owned(),
            run_id: "adversarial-run-001".to_owned(),
            call_id: call_id.to_owned(),
            provider,
            model: model.to_owned(),
            source_snapshot_ids: vec!["source-snapshot-001".to_owned()],
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

    #[test]
    fn adversarial_batch_disclosure_is_scope_complete_and_content_free() {
        let request = batch_authorization();
        let message = batch_disclosure_message(&request);
        assert!(message.contains("Remote requests: up to 7"));
        assert!(message.contains("OpenAI / proposal-model: up to 4 requests"));
        assert!(message.contains("Anthropic / judge-model: up to 3 requests"));
        assert!(message.contains("remote model outputs and review artifacts"));
        assert!(message.contains("Storage") || message.contains("storage"));
        assert!(message.contains("Policy") || message.contains("policy"));
        assert!(!message.contains("Which conclusion is supported?"));
        assert!(!message.contains("Private fixture label"));
        assert!(!message.contains("private-source-content-canary"));
    }

    #[test]
    fn adversarial_batch_scope_rejects_budget_route_and_source_forgery() {
        let mut wrong_budget = batch_authorization();
        wrong_budget.total_remote_calls = 6;
        assert!(validate_batch_authorization(&wrong_budget).is_err());

        let mut duplicate_route = batch_authorization();
        duplicate_route
            .routes
            .push(duplicate_route.routes[0].clone());
        duplicate_route.total_remote_calls = 11;
        assert!(validate_batch_authorization(&duplicate_route).is_err());

        let mut misleading_model = batch_authorization();
        misleading_model.routes[0].model = "model\nRemote requests: 0".to_owned();
        assert!(validate_batch_authorization(&misleading_model).is_err());

        let mut duplicate_source = batch_authorization();
        duplicate_source
            .sources
            .push(duplicate_source.sources[0].clone());
        assert!(validate_batch_authorization(&duplicate_source).is_err());

        let mut no_sources = batch_authorization();
        no_sources.sources.clear();
        assert!(validate_batch_authorization(&no_sources).is_err());
    }

    #[test]
    fn adversarial_batch_denial_stores_no_authority_and_acceptance_is_revocable() {
        let state = ProviderRuntimeState::default();
        let denied = authorize_batch_with(&state, batch_authorization(), false).unwrap();
        assert!(!denied.approved);
        assert!(denied.authorization_id.is_none());
        assert!(state.batch_authorizations.lock().unwrap().is_empty());

        let approved = authorize_batch_with(&state, batch_authorization(), true).unwrap();
        let authorization_id = approved.authorization_id.expect("authorization ID");
        assert!(approved.approved);
        assert_eq!(authorization_id.len(), 64);
        assert!(authorization_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        let authorizations = state.batch_authorizations.lock().unwrap();
        let stored = authorizations.get(&authorization_id).expect("stored scope");
        assert_eq!(stored.run_id, "adversarial-run-001");
        assert_eq!(stored.scope_sha256, approved.scope_sha256);
        assert_eq!(stored.source_snapshot_ids, ["source-snapshot-001"]);
        assert_eq!(stored.routes.len(), 2);
        assert_eq!(stored.remaining_calls, 7);
        assert!(stored.expires_at > Instant::now());
        drop(authorizations);
        let status = batch_status_with(&state, &authorization_id)
            .unwrap()
            .expect("active status");
        assert_eq!(status.run_id, "adversarial-run-001");
        assert_eq!(status.scope_sha256, approved.scope_sha256);
        assert_eq!(status.source_snapshot_ids, ["source-snapshot-001"]);
        assert_eq!(status.routes.len(), 2);
        assert_eq!(status.remaining_calls, 7);
        assert_eq!(status.expires_at, approved.expires_at.unwrap());
        let serialized_status = serde_json::to_string(&status).unwrap();
        assert!(!serialized_status.contains("Which conclusion is supported?"));
        assert!(!serialized_status.contains("Private fixture label"));
        assert!(!serialized_status.contains("private-source-content-canary"));
        assert!(revoke_batch_with(&state, &authorization_id).unwrap());
        assert!(!revoke_batch_with(&state, &authorization_id).unwrap());
        assert!(state.batch_authorizations.lock().unwrap().is_empty());
    }

    #[test]
    fn adversarial_batch_reservations_atomically_enforce_scope_ids_and_budgets() {
        let state = Arc::new(ProviderRuntimeState::default());
        let approved = authorize_batch_with(&state, batch_authorization(), true).unwrap();
        let authorization_id = approved.authorization_id.unwrap();

        let mut wrong_run = batch_call(
            &authorization_id,
            "wrong-run",
            RemoteProviderId::OpenAi,
            "proposal-model",
        );
        wrong_run.run_id = "other-run".to_owned();
        assert_eq!(
            reserve_batch_call(&state, wrong_run),
            Err(ProviderBatchReservationError::InvalidScope)
        );

        let attempts = (0..8)
            .map(|index| {
                let state = Arc::clone(&state);
                let scope = batch_call(
                    &authorization_id,
                    &format!("parallel-call-{index}"),
                    RemoteProviderId::OpenAi,
                    "proposal-model",
                );
                thread::spawn(move || reserve_batch_call(&state, scope))
            })
            .collect::<Vec<_>>();
        let results = attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .collect::<Vec<_>>();
        let reservations = results
            .iter()
            .filter_map(|result| result.as_ref().ok())
            .collect::<Vec<_>>();
        assert_eq!(reservations.len(), 4);
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == Err(ProviderBatchReservationError::BudgetExhausted))
                .count(),
            4
        );

        let duplicate_id = reservations[0].call_id.clone();
        assert_eq!(
            reserve_batch_call(
                &state,
                batch_call(
                    &authorization_id,
                    &duplicate_id,
                    RemoteProviderId::Anthropic,
                    "judge-model",
                ),
            ),
            Err(ProviderBatchReservationError::DuplicateCall)
        );
        for index in 0..3 {
            reserve_batch_call(
                &state,
                batch_call(
                    &authorization_id,
                    &format!("judge-call-{index}"),
                    RemoteProviderId::Anthropic,
                    "judge-model",
                ),
            )
            .unwrap();
        }
        assert_eq!(
            reserve_batch_call(
                &state,
                batch_call(
                    &authorization_id,
                    "judge-over-budget",
                    RemoteProviderId::Anthropic,
                    "judge-model",
                ),
            ),
            Err(ProviderBatchReservationError::BudgetExhausted)
        );
        let status = batch_status_with(&state, &authorization_id)
            .unwrap()
            .expect("active scope");
        assert_eq!(status.remaining_calls, 0);
        assert!(status.routes.iter().all(|route| route.remaining_calls == 0));
    }

    #[test]
    fn adversarial_batch_reservation_removes_expired_authority_without_consuming() {
        let state = ProviderRuntimeState::default();
        let approved = authorize_batch_with(&state, batch_authorization(), true).unwrap();
        let authorization_id = approved.authorization_id.unwrap();
        state
            .batch_authorizations
            .lock()
            .unwrap()
            .get_mut(&authorization_id)
            .unwrap()
            .expires_at = Instant::now() - Duration::from_secs(1);

        assert_eq!(
            reserve_batch_call(
                &state,
                batch_call(
                    &authorization_id,
                    "expired-call",
                    RemoteProviderId::OpenAi,
                    "proposal-model",
                ),
            ),
            Err(ProviderBatchReservationError::Expired)
        );
        assert!(state.batch_authorizations.lock().unwrap().is_empty());
    }
}

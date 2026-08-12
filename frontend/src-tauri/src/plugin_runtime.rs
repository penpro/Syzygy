//! No-authority WebAssembly Component host for researcher plugins.
//!
//! This baseline runtime links the published zero-import WIT world and nothing else. It accepts
//! one in-memory component and one already-authorized bounded invocation, then returns either a
//! no-change reason or revision-guarded proposals. It cannot install plugins or mutate projects.

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use wasmparser::{Encoding, Parser, Payload};
use wasmtime::component::{Component, Linker};
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder};

wasmtime::component::bindgen!({
    world: "plugin",
    path: "../../docs/wit/syzygy-research-plugin-v1.wit",
});

use self::exports::syzygy::research::research_plugin;

pub const RESEARCH_PLUGIN_WIT_WORLD: &str = "syzygy:research/plugin@1.0.0";
const MAX_COMPONENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENVELOPE_BYTES: usize = 1024 * 1024;
const MAX_LINEAR_MEMORY_BYTES: usize = 32 * 1024 * 1024;
const MAX_SOURCES: usize = 200;
const MAX_PROPOSALS: usize = 32;
const EXECUTION_FUEL: u64 = 50_000_000;
const EXECUTION_DEADLINE: Duration = Duration::from_secs(2);
const WORKER_DEADLINE: Duration = Duration::from_secs(5);
const MAX_COMPONENT_BASE64_BYTES: usize = ((MAX_COMPONENT_BYTES + 2) / 3) * 4;
const MAX_WORKER_REQUEST_BYTES: usize = MAX_COMPONENT_BASE64_BYTES + MAX_ENVELOPE_BYTES + 4096;
const MAX_WORKER_RESPONSE_BYTES: usize = MAX_ENVELOPE_BYTES + 4096;

static EXECUTION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginRuntimeSourceSnapshot {
    pub snapshot_id: String,
    pub label: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginRuntimeProjectSnapshot {
    pub project_id: String,
    pub revision: String,
    pub document_text: String,
    pub sources: Vec<PluginRuntimeSourceSnapshot>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginRuntimeInvocation {
    pub invocation_version: u32,
    pub plugin_id: String,
    pub contribution_id: String,
    pub project: Option<PluginRuntimeProjectSnapshot>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginProposalOperation {
    Append,
    Replace,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginRuntimeChangeProposal {
    pub proposal_version: u32,
    pub proposal_id: String,
    pub plugin_id: String,
    pub project_id: String,
    pub expected_revision: String,
    pub summary: String,
    pub content: String,
    pub operation: PluginProposalOperation,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PluginRuntimeOutput {
    NoChange {
        reason: String,
    },
    Proposals {
        proposals: Vec<PluginRuntimeChangeProposal>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginRuntimeLimitsReport {
    pub max_component_bytes: usize,
    pub max_envelope_bytes: usize,
    pub max_linear_memory_bytes: usize,
    pub max_sources: usize,
    pub max_proposals: usize,
    pub execution_fuel: u64,
    pub execution_deadline_ms: u64,
    pub ambient_imports_linked: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginRuntimeResult {
    pub runtime_version: u32,
    pub world: String,
    pub output: PluginRuntimeOutput,
    pub limits: PluginRuntimeLimitsReport,
}

struct RuntimeStore {
    limits: StoreLimits,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginWorkerRequest {
    component_base64: String,
    invocation: PluginRuntimeInvocation,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginWorkerResponse {
    ok: bool,
    result: Option<PluginRuntimeResult>,
    error: Option<String>,
}

fn error(code: &str) -> String {
    format!("plugin-runtime:{code}")
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn has_control(value: &str) -> bool {
    value.chars().any(|character| character.is_control())
}

fn valid_id(value: &str, maximum: usize) -> bool {
    !value.is_empty() && utf16_len(value) <= maximum && !has_control(value)
}

fn valid_plugin_id(value: &str) -> bool {
    if !valid_id(value, 200)
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
        })
    {
        return false;
    }
    let mut segment_count = 0usize;
    for segment in value.split(|character| character == '.' || character == '-') {
        if segment.is_empty()
            || !segment
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        {
            return false;
        }
        segment_count += 1;
    }
    segment_count >= 2
}

fn valid_contribution_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(first) if first.is_ascii_lowercase())
        && utf16_len(value) <= 120
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn validate_invocation(invocation: &PluginRuntimeInvocation) -> Result<usize, String> {
    let serialized = serde_json::to_vec(invocation).map_err(|_| error("invocation-invalid"))?;
    if serialized.len() > MAX_ENVELOPE_BYTES
        || invocation.invocation_version != 1
        || !valid_plugin_id(&invocation.plugin_id)
        || !valid_contribution_id(&invocation.contribution_id)
    {
        return Err(error("invocation-invalid"));
    }

    if let Some(project) = &invocation.project {
        if !valid_id(&project.project_id, 200)
            || !valid_id(&project.revision, 500)
            || utf16_len(&project.document_text) > 500_000
            || project.sources.len() > MAX_SOURCES
        {
            return Err(error("invocation-invalid"));
        }
        let mut source_ids = HashSet::with_capacity(project.sources.len());
        for source in &project.sources {
            if !valid_id(&source.snapshot_id, 200)
                || !valid_id(&source.label, 500)
                || utf16_len(&source.content) > 200_000
                || !source_ids.insert(source.snapshot_id.as_str())
            {
                return Err(error("invocation-invalid"));
            }
        }
    }
    Ok(serialized.len())
}

fn inspect_component(component: &[u8]) -> Result<(), String> {
    if component.is_empty() || component.len() > MAX_COMPONENT_BYTES {
        return Err(error("component-size"));
    }
    let mut encoding = None;
    for payload in Parser::new(0).parse_all(component) {
        match payload.map_err(|_| error("component-invalid"))? {
            Payload::Version {
                encoding: discovered,
                ..
            } if encoding.is_none() => {
                encoding = Some(discovered);
            }
            Payload::ComponentImportSection(section) if section.count() > 0 => {
                return Err(error("imports-denied"));
            }
            _ => {}
        }
    }
    if encoding != Some(Encoding::Component) {
        return Err(error("component-invalid"));
    }
    Ok(())
}

fn runtime_engine() -> Result<Engine, String> {
    let mut config = Config::new();
    config
        .wasm_component_model(true)
        .consume_fuel(true)
        .epoch_interruption(true)
        .max_wasm_stack(1024 * 1024);
    Engine::new(&config).map_err(|_| error("runtime-unavailable"))
}

fn runtime_store(engine: &Engine) -> Result<Store<RuntimeStore>, String> {
    let limits = StoreLimitsBuilder::new()
        .memory_size(MAX_LINEAR_MEMORY_BYTES)
        .memories(4)
        .tables(4)
        .instances(16)
        .table_elements(10_000)
        .build();
    let mut store = Store::new(engine, RuntimeStore { limits });
    store.limiter(|state| &mut state.limits);
    store
        .set_fuel(EXECUTION_FUEL)
        .map_err(|_| error("runtime-unavailable"))?;
    store.set_epoch_deadline(1);
    Ok(store)
}

fn wit_invocation(invocation: &PluginRuntimeInvocation) -> research_plugin::Invocation {
    use research_plugin::{Invocation, ProjectSnapshot, SourceSnapshot};
    Invocation {
        invocation_version: invocation.invocation_version,
        plugin_id: invocation.plugin_id.clone(),
        contribution_id: invocation.contribution_id.clone(),
        project: invocation.project.as_ref().map(|project| ProjectSnapshot {
            project_id: project.project_id.clone(),
            revision: project.revision.clone(),
            document_text: project.document_text.clone(),
            sources: project
                .sources
                .iter()
                .map(|source| SourceSnapshot {
                    snapshot_id: source.snapshot_id.clone(),
                    label: source.label.clone(),
                    content: source.content.clone(),
                })
                .collect(),
        }),
    }
}

fn host_output(
    invocation: &PluginRuntimeInvocation,
    output: research_plugin::Output,
) -> Result<PluginRuntimeOutput, String> {
    use research_plugin::{Output, ProposalOperation};
    let output = match output {
        Output::NoChange(reason) => {
            if reason.trim().is_empty() || utf16_len(&reason) > 1_000 {
                return Err(error("output-invalid"));
            }
            PluginRuntimeOutput::NoChange { reason }
        }
        Output::Proposals(proposals) => {
            let Some(project) = &invocation.project else {
                return Err(error("output-invalid"));
            };
            if proposals.is_empty() || proposals.len() > MAX_PROPOSALS {
                return Err(error("output-invalid"));
            }
            let mut proposal_ids = HashSet::with_capacity(proposals.len());
            let mut converted = Vec::with_capacity(proposals.len());
            for proposal in proposals {
                if proposal.proposal_version != 1
                    || !valid_id(&proposal.proposal_id, 120)
                    || !proposal_ids.insert(proposal.proposal_id.clone())
                    || proposal.plugin_id != invocation.plugin_id
                    || proposal.project_id != project.project_id
                    || proposal.expected_revision != project.revision
                    || proposal.summary.trim().is_empty()
                    || utf16_len(&proposal.summary) > 1_000
                    || proposal.content.trim().is_empty()
                    || utf16_len(&proposal.content) > 200_000
                {
                    return Err(error("output-invalid"));
                }
                converted.push(PluginRuntimeChangeProposal {
                    proposal_version: proposal.proposal_version,
                    proposal_id: proposal.proposal_id,
                    plugin_id: proposal.plugin_id,
                    project_id: proposal.project_id,
                    expected_revision: proposal.expected_revision,
                    summary: proposal.summary,
                    content: proposal.content,
                    operation: match proposal.operation {
                        ProposalOperation::Append => PluginProposalOperation::Append,
                        ProposalOperation::Replace => PluginProposalOperation::Replace,
                    },
                });
            }
            PluginRuntimeOutput::Proposals {
                proposals: converted,
            }
        }
    };
    let encoded = serde_json::to_vec(&output).map_err(|_| error("output-invalid"))?;
    if encoded.len() > MAX_ENVELOPE_BYTES {
        return Err(error("output-invalid"));
    }
    Ok(output)
}

fn execute_component(
    component_bytes: &[u8],
    invocation: &PluginRuntimeInvocation,
) -> Result<PluginRuntimeResult, String> {
    inspect_component(component_bytes)?;
    validate_invocation(invocation)?;

    let engine = runtime_engine()?;
    let component =
        Component::new(&engine, component_bytes).map_err(|_| error("component-invalid"))?;
    let linker = Linker::<RuntimeStore>::new(&engine);
    let mut store = runtime_store(&engine)?;
    let (bindings, _) = Plugin::instantiate(&mut store, &component, &linker)
        .map_err(|_| error("contract-mismatch"))?;

    let deadline_fired = Arc::new(AtomicBool::new(false));
    let deadline_flag = Arc::clone(&deadline_fired);
    let deadline_engine = engine.clone();
    let (cancel_deadline, deadline_cancelled) = mpsc::channel();
    let timer = thread::spawn(move || {
        if deadline_cancelled.recv_timeout(EXECUTION_DEADLINE).is_err() {
            deadline_flag.store(true, Ordering::SeqCst);
            deadline_engine.increment_epoch();
        }
    });

    let started = Instant::now();
    let called = bindings
        .syzygy_research_research_plugin()
        .call_run(&mut store, &wit_invocation(invocation));
    let _ = cancel_deadline.send(());
    let _ = timer.join();

    let guest_result = match called {
        Ok(result) => result,
        Err(_)
            if deadline_fired.load(Ordering::SeqCst) || started.elapsed() >= EXECUTION_DEADLINE =>
        {
            return Err(error("execution-deadline"));
        }
        Err(_) if store.get_fuel().is_ok_and(|remaining| remaining == 0) => {
            return Err(error("execution-fuel"));
        }
        Err(_) => return Err(error("execution-trapped")),
    };
    let guest_output = guest_result.map_err(|_| error("guest-rejected"))?;
    let output = host_output(invocation, guest_output)?;

    Ok(PluginRuntimeResult {
        runtime_version: 1,
        world: RESEARCH_PLUGIN_WIT_WORLD.to_string(),
        output,
        limits: PluginRuntimeLimitsReport {
            max_component_bytes: MAX_COMPONENT_BYTES,
            max_envelope_bytes: MAX_ENVELOPE_BYTES,
            max_linear_memory_bytes: MAX_LINEAR_MEMORY_BYTES,
            max_sources: MAX_SOURCES,
            max_proposals: MAX_PROPOSALS,
            execution_fuel: EXECUTION_FUEL,
            execution_deadline_ms: EXECUTION_DEADLINE.as_millis() as u64,
            ambient_imports_linked: false,
        },
    })
}

fn validate_worker_result(
    result: &PluginRuntimeResult,
    invocation: &PluginRuntimeInvocation,
) -> Result<(), String> {
    if result.runtime_version != 1
        || result.world != RESEARCH_PLUGIN_WIT_WORLD
        || result.limits.max_component_bytes != MAX_COMPONENT_BYTES
        || result.limits.max_envelope_bytes != MAX_ENVELOPE_BYTES
        || result.limits.max_linear_memory_bytes != MAX_LINEAR_MEMORY_BYTES
        || result.limits.max_sources != MAX_SOURCES
        || result.limits.max_proposals != MAX_PROPOSALS
        || result.limits.execution_fuel != EXECUTION_FUEL
        || result.limits.execution_deadline_ms != EXECUTION_DEADLINE.as_millis() as u64
        || result.limits.ambient_imports_linked
    {
        return Err(error("worker-response-invalid"));
    }
    let encoded =
        serde_json::to_vec(&result.output).map_err(|_| error("worker-response-invalid"))?;
    if encoded.len() > MAX_ENVELOPE_BYTES {
        return Err(error("worker-response-invalid"));
    }
    match &result.output {
        PluginRuntimeOutput::NoChange { reason } => {
            if reason.trim().is_empty() || utf16_len(reason) > 1_000 {
                return Err(error("worker-response-invalid"));
            }
        }
        PluginRuntimeOutput::Proposals { proposals } => {
            let Some(project) = &invocation.project else {
                return Err(error("worker-response-invalid"));
            };
            if proposals.is_empty() || proposals.len() > MAX_PROPOSALS {
                return Err(error("worker-response-invalid"));
            }
            let mut ids = HashSet::with_capacity(proposals.len());
            for proposal in proposals {
                if proposal.proposal_version != 1
                    || !valid_id(&proposal.proposal_id, 120)
                    || !ids.insert(proposal.proposal_id.as_str())
                    || proposal.plugin_id != invocation.plugin_id
                    || proposal.project_id != project.project_id
                    || proposal.expected_revision != project.revision
                    || proposal.summary.trim().is_empty()
                    || utf16_len(&proposal.summary) > 1_000
                    || proposal.content.trim().is_empty()
                    || utf16_len(&proposal.content) > 200_000
                {
                    return Err(error("worker-response-invalid"));
                }
            }
        }
    }
    Ok(())
}

fn worker_response(request: PluginWorkerRequest) -> PluginWorkerResponse {
    let result = (|| {
        if request.component_base64.len() > MAX_COMPONENT_BASE64_BYTES {
            return Err(error("component-size"));
        }
        let component = BASE64_STANDARD
            .decode(request.component_base64)
            .map_err(|_| error("component-invalid"))?;
        execute_component(&component, &request.invocation)
    })();
    match result {
        Ok(result) => PluginWorkerResponse {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(failure) => PluginWorkerResponse {
            ok: false,
            result: None,
            error: Some(failure),
        },
    }
}

/// Entry point for the packaged `--plugin-runtime-worker` subprocess. The worker accepts exactly
/// one bounded JSON request and emits one bounded JSON response before exiting.
pub fn run_worker() -> Result<(), String> {
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take((MAX_WORKER_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|_| error("worker-input"))?;
    let response = if input.len() > MAX_WORKER_REQUEST_BYTES {
        PluginWorkerResponse {
            ok: false,
            result: None,
            error: Some(error("worker-input")),
        }
    } else {
        match serde_json::from_slice::<PluginWorkerRequest>(&input) {
            Ok(request) => worker_response(request),
            Err(_) => PluginWorkerResponse {
                ok: false,
                result: None,
                error: Some(error("worker-input")),
            },
        }
    };
    let encoded = serde_json::to_vec(&response).map_err(|_| error("worker-output"))?;
    if encoded.len() > MAX_WORKER_RESPONSE_BYTES {
        return Err(error("worker-output"));
    }
    std::io::stdout()
        .lock()
        .write_all(&encoded)
        .map_err(|_| error("worker-output"))
}

#[doc(hidden)]
pub fn plugin_component_run_with_executable(
    executable: &Path,
    component_base64: String,
    invocation: PluginRuntimeInvocation,
) -> Result<PluginRuntimeResult, String> {
    if component_base64.len() > MAX_COMPONENT_BASE64_BYTES {
        return Err(error("component-size"));
    }
    validate_invocation(&invocation)?;
    let decoded = BASE64_STANDARD
        .decode(&component_base64)
        .map_err(|_| error("component-invalid"))?;
    inspect_component(&decoded)?;

    let request = serde_json::to_vec(&PluginWorkerRequest {
        component_base64,
        invocation: invocation.clone(),
    })
    .map_err(|_| error("worker-input"))?;
    if request.len() > MAX_WORKER_REQUEST_BYTES {
        return Err(error("worker-input"));
    }

    let mut command = Command::new(executable);
    command
        .arg("--plugin-runtime-worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| error("worker-unavailable"))?;
    let mut child_input = child
        .stdin
        .take()
        .ok_or_else(|| error("worker-unavailable"))?;
    let input_writer = thread::spawn(move || child_input.write_all(&request).is_ok());

    let child_output = child
        .stdout
        .take()
        .ok_or_else(|| error("worker-unavailable"))?;
    let output_reader = thread::spawn(move || {
        let mut output = Vec::new();
        child_output
            .take((MAX_WORKER_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut output)
            .map(|_| output)
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < WORKER_DEADLINE => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = input_writer.join();
                let _ = output_reader.join();
                return Err(error("worker-deadline"));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = input_writer.join();
                let _ = output_reader.join();
                return Err(error("worker-failed"));
            }
        }
    };
    let input_written = input_writer.join().map_err(|_| error("worker-failed"))?;
    let output = output_reader
        .join()
        .map_err(|_| error("worker-failed"))?
        .map_err(|_| error("worker-failed"))?;
    if !input_written || !status.success() {
        return Err(error("worker-failed"));
    }
    if output.len() > MAX_WORKER_RESPONSE_BYTES {
        return Err(error("worker-response-invalid"));
    }
    let response: PluginWorkerResponse =
        serde_json::from_slice(&output).map_err(|_| error("worker-response-invalid"))?;
    if response.ok {
        if response.error.is_some() {
            return Err(error("worker-response-invalid"));
        }
        let result = response
            .result
            .ok_or_else(|| error("worker-response-invalid"))?;
        validate_worker_result(&result, &invocation)?;
        Ok(result)
    } else {
        if response.result.is_some() {
            return Err(error("worker-response-invalid"));
        }
        let failure = response
            .error
            .ok_or_else(|| error("worker-response-invalid"))?;
        if failure.len() > 64 || !failure.starts_with("plugin-runtime:") {
            return Err(error("worker-response-invalid"));
        }
        Err(failure)
    }
}

#[tauri::command]
pub fn plugin_component_run(
    component_base64: String,
    invocation: PluginRuntimeInvocation,
) -> Result<PluginRuntimeResult, String> {
    let _execution = EXECUTION_LOCK
        .try_lock()
        .map_err(|_| error("runtime-busy"))?;
    let executable = std::env::current_exe().map_err(|_| error("worker-unavailable"))?;
    plugin_component_run_with_executable(&executable, component_base64, invocation)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invocation() -> PluginRuntimeInvocation {
        PluginRuntimeInvocation {
            invocation_version: 1,
            plugin_id: "org.example.citation-auditor".into(),
            contribution_id: "citation-coverage".into(),
            project: Some(PluginRuntimeProjectSnapshot {
                project_id: "project-1".into(),
                revision: "revision-7".into(),
                document_text: "Policy text".into(),
                sources: vec![PluginRuntimeSourceSnapshot {
                    snapshot_id: "source-1".into(),
                    label: "Source".into(),
                    content: "Evidence".into(),
                }],
            }),
        }
    }

    fn component_wat(run_body: &str, reason: &str) -> Vec<u8> {
        let reason_bytes = reason
            .as_bytes()
            .iter()
            .map(|byte| format!("\\{:02x}", byte))
            .collect::<String>();
        wat::parse_str(format!(
            r#"(component
              (core module $m
                (memory (export "memory") 2 512)
                (global $heap (mut i32) (i32.const 1024))
                (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32)
                  (local $ptr i32)
                  global.get $heap
                  local.get 2
                  i32.const 1
                  i32.sub
                  i32.add
                  i32.const 0
                  local.get 2
                  i32.sub
                  i32.and
                  local.tee $ptr
                  local.get 3
                  i32.add
                  global.set $heap
                  local.get $ptr)
                (data (i32.const 64) "{reason_bytes}")
                (func (export "run")
                  (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)
                  (result i32)
                  {run_body}
                  i32.const 0
                  i32.const 0
                  i32.store
                  i32.const 4
                  i32.const 0
                  i32.store
                  i32.const 8
                  i32.const 64
                  i32.store
                  i32.const 12
                  i32.const {reason_len}
                  i32.store
                  i32.const 0))
              (core instance $i (instantiate $m))
              (alias core export $i "memory" (core memory $memory))
              (alias core export $i "cabi_realloc" (core func $realloc))
              (alias core export $i "run" (core func $run))
              (type $source (record
                (field "snapshot-id" string)
                (field "label" string)
                (field "content" string)))
              (type $project (record
                (field "project-id" string)
                (field "revision" string)
                (field "document-text" string)
                (field "sources" (list $source))))
              (type $invocation (record
                (field "invocation-version" u32)
                (field "plugin-id" string)
                (field "contribution-id" string)
                (field "project" (option $project))))
              (type $operation (enum "append" "replace"))
              (type $proposal (record
                (field "proposal-version" u32)
                (field "proposal-id" string)
                (field "plugin-id" string)
                (field "project-id" string)
                (field "expected-revision" string)
                (field "summary" string)
                (field "content" string)
                (field "operation" $operation)))
              (type $output (variant
                (case "no-change" string)
                (case "proposals" (list $proposal))))
              (type $run-type (func
                (param "input" $invocation)
                (result (result $output (error string)))))
              (func $lifted-run (type $run-type)
                (canon lift (core func $run) (memory $memory) (realloc $realloc)))
              (instance $research-plugin
                (export "source-snapshot" (type $source))
                (export "project-snapshot" (type $project))
                (export "invocation" (type $invocation))
                (export "proposal-operation" (type $operation))
                (export "change-proposal" (type $proposal))
                (export "output" (type $output))
                (export "run" (func $lifted-run)))
              (export "syzygy:research/research-plugin@1.0.0"
                (instance $research-plugin)))"#,
            reason_len = reason.len(),
        ))
        .expect("test component WAT should compile")
    }

    #[test]
    fn executes_the_exact_zero_import_world() {
        let component = component_wat("", "No findings");
        let engine = runtime_engine().expect("test engine");
        Component::new(&engine, &component).expect("test component should validate");
        let result =
            execute_component(&component, &invocation()).expect("valid component should run");
        assert_eq!(result.world, RESEARCH_PLUGIN_WIT_WORLD);
        assert_eq!(
            result.output,
            PluginRuntimeOutput::NoChange {
                reason: "No findings".into()
            }
        );
        assert!(!result.limits.ambient_imports_linked);
    }

    #[test]
    fn executes_checked_in_citation_auditor_for_distinct_projects() {
        let component =
            include_bytes!("../../../examples/plugins/citation-auditor/citation-auditor.component");
        for (project_id, revision) in [
            ("project-alpha", "revision-11"),
            ("project-beta", "revision-29"),
        ] {
            let mut input = invocation();
            let project = input
                .project
                .as_mut()
                .expect("fixture has project authority");
            project.project_id = project_id.into();
            project.revision = revision.into();
            let result = execute_component(component, &input)
                .expect("checked-in citation auditor should execute");
            match result.output {
                PluginRuntimeOutput::Proposals { proposals } => {
                    assert_eq!(proposals.len(), 1);
                    let proposal = &proposals[0];
                    assert_eq!(proposal.plugin_id, input.plugin_id);
                    assert_eq!(proposal.project_id, project_id);
                    assert_eq!(proposal.expected_revision, revision);
                    assert_eq!(proposal.operation, PluginProposalOperation::Append);
                    assert!(proposal.content.contains("citation coverage"));
                }
                PluginRuntimeOutput::NoChange { .. } => {
                    panic!("checked-in citation auditor must return a review proposal")
                }
            }
            assert!(!result.limits.ambient_imports_linked);
        }
    }

    #[test]
    fn accepts_exact_revision_guarded_proposals_and_rejects_cross_target_output() {
        use research_plugin::{ChangeProposal, Output, ProposalOperation};
        let input = invocation();
        let proposal = ChangeProposal {
            proposal_version: 1,
            proposal_id: "proposal-1".into(),
            plugin_id: input.plugin_id.clone(),
            project_id: "project-1".into(),
            expected_revision: "revision-7".into(),
            summary: "Add a review note".into(),
            content: "Review the citation.".into(),
            operation: ProposalOperation::Append,
        };
        let accepted = host_output(&input, Output::Proposals(vec![proposal.clone()]))
            .expect("exact proposal should remain pending output");
        assert!(matches!(
            accepted,
            PluginRuntimeOutput::Proposals { proposals }
                if proposals.len() == 1
                    && proposals[0].operation == PluginProposalOperation::Append
        ));

        let mut cross_plugin = proposal.clone();
        cross_plugin.plugin_id = "org.example.attacker".into();
        assert_eq!(
            host_output(&input, Output::Proposals(vec![cross_plugin])),
            Err(error("output-invalid"))
        );

        let mut stale = proposal;
        stale.expected_revision = "revision-6".into();
        assert_eq!(
            host_output(&input, Output::Proposals(vec![stale])),
            Err(error("output-invalid"))
        );
    }

    #[test]
    fn rejects_every_top_level_ambient_import_before_linking() {
        for name in ["filesystem", "network", "environment", "clock", "random"] {
            let component = wat::parse_str(format!("(component (import \"{name}\" (func)))"))
                .expect("import fixture should compile");
            assert_eq!(inspect_component(&component), Err(error("imports-denied")));
        }
    }

    #[test]
    fn traps_and_invalid_output_are_sanitized() {
        let trapped = execute_component(
            &component_wat("unreachable", "secret guest text"),
            &invocation(),
        );
        assert_eq!(trapped, Err(error("execution-trapped")));
        assert!(!trapped.unwrap_err().contains("secret"));

        let invalid = execute_component(&component_wat("", ""), &invocation());
        assert_eq!(invalid, Err(error("output-invalid")));

        let memory_limit = execute_component(
            &component_wat(
                "i32.const 511 memory.grow i32.const -1 i32.eq if unreachable end",
                "unreachable",
            ),
            &invocation(),
        );
        assert_eq!(memory_limit, Err(error("execution-trapped")));
    }

    #[test]
    fn invocation_validation_rejects_oversize_duplicates_and_bad_identity() {
        let mut duplicate = invocation();
        duplicate
            .project
            .as_mut()
            .unwrap()
            .sources
            .push(PluginRuntimeSourceSnapshot {
                snapshot_id: "source-1".into(),
                label: "Duplicate".into(),
                content: "Other".into(),
            });
        assert_eq!(
            validate_invocation(&duplicate),
            Err(error("invocation-invalid"))
        );

        let mut bad_identity = invocation();
        bad_identity.plugin_id = "not_a_plugin".into();
        assert_eq!(
            validate_invocation(&bad_identity),
            Err(error("invocation-invalid"))
        );

        let mut oversized = invocation();
        oversized.project.as_mut().unwrap().document_text = "x".repeat(MAX_ENVELOPE_BYTES);
        assert_eq!(
            validate_invocation(&oversized),
            Err(error("invocation-invalid"))
        );
    }

    #[test]
    fn malformed_core_module_and_component_size_fail_closed() {
        assert_eq!(
            inspect_component(b"not wasm"),
            Err(error("component-invalid"))
        );
        let module = wat::parse_str("(module)").expect("module fixture should compile");
        assert_eq!(inspect_component(&module), Err(error("component-invalid")));
        assert_eq!(
            inspect_component(&vec![0; MAX_COMPONENT_BYTES + 1]),
            Err(error("component-size"))
        );
    }
}

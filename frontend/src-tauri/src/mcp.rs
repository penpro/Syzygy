//! Embedded stdio MCP server for semantically piloting a running Syzygy app.
//!
//! Launch the installed application binary with `--mcp`. The MCP process never opens project
//! storage itself; it calls the authenticated loopback bridge owned by the live GUI process.
//! This keeps one source of truth and lets the same tools work with future persistence providers.

use crate::automation::{descriptor_path, AutomationDescriptor, BridgeReply, BridgeRequest};
use crate::mcp_setup::{self, MCP_PROTOCOL_VERSION};
use crate::platform_contracts;
use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const SUPPORTED_PROTOCOL_VERSIONS: &[&str] =
    &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

type LiveCall<'a> = dyn Fn(&str, Value) -> Result<Value, String> + 'a;

pub fn run() -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    let reader = BufReader::new(stdin.lock());
    let live = |method: &str, params: Value| call_live(method, params);

    for line in reader.lines() {
        let line = line.map_err(|error| format!("Could not read MCP stdin: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(message) => dispatch_message(&message, &live),
            Err(error) => Some(jsonrpc_error(
                Value::Null,
                -32700,
                format!("Parse error: {error}"),
            )),
        };
        if let Some(response) = response {
            let encoded = serde_json::to_string(&response)
                .map_err(|error| format!("Could not encode MCP response: {error}"))?;
            stdout
                .write_all(encoded.as_bytes())
                .and_then(|_| stdout.write_all(b"\n"))
                .and_then(|_| stdout.flush())
                .map_err(|error| format!("Could not write MCP stdout: {error}"))?;
        }
    }
    Ok(())
}

fn dispatch_message(message: &Value, live: &LiveCall<'_>) -> Option<Value> {
    let Some(object) = message.as_object() else {
        return Some(jsonrpc_error(
            Value::Null,
            -32600,
            "Invalid JSON-RPC request",
        ));
    };
    let id = object.get("id").cloned();
    let method = object.get("method").and_then(Value::as_str);
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));

    let Some(method) = method else {
        return id.map(|id| jsonrpc_error(id, -32600, "JSON-RPC method is required"));
    };
    if id.is_none() {
        // MCP lifecycle/cancellation notifications require no response.
        return None;
    }
    let id = id.unwrap_or(Value::Null);

    let result = match method {
        "initialize" => {
            let requested = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(MCP_PROTOCOL_VERSION);
            let negotiated = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
                requested
            } else {
                MCP_PROTOCOL_VERSION
            };
            json!({
                "protocolVersion": negotiated,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": {
                    "name": "syzygy-live",
                    "title": "Syzygy Live Workspace",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "instructions": "Pilot the running Syzygy app semantically. Use syzygy_installation for exact local setup details. Start live work with syzygy_status, then workspace_walkthrough and list_projects. Use inspect_drive_project_discovery to compare the selected folder code and bounded remote project identities across installations; that explicit call performs a content-free Drive metadata read. Use list_shared_projects only when a user wants the visible Drive catalog. Share requires the exact revision from read_active_project; join requires an exact freshly cataloged project/document/workspace identity. Use inspect_research_state for bounded read-only integrity metadata about scenarios, aggregate voting, annotations, shared labels, heuristics, and immutable history. Read a project before editing, checkpointing, or restoring it. Document writes require the exact revision returned by read_active_project. Scenario, turn, vote, annotation, and label tools require the latest exact research revision from inspection or the prior mutation; annotation and label follow-up mutations additionally require their exact current event. save_active_policy_version requires the exact non-null head from inspection, or omission when no head exists. restore_active_policy_version requires the exact document revision, exact non-null head, and an inspected target version; it creates a new head instead of rewriting history. On any conflict, read again and reconcile. Never claim model generation or real-time collaborator presence is available."
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tool_definitions() }),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(jsonrpc_error(id, -32602, "tools/call requires a tool name"));
            };
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            return Some(jsonrpc_result(id, call_tool(name, arguments, live)));
        }
        _ => {
            return Some(jsonrpc_error(
                id,
                -32601,
                format!("Method not found: {method}"),
            ))
        }
    };
    Some(jsonrpc_result(id, result))
}

fn call_tool(name: &str, arguments: Value, live: &LiveCall<'_>) -> Value {
    let operation = match name {
        "syzygy_status" => live("app.inspect", json!({})),
        "list_projects" => live("project.list", json!({})),
        "inspect_drive_project_discovery" => live("drive.inspectProjectDiscovery", json!({})),
        "list_shared_projects" => live("drive.listSharedProjects", json!({})),
        "share_active_project" => live("project.shareDrive", arguments),
        "join_shared_project" => live("project.joinDrive", arguments),
        "workspace_walkthrough" => live("workspace.walkthrough", json!({})),
        "create_project" => live("project.create", arguments),
        "open_project" => live("project.open", arguments),
        "rename_project" => live("project.rename", arguments),
        "read_active_project" => live("project.readActive", json!({})),
        "inspect_research_state" => live("project.readResearchState", json!({})),
        "create_scenario" => live("project.createScenario", arguments),
        "add_scenario_turn" => live("project.addScenarioTurn", arguments),
        "revise_scenario_turn" => live("project.reviseScenarioTurn", arguments),
        "cast_scenario_vote" => live("project.castScenarioVote", arguments),
        "create_scenario_annotation" => live("project.createScenarioAnnotation", arguments),
        "update_scenario_annotation" => live("project.updateScenarioAnnotation", arguments),
        "set_scenario_annotation_resolution" => {
            live("project.setScenarioAnnotationResolution", arguments)
        }
        "create_scenario_label" => live("project.createScenarioLabel", arguments),
        "rename_scenario_label" => live("project.renameScenarioLabel", arguments),
        "set_scenario_label_assignment" => live("project.setScenarioLabelAssignment", arguments),
        "save_active_policy_version" => live("project.savePolicyVersion", arguments),
        "restore_active_policy_version" => live("project.restorePolicyVersion", arguments),
        "replace_active_document" => live("document.replace", arguments),
        "append_active_document" => live("document.append", arguments),
        "launch_syzygy" => launch_live_app(),
        "syzygy_installation" => mcp_setup::current().and_then(|info| {
            serde_json::to_value(info)
                .map_err(|error| format!("Could not encode Syzygy installation details: {error}"))
        }),
        "syzygy_platform_contracts" => platform_contracts::current(),
        _ => Err(format!("Unknown Syzygy tool: {name}")),
    };

    match operation {
        Ok(result) => tool_result(result, false),
        Err(error) => tool_result(json!({ "error": error }), true),
    }
}

fn tool_result(value: Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": value,
        "isError": is_error
    })
}

fn tool_definitions() -> Vec<Value> {
    vec![
        tool(
            "syzygy_status",
            "Inspect whether the live Syzygy window is ready, its version/view, active project, and honestly implemented versus unavailable workspace capabilities.",
            object_schema(&[], &[]),
        ),
        tool(
            "launch_syzygy",
            "Launch the Syzygy GUI from this installed executable when it is not already running, then wait until semantic automation is ready.",
            object_schema(&[], &[]),
        ),
        tool(
            "syzygy_installation",
            "Return the exact running Syzygy executable and install-folder paths, stdio arguments, copy-ready MCP configuration, protocol version, and recommended connection prompts. This does not require the GUI to be open.",
            object_schema(&[], &[]),
        ),
        tool(
            "syzygy_platform_contracts",
            "Return machine-readable provider, adversarial-review, and researcher-plugin contracts plus their honest implementation status and self-check commands. This does not require the GUI to be open.",
            object_schema(&[], &[]),
        ),
        tool(
            "workspace_walkthrough",
            "Inspect the live workspace and return a plain-language, state-aware walkthrough of what the current research project is for and what to do next. This tool does not mutate anything.",
            object_schema(&[], &[]),
        ),
        tool(
            "list_projects",
            "List live Syzygy research projects, including stable IDs, titles, archive state, transport, and which project is active.",
            object_schema(&[], &[]),
        ),
        tool(
            "inspect_drive_project_discovery",
            "Refresh the selected Drive workspace's shared-project manifests and return only its short folder code, project/document identities, count, truncation state, and check time. This explicit read returns no OAuth token, Drive file ID, project title, or document content.",
            object_schema(&[], &[]),
        ),
        tool(
            "list_shared_projects",
            "Explicitly browse bounded Syzygy-owned shared-project roots visible to the connected Google account. Returns titles and exact project/document/workspace identities so a user-requested Join can name one result; it grants no mutation by itself.",
            object_schema(&[], &[]),
        ),
        tool(
            "share_active_project",
            "Publish the exact active local project to its already selected Drive workspace, then bind it locally. Requires the exact document revision from read_active_project and fails closed if the draft changed.",
            object_schema(
                &[("expectedDocumentRevision", string_schema("Exact revision from read_active_project."))],
                &["expectedDocumentRevision"],
            ),
        ),
        tool(
            "join_shared_project",
            "Join one exact result from list_shared_projects. The live app refetches the catalog, selects the exact parent workspace, refuses identity collisions, and opens only after the Drive-backed document is ready.",
            object_schema(
                &[
                    ("projectId", string_schema("Exact project ID from list_shared_projects.")),
                    ("documentId", string_schema("Exact document ID from list_shared_projects.")),
                    ("workspaceId", string_schema("Exact workspace ID from list_shared_projects.")),
                ],
                &["projectId", "documentId", "workspaceId"],
            ),
        ),
        tool(
            "create_project",
            "Create and open a local research project in the live app. Use this only when the user asked to create or demonstrate a project.",
            object_schema(&[("title", string_schema("Human-readable project title."))], &["title"]),
        ),
        tool(
            "open_project",
            "Open an existing non-archived project in the live app by stable project ID.",
            object_schema(&[("projectId", string_schema("Stable project ID returned by list_projects."))], &["projectId"]),
        ),
        tool(
            "rename_project",
            "Rename an existing research project. This changes project metadata, not document content.",
            object_schema(
                &[
                    ("projectId", string_schema("Stable project ID returned by list_projects.")),
                    ("title", string_schema("New non-empty project title.")),
                ],
                &["projectId", "title"],
            ),
        ),
        tool(
            "read_active_project",
            "Read the active live project's manifest and collaborative document as structured blocks and plain text. Always call this before a document write and retain its revision.",
            object_schema(&[], &[]),
        ),
        tool(
            "inspect_research_state",
            "Inspect bounded read-only metadata and integrity checks for the active project's collaborative scenarios, aggregate votes, annotation lifecycle, context labels, heuristics, and immutable policy-version history. Omits policy text, scenario/annotation/voter bodies, label-event bodies, heuristic guidance/edit values, and version notes; grants no mutation authority.",
            object_schema(&[], &[]),
        ),
        tool(
            "create_scenario",
            "Create one scenario in the active live project against the exact research revision from inspect_research_state. This creates scenario metadata/background only; it does not generate model turns or imply a visible gallery.",
            object_schema(
                &[
                    ("expectedResearchRevision", string_schema("Exact researchState.revision from inspect_research_state.")),
                    ("scenarioId", string_schema("New stable scenario ID.")),
                    ("title", string_schema("Non-empty scenario title.")),
                    ("background", string_schema("Scenario background; may be empty.")),
                    ("status", string_schema("Optional draft, ready, or archived lifecycle state.")),
                    ("parentScenarioId", string_schema("Optional existing parent scenario ID for a branch.")),
                    ("participantId", string_schema("Caller-supplied participant ID; identity is not authenticated across installs.")),
                ],
                &["expectedResearchRevision", "scenarioId", "title", "background", "participantId"],
            ),
        ),
        tool(
            "add_scenario_turn",
            "Append one user, assistant, or system turn to an existing scenario against the exact current research revision. This stores caller-supplied content; it does not invoke a model.",
            scenario_turn_schema(),
        ),
        tool(
            "revise_scenario_turn",
            "Append an attributed immutable revision to an existing scenario turn against the exact current research revision. Prior turn revisions remain available in domain history.",
            scenario_turn_schema(),
        ),
        tool(
            "cast_scenario_vote",
            "Cast, revise, abstain, or withdraw one caller-identified participant vote on an existing scenario against the exact current research revision. Immutable vote history is retained, but participant identity is not authenticated across installs.",
            object_schema(
                &[
                    ("expectedResearchRevision", string_schema("Exact research revision from inspect_research_state or the prior scenario mutation.")),
                    ("scenarioId", string_schema("Existing stable scenario ID.")),
                    ("participantId", string_schema("Caller-supplied participant ID; one current vote is projected per ID, but identity is not authenticated.")),
                    ("displayName", string_schema("Display name to retain with this vote event.")),
                    ("choice", string_schema("Vote choice: support, oppose, abstain, or withdrawn.")),
                ],
                &["expectedResearchRevision", "scenarioId", "participantId", "displayName", "choice"],
            ),
        ),
        tool(
            "create_scenario_annotation",
            "Create one flag or note on an existing scenario or turn against the exact current research revision. The body is stored in collaborative history but omitted from bounded inspection and the tool response.",
            object_schema(
                &[
                    ("expectedResearchRevision", string_schema("Exact research revision from inspect_research_state or the prior scenario mutation.")),
                    ("annotationId", string_schema("New stable annotation ID.")),
                    ("scenarioId", string_schema("Existing stable scenario ID.")),
                    ("turnId", string_schema("Optional existing turn ID; omit for a scenario-level annotation.")),
                    ("kind", string_schema("Annotation kind: flag or note.")),
                    ("body", string_schema("Non-empty flag/note body, retained in collaborative history but omitted from MCP readback.")),
                    ("participantId", string_schema("Caller-supplied participant ID; identity is not authenticated across installs.")),
                    ("displayName", string_schema("Display name retained with the lifecycle event but omitted from this tool response.")),
                ],
                &["expectedResearchRevision", "annotationId", "scenarioId", "kind", "body", "participantId", "displayName"],
            ),
        ),
        tool(
            "update_scenario_annotation",
            "Append an attributed body revision to an open flag or note. Requires both the exact current research revision and annotation event; prior bodies remain in immutable lifecycle history and are omitted from MCP readback.",
            object_schema(
                &[
                    ("expectedResearchRevision", string_schema("Exact research revision from inspection or the prior mutation.")),
                    ("annotationId", string_schema("Existing stable annotation ID.")),
                    ("scenarioId", string_schema("Owning stable scenario ID.")),
                    ("expectedCurrentEventId", string_schema("Exact currentEventId returned by the prior annotation mutation or bounded inspection.")),
                    ("body", string_schema("New non-empty body; retained in history but omitted from MCP readback.")),
                    ("participantId", string_schema("Caller-supplied participant ID; identity is not authenticated across installs.")),
                    ("displayName", string_schema("Display name retained with the lifecycle event but omitted from this tool response.")),
                ],
                &["expectedResearchRevision", "annotationId", "scenarioId", "expectedCurrentEventId", "body", "participantId", "displayName"],
            ),
        ),
        tool(
            "set_scenario_annotation_resolution",
            "Resolve or reopen one flag/note by appending an attributed lifecycle event. Requires both the exact current research revision and current annotation event.",
            object_schema(
                &[
                    ("expectedResearchRevision", string_schema("Exact research revision from inspection or the prior mutation.")),
                    ("annotationId", string_schema("Existing stable annotation ID.")),
                    ("scenarioId", string_schema("Owning stable scenario ID.")),
                    ("expectedCurrentEventId", string_schema("Exact currentEventId returned by the prior annotation mutation or bounded inspection.")),
                    ("resolved", json!({ "type": "boolean", "description": "True to resolve; false to reopen." })),
                    ("participantId", string_schema("Caller-supplied participant ID; identity is not authenticated across installs.")),
                    ("displayName", string_schema("Display name retained with the lifecycle event but omitted from this tool response.")),
                ],
                &["expectedResearchRevision", "annotationId", "scenarioId", "expectedCurrentEventId", "resolved", "participantId", "displayName"],
            ),
        ),
        tool(
            "create_scenario_label",
            "Create one shared context label against the exact current research revision. Label event history is retained but omitted from bounded inspection and this tool response.",
            object_schema(
                &[
                    ("expectedResearchRevision", string_schema("Exact research revision from inspection or the prior mutation.")),
                    ("labelId", string_schema("New stable label ID.")),
                    ("name", string_schema("Non-empty human-readable label name.")),
                    ("participantId", string_schema("Caller-supplied participant ID; identity is not authenticated across installs.")),
                ],
                &["expectedResearchRevision", "labelId", "name", "participantId"],
            ),
        ),
        tool(
            "rename_scenario_label",
            "Rename one shared context label by appending an attributed immutable event. Requires the exact current research revision and label event.",
            object_schema(
                &[
                    ("expectedResearchRevision", string_schema("Exact research revision from inspection or the prior mutation.")),
                    ("labelId", string_schema("Existing stable label ID.")),
                    ("expectedCurrentEventId", string_schema("Exact label currentEventId from inspection or the prior label mutation.")),
                    ("name", string_schema("New non-empty human-readable label name.")),
                    ("participantId", string_schema("Caller-supplied participant ID; identity is not authenticated across installs.")),
                ],
                &["expectedResearchRevision", "labelId", "expectedCurrentEventId", "name", "participantId"],
            ),
        ),
        tool(
            "set_scenario_label_assignment",
            "Assign or remove one shared label on a scenario by appending an attributed immutable event. Requires the exact research revision; omit expectedCurrentEventId only for the first assignment event, then provide the exact assignment current event.",
            object_schema(
                &[
                    ("expectedResearchRevision", string_schema("Exact research revision from inspection or the prior mutation.")),
                    ("scenarioId", string_schema("Existing stable scenario ID.")),
                    ("labelId", string_schema("Existing stable label ID.")),
                    ("expectedCurrentEventId", string_schema("Exact assignment currentEventId from the prior mutation; omit only when this scenario-label pair has no event yet.")),
                    ("assigned", json!({ "type": "boolean", "description": "True to assign; false to remove." })),
                    ("participantId", string_schema("Caller-supplied participant ID; identity is not authenticated across installs.")),
                ],
                &["expectedResearchRevision", "scenarioId", "labelId", "assigned", "participantId"],
            ),
        ),
        tool(
            "save_active_policy_version",
            "Save the exact active document revision as a new immutable, attributed policy-version head. Requires expectedDocumentRevision from read_active_project and, when one exists, expectedHeadVersionId from inspect_research_state. This does not edit document text or restore history.",
            object_schema(
                &[
                    ("expectedDocumentRevision", string_schema("Exact revision from the latest read_active_project result.")),
                    ("expectedHeadVersionId", string_schema("Exact non-null head from inspect_research_state. Omit only when the head is null.")),
                    ("participantId", string_schema("Stable caller-supplied participant ID; identity is not yet authenticated across installs.")),
                    ("displayName", string_schema("Display name to freeze into this historical attribution record.")),
                    ("note", string_schema("Optional human-visible checkpoint note.")),
                ],
                &["expectedDocumentRevision", "participantId", "displayName"],
            ),
        ),
        tool(
            "restore_active_policy_version",
            "Restore an inspected immutable policy version into the active draft and append the restored state as a new attributed head. Requires the exact current document revision and exact current non-null version head. This never rewrites or deletes history.",
            object_schema(
                &[
                    ("targetVersionId", string_schema("Exact immutable version ID from inspect_research_state.")),
                    ("expectedDocumentRevision", string_schema("Exact revision from the latest read_active_project result.")),
                    ("expectedHeadVersionId", string_schema("Exact non-null current head from inspect_research_state.")),
                    ("participantId", string_schema("Stable caller-supplied participant ID; identity is not yet authenticated across installs.")),
                    ("displayName", string_schema("Display name to freeze into this historical attribution record.")),
                    ("note", string_schema("Optional human-visible restore note.")),
                ],
                &[
                    "targetVersionId", "expectedDocumentRevision", "expectedHeadVersionId",
                    "participantId", "displayName",
                ],
            ),
        ),
        tool(
            "replace_active_document",
            "Replace the active project's document from deterministic semantic text (# heading, ## heading, > quote, [policy:stable-id:draft|review|approved] statement, other lines as paragraphs). Requires the exact expectedRevision from read_active_project so concurrent changes cannot be overwritten blindly.",
            object_schema(
                &[
                    ("expectedRevision", string_schema("Exact revision from the latest read_active_project result.")),
                    ("content", string_schema("Complete replacement document, at most 200,000 characters.")),
                ],
                &["expectedRevision", "content"],
            ),
        ),
        tool(
            "append_active_document",
            "Append deterministic semantic blocks to the active project, including [policy:stable-id:draft|review|approved] statement. Requires the exact expectedRevision from read_active_project; read again if another collaborator changed the draft.",
            object_schema(
                &[
                    ("expectedRevision", string_schema("Exact revision from the latest read_active_project result.")),
                    ("content", string_schema("Blocks to append, at most 200,000 characters.")),
                ],
                &["expectedRevision", "content"],
            ),
        ),
    ]
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "title": name.replace('_', " "),
        "description": description,
        "inputSchema": input_schema
    })
}

fn scenario_turn_schema() -> Value {
    object_schema(
        &[
            ("expectedResearchRevision", string_schema("Exact research revision from inspect_research_state or the prior scenario mutation.")),
            ("scenarioId", string_schema("Existing stable scenario ID.")),
            ("turnId", string_schema("Stable turn ID; new for add, existing for revise.")),
            ("role", string_schema("Turn role: system, user, or assistant.")),
            ("content", string_schema("Turn content; may be empty and is never model-generated by this tool.")),
            ("participantId", string_schema("Caller-supplied participant ID; identity is not authenticated across installs.")),
        ],
        &["expectedResearchRevision", "scenarioId", "turnId", "role", "content", "participantId"],
    )
}

fn string_schema(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn object_schema(properties: &[(&str, Value)], required: &[&str]) -> Value {
    let mut map = Map::new();
    for (name, schema) in properties {
        map.insert((*name).to_string(), schema.clone());
    }
    json!({
        "type": "object",
        "properties": map,
        "required": required,
        "additionalProperties": false
    })
}

fn call_live(method: &str, params: Value) -> Result<Value, String> {
    let descriptor: AutomationDescriptor =
        serde_json::from_slice(&std::fs::read(descriptor_path()).map_err(|_| {
            "The Syzygy GUI is not running. Call launch_syzygy or open the app, then retry."
                .to_string()
        })?)
        .map_err(|error| format!("The Syzygy automation descriptor is invalid: {error}"))?;
    if descriptor.schema_version != 1 {
        return Err(format!(
            "Unsupported Syzygy automation bridge schema {}",
            descriptor.schema_version
        ));
    }

    let id = format!(
        "mcp-{}-{}",
        std::process::id(),
        REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let request = BridgeRequest {
        id,
        method: method.to_string(),
        params,
    };
    let body = serde_json::to_vec(&request)
        .map_err(|error| format!("Could not encode live Syzygy request: {error}"))?;
    let mut stream = TcpStream::connect_timeout(
        &([127, 0, 0, 1], descriptor.port).into(),
        Duration::from_secs(2),
    )
    .map_err(|_| {
        "The Syzygy GUI is not reachable. Call launch_syzygy or reopen the app, then retry."
            .to_string()
    })?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    write!(
        stream,
        "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        descriptor.port,
        descriptor.token,
        body.len()
    )
    .and_then(|_| stream.write_all(&body))
    .and_then(|_| stream.flush())
    .map_err(|error| format!("Could not send live Syzygy request: {error}"))?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("Could not read live Syzygy response: {error}"))?;
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Live Syzygy returned an invalid HTTP response".to_string())?;
    let reply: BridgeReply = serde_json::from_slice(&response[separator + 4..])
        .map_err(|error| format!("Live Syzygy returned invalid JSON: {error}"))?;
    if reply.ok {
        Ok(reply.result.unwrap_or(Value::Null))
    } else {
        Err(reply
            .error
            .unwrap_or_else(|| "Live Syzygy automation failed".to_string()))
    }
}

fn launch_live_app() -> Result<Value, String> {
    if let Ok(status) = call_live("app.inspect", json!({})) {
        return Ok(json!({ "launched": false, "alreadyRunning": true, "status": status }));
    }
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not locate the Syzygy executable: {error}"))?;
    Command::new(executable)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not launch Syzygy: {error}"))?;

    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(300));
        if let Ok(status) = call_live("app.inspect", json!({})) {
            return Ok(json!({ "launched": true, "alreadyRunning": false, "status": status }));
        }
    }
    Err(
        "Syzygy launched but its live automation surface did not become ready in 20 seconds"
            .to_string(),
    )
}

fn jsonrpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn jsonrpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_live(method: &str, params: Value) -> Result<Value, String> {
        Ok(json!({ "method": method, "params": params }))
    }

    #[test]
    fn negotiates_current_protocol_and_advertises_tools() {
        let initialize = dispatch_message(
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": MCP_PROTOCOL_VERSION }
            }),
            &fake_live,
        )
        .unwrap();
        assert_eq!(
            initialize["result"]["protocolVersion"],
            MCP_PROTOCOL_VERSION
        );
        assert_eq!(initialize["result"]["serverInfo"]["name"], "syzygy-live");

        let tools = dispatch_message(
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            &fake_live,
        )
        .unwrap();
        let names: Vec<&str> = tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert!(names.contains(&"workspace_walkthrough"));
        assert!(names.contains(&"syzygy_installation"));
        assert!(names.contains(&"syzygy_platform_contracts"));
        assert!(names.contains(&"read_active_project"));
        assert!(names.contains(&"inspect_research_state"));
        assert!(names.contains(&"inspect_drive_project_discovery"));
        assert!(names.contains(&"list_shared_projects"));
        assert!(names.contains(&"share_active_project"));
        assert!(names.contains(&"join_shared_project"));
        assert!(names.contains(&"create_scenario"));
        assert!(names.contains(&"add_scenario_turn"));
        assert!(names.contains(&"revise_scenario_turn"));
        assert!(names.contains(&"cast_scenario_vote"));
        assert!(names.contains(&"create_scenario_annotation"));
        assert!(names.contains(&"update_scenario_annotation"));
        assert!(names.contains(&"set_scenario_annotation_resolution"));
        assert!(names.contains(&"create_scenario_label"));
        assert!(names.contains(&"rename_scenario_label"));
        assert!(names.contains(&"set_scenario_label_assignment"));
        assert!(names.contains(&"save_active_policy_version"));
        assert!(names.contains(&"restore_active_policy_version"));
        assert!(names.contains(&"replace_active_document"));
    }

    #[test]
    fn routes_tool_calls_to_semantic_live_methods() {
        let response = dispatch_message(
            &json!({
                "jsonrpc": "2.0",
                "id": "tool-1",
                "method": "tools/call",
                "params": {
                    "name": "open_project",
                    "arguments": { "projectId": "project-123" }
                }
            }),
            &fake_live,
        )
        .unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["method"],
            "project.open"
        );
        assert_eq!(
            response["result"]["structuredContent"]["params"]["projectId"],
            "project-123"
        );
        assert_eq!(response["result"]["isError"], false);
    }

    #[test]
    fn routes_drive_project_discovery_read_only() {
        let response = dispatch_message(
            &json!({
                "jsonrpc": "2.0",
                "id": "drive-discovery-1",
                "method": "tools/call",
                "params": { "name": "inspect_drive_project_discovery", "arguments": {} }
            }),
            &fake_live,
        )
        .unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["method"],
            "drive.inspectProjectDiscovery"
        );
        assert_eq!(response["result"]["structuredContent"]["params"], json!({}));
    }

    #[test]
    fn routes_drive_catalog_share_and_join() {
        for (tool_name, method) in [
            ("list_shared_projects", "drive.listSharedProjects"),
            ("share_active_project", "project.shareDrive"),
            ("join_shared_project", "project.joinDrive"),
        ] {
            let arguments = json!({
                "expectedDocumentRevision": "revision-1",
                "projectId": "project-1",
                "documentId": "document-1",
                "workspaceId": "workspace-1"
            });
            let response = dispatch_message(
                &json!({
                    "jsonrpc": "2.0",
                    "id": tool_name,
                    "method": "tools/call",
                    "params": { "name": tool_name, "arguments": arguments }
                }),
                &fake_live,
            )
            .unwrap();
            assert_eq!(response["result"]["structuredContent"]["method"], method);
            if tool_name == "list_shared_projects" {
                assert_eq!(response["result"]["structuredContent"]["params"], json!({}));
            } else {
                assert_eq!(response["result"]["structuredContent"]["params"], arguments);
            }
        }
    }

    #[test]
    fn routes_research_state_inspection_read_only() {
        let response = dispatch_message(
            &json!({
                "jsonrpc": "2.0",
                "id": "inspect-1",
                "method": "tools/call",
                "params": { "name": "inspect_research_state", "arguments": {} }
            }),
            &fake_live,
        )
        .unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["method"],
            "project.readResearchState"
        );
        assert_eq!(response["result"]["structuredContent"]["params"], json!({}));
    }

    #[test]
    fn routes_scenario_creation_with_research_revision_guard() {
        let response = dispatch_message(
            &json!({
                "jsonrpc": "2.0",
                "id": "scenario-1",
                "method": "tools/call",
                "params": {
                    "name": "create_scenario",
                    "arguments": {
                        "expectedResearchRevision": "1.2.3",
                        "scenarioId": "test-scenario",
                        "title": "Test scenario",
                        "background": "",
                        "participantId": "researcher-1"
                    }
                }
            }),
            &fake_live,
        )
        .unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["method"],
            "project.createScenario"
        );
        assert_eq!(
            response["result"]["structuredContent"]["params"]["expectedResearchRevision"],
            "1.2.3"
        );
    }

    #[test]
    fn routes_scenario_turn_add_and_revision_with_research_guards() {
        for (name, method) in [
            ("add_scenario_turn", "project.addScenarioTurn"),
            ("revise_scenario_turn", "project.reviseScenarioTurn"),
        ] {
            let response = dispatch_message(
                &json!({
                    "jsonrpc": "2.0",
                    "id": name,
                    "method": "tools/call",
                    "params": {
                        "name": name,
                        "arguments": {
                            "expectedResearchRevision": "4.5.6",
                            "scenarioId": "test-scenario",
                            "turnId": "answer-turn",
                            "role": "assistant",
                            "content": "Answer",
                            "participantId": "researcher-1"
                        }
                    }
                }),
                &fake_live,
            )
            .unwrap();
            assert_eq!(response["result"]["structuredContent"]["method"], method);
            assert_eq!(
                response["result"]["structuredContent"]["params"]["expectedResearchRevision"],
                "4.5.6"
            );
        }
    }

    #[test]
    fn routes_scenario_vote_with_research_revision_guard() {
        let response = dispatch_message(
            &json!({
                "jsonrpc": "2.0",
                "id": "vote-1",
                "method": "tools/call",
                "params": {
                    "name": "cast_scenario_vote",
                    "arguments": {
                        "expectedResearchRevision": "7.8.9",
                        "scenarioId": "test-scenario",
                        "participantId": "researcher-1",
                        "displayName": "Researcher One",
                        "choice": "support"
                    }
                }
            }),
            &fake_live,
        )
        .unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["method"],
            "project.castScenarioVote"
        );
        assert_eq!(
            response["result"]["structuredContent"]["params"]["expectedResearchRevision"],
            "7.8.9"
        );
    }

    #[test]
    fn routes_scenario_annotation_lifecycle_with_both_revision_guards() {
        for (name, method) in [
            (
                "create_scenario_annotation",
                "project.createScenarioAnnotation",
            ),
            (
                "update_scenario_annotation",
                "project.updateScenarioAnnotation",
            ),
            (
                "set_scenario_annotation_resolution",
                "project.setScenarioAnnotationResolution",
            ),
        ] {
            let response = dispatch_message(
                &json!({
                    "jsonrpc": "2.0",
                    "id": name,
                    "method": "tools/call",
                    "params": {
                        "name": name,
                        "arguments": {
                            "expectedResearchRevision": "10.11.12",
                            "scenarioId": "test-scenario",
                            "annotationId": "test-note",
                            "expectedCurrentEventId": "current-event"
                        }
                    }
                }),
                &fake_live,
            )
            .unwrap();
            assert_eq!(response["result"]["structuredContent"]["method"], method);
            assert_eq!(
                response["result"]["structuredContent"]["params"]["expectedResearchRevision"],
                "10.11.12"
            );
        }
    }

    #[test]
    fn routes_scenario_label_lifecycle_with_research_and_event_guards() {
        for (name, method) in [
            ("create_scenario_label", "project.createScenarioLabel"),
            ("rename_scenario_label", "project.renameScenarioLabel"),
            (
                "set_scenario_label_assignment",
                "project.setScenarioLabelAssignment",
            ),
        ] {
            let response = dispatch_message(
                &json!({
                    "jsonrpc": "2.0",
                    "id": name,
                    "method": "tools/call",
                    "params": {
                        "name": name,
                        "arguments": {
                            "expectedResearchRevision": "13.14.15",
                            "scenarioId": "test-scenario",
                            "labelId": "legal-risk",
                            "expectedCurrentEventId": "current-event"
                        }
                    }
                }),
                &fake_live,
            )
            .unwrap();
            assert_eq!(response["result"]["structuredContent"]["method"], method);
            assert_eq!(
                response["result"]["structuredContent"]["params"]["expectedResearchRevision"],
                "13.14.15"
            );
        }
    }

    #[test]
    fn routes_policy_version_save_with_both_revision_guards() {
        let response = dispatch_message(
            &json!({
                "jsonrpc": "2.0",
                "id": "save-version-1",
                "method": "tools/call",
                "params": {
                    "name": "save_active_policy_version",
                    "arguments": {
                        "expectedDocumentRevision": "lexical-1",
                        "expectedHeadVersionId": "a".repeat(64),
                        "participantId": "participant-1",
                        "displayName": "Researcher One"
                    }
                }
            }),
            &fake_live,
        )
        .unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["method"],
            "project.savePolicyVersion"
        );
        assert_eq!(
            response["result"]["structuredContent"]["params"]["expectedDocumentRevision"],
            "lexical-1"
        );
    }

    #[test]
    fn routes_policy_version_restore_with_document_head_and_target_guards() {
        let response = dispatch_message(
            &json!({
                "jsonrpc": "2.0",
                "id": "restore-version-1",
                "method": "tools/call",
                "params": {
                    "name": "restore_active_policy_version",
                    "arguments": {
                        "targetVersionId": "a".repeat(64),
                        "expectedDocumentRevision": "lexical-2",
                        "expectedHeadVersionId": "b".repeat(64),
                        "participantId": "participant-1",
                        "displayName": "Researcher One"
                    }
                }
            }),
            &fake_live,
        )
        .unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["method"],
            "project.restorePolicyVersion"
        );
        assert_eq!(
            response["result"]["structuredContent"]["params"]["targetVersionId"],
            "a".repeat(64)
        );
        assert_eq!(
            response["result"]["structuredContent"]["params"]["expectedHeadVersionId"],
            "b".repeat(64)
        );
        assert_eq!(
            response["result"]["structuredContent"]["params"]["expectedDocumentRevision"],
            "lexical-2"
        );
    }

    #[test]
    fn ignores_initialized_notification() {
        assert!(dispatch_message(
            &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            &fake_live,
        )
        .is_none());
    }

    #[test]
    fn exposes_platform_contracts_without_a_live_gui() {
        let response = dispatch_message(
            &json!({
                "jsonrpc": "2.0",
                "id": "contracts-1",
                "method": "tools/call",
                "params": { "name": "syzygy_platform_contracts", "arguments": {} }
            }),
            &fake_live,
        )
        .unwrap();
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(
            response["result"]["structuredContent"]["contractVersion"],
            1
        );
        assert_eq!(
            response["result"]["structuredContent"]["implementationStatus"]["pluginLoader"],
            "contract-only"
        );
    }
}

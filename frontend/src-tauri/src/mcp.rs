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
                "instructions": "Pilot the running Syzygy app semantically. Use syzygy_installation for exact local setup details. Start live work with syzygy_status, then workspace_walkthrough and list_projects. Read a project before editing it. Document writes require the exact revision returned by read_active_project; if a revision conflict occurs, read again and reconcile. Never claim disabled capabilities (snapshots, scenarios, Drive project transport, or real-time presence) are available."
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
        "workspace_walkthrough" => live("workspace.walkthrough", json!({})),
        "create_project" => live("project.create", arguments),
        "open_project" => live("project.open", arguments),
        "rename_project" => live("project.rename", arguments),
        "read_active_project" => live("project.readActive", json!({})),
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

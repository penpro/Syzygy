//! Authenticated loopback bridge between a local MCP process and the live Syzygy webview.
//!
//! The frontend owns project navigation and collaborative editor state, so automation requests
//! must be handled there rather than against a second filesystem representation. The bridge
//! binds to an ephemeral loopback port, writes a per-process bearer token to a user-local
//! descriptor, emits semantic requests to the main webview, and waits for a typed response.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub const AUTOMATION_EVENT: &str = "syzygy://automation/request";
const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_BODY_BYTES: usize = 512 * 1024;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct AutomationState {
    ready: AtomicBool,
    pending: Mutex<HashMap<String, mpsc::SyncSender<BridgeReply>>>,
    descriptor_path: Mutex<Option<PathBuf>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequest {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeReply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDescriptor {
    pub schema_version: u8,
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub app_version: String,
}

pub fn descriptor_path() -> PathBuf {
    std::env::var_os("SYZYGY_AUTOMATION_DESCRIPTOR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("syzygy-automation-v1.json"))
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("token generation failed: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn write_descriptor(path: &PathBuf, descriptor: &AutomationDescriptor) -> Result<(), String> {
    let encoded = serde_json::to_vec(descriptor)
        .map_err(|error| format!("automation descriptor encoding failed: {error}"))?;
    fs::write(path, encoded)
        .map_err(|error| format!("automation descriptor write failed: {error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("automation descriptor permission update failed: {error}"))?;
    }
    Ok(())
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("automation loopback bind failed: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("automation loopback address failed: {error}"))?
        .port();
    let token = random_token()?;
    let path = descriptor_path();
    let descriptor = AutomationDescriptor {
        schema_version: 1,
        port,
        token: token.clone(),
        pid: std::process::id(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    write_descriptor(&path, &descriptor)?;
    *app.state::<AutomationState>()
        .descriptor_path
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(path);

    let handle = app.clone();
    std::thread::Builder::new()
        .name("syzygy-automation".to_string())
        .spawn(move || {
            for connection in listener.incoming() {
                let Ok(stream) = connection else { continue };
                let connection_handle = handle.clone();
                let connection_token = token.clone();
                let _ = std::thread::Builder::new()
                    .name("syzygy-automation-request".to_string())
                    .spawn(move || handle_connection(stream, connection_handle, connection_token));
            }
        })
        .map_err(|error| format!("automation listener start failed: {error}"))?;
    Ok(())
}

pub fn cleanup(app: &AppHandle) {
    let state = app.state::<AutomationState>();
    state.ready.store(false, Ordering::Release);
    let path = state
        .descriptor_path
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

#[tauri::command]
pub fn automation_ready(state: State<'_, AutomationState>) {
    state.ready.store(true, Ordering::Release);
}

#[tauri::command]
pub fn automation_respond(
    state: State<'_, AutomationState>,
    id: String,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let sender = state
        .pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&id)
        .ok_or_else(|| "Automation request is no longer pending".to_string())?;
    sender
        .send(BridgeReply { ok, result, error })
        .map_err(|_| "Automation requester disconnected".to_string())
}

fn handle_connection(mut stream: TcpStream, app: AppHandle, token: String) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    match read_http_request(&mut stream, &token) {
        Ok(request) => {
            let state = app.state::<AutomationState>();
            if !state.ready.load(Ordering::Acquire) {
                write_json_response(
                    &mut stream,
                    503,
                    &BridgeReply {
                        ok: false,
                        result: None,
                        error: Some("Syzygy is still opening; retry shortly".to_string()),
                    },
                );
                return;
            }

            let (sender, receiver) = mpsc::sync_channel(1);
            state
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(request.id.clone(), sender);

            if let Err(error) = app.emit_to("main", AUTOMATION_EVENT, &request) {
                state
                    .pending
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&request.id);
                write_json_response(
                    &mut stream,
                    500,
                    &BridgeReply {
                        ok: false,
                        result: None,
                        error: Some(format!("Could not reach the Syzygy window: {error}")),
                    },
                );
                return;
            }

            match receiver.recv_timeout(RESPONSE_TIMEOUT) {
                Ok(reply) => write_json_response(&mut stream, 200, &reply),
                Err(_) => {
                    state
                        .pending
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&request.id);
                    write_json_response(
                        &mut stream,
                        504,
                        &BridgeReply {
                            ok: false,
                            result: None,
                            error: Some(
                                "The live Syzygy window did not answer in time".to_string(),
                            ),
                        },
                    );
                }
            }
        }
        Err((status, message)) => write_json_response(
            &mut stream,
            status,
            &BridgeReply {
                ok: false,
                result: None,
                error: Some(message),
            },
        ),
    }
}

fn read_http_request(
    stream: &mut TcpStream,
    expected_token: &str,
) -> Result<BridgeRequest, (u16, String)> {
    let mut buffer = Vec::with_capacity(4096);
    let header_end = loop {
        if buffer.len() >= MAX_HEADER_BYTES {
            return Err((431, "Automation request headers are too large".to_string()));
        }
        let mut chunk = [0_u8; 4096];
        let read = stream
            .read(&mut chunk)
            .map_err(|error| (400, format!("Could not read automation request: {error}")))?;
        if read == 0 {
            return Err((
                400,
                "Automation request ended before its headers".to_string(),
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
    };

    let headers = std::str::from_utf8(&buffer[..header_end])
        .map_err(|_| (400, "Automation request headers are not UTF-8".to_string()))?;
    let mut lines = headers.split("\r\n");
    if lines.next() != Some("POST /rpc HTTP/1.1") {
        return Err((404, "Only POST /rpc is supported".to_string()));
    }

    let mut content_length = None;
    let mut authorization = None;
    let mut has_origin = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => content_length = value.trim().parse::<usize>().ok(),
            "authorization" => authorization = Some(value.trim().to_string()),
            "origin" => has_origin = true,
            _ => {}
        }
    }
    if has_origin {
        return Err((
            403,
            "Browser-origin automation requests are not accepted".to_string(),
        ));
    }
    if authorization.as_deref() != Some(&format!("Bearer {expected_token}")) {
        return Err((401, "Invalid automation bearer token".to_string()));
    }
    let content_length = content_length
        .ok_or_else(|| (411, "Automation request needs Content-Length".to_string()))?;
    if content_length > MAX_BODY_BYTES {
        return Err((413, "Automation request body is too large".to_string()));
    }

    while buffer.len() - header_end < content_length {
        let mut chunk = [0_u8; 4096];
        let read = stream
            .read(&mut chunk)
            .map_err(|error| (400, format!("Could not read automation body: {error}")))?;
        if read == 0 {
            return Err((400, "Automation request body ended early".to_string()));
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = &buffer[header_end..header_end + content_length];
    let request: BridgeRequest = serde_json::from_slice(body)
        .map_err(|error| (400, format!("Invalid automation JSON: {error}")))?;
    if request.id.trim().is_empty() || request.method.trim().is_empty() {
        return Err((
            400,
            "Automation request needs non-empty id and method".to_string(),
        ));
    }
    Ok(request)
}

fn write_json_response(stream: &mut TcpStream, status: u16, body: &BridgeReply) {
    let body = serde_json::to_vec(body).unwrap_or_else(|_| {
        br#"{"ok":false,"error":"Automation response encoding failed"}"#.to_vec()
    });
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        411 => "Length Required",
        413 => "Content Too Large",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Internal Server Error",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(&body);
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn rejects_browser_origin_even_with_token() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let sender = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            let body = br#"{"id":"1","method":"app.inspect","params":{}}"#;
            write!(
                stream,
                "POST /rpc HTTP/1.1\r\nAuthorization: Bearer test\r\nOrigin: https://example.com\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        });
        let (mut server_stream, _) = listener.accept().unwrap();
        let result = read_http_request(&mut server_stream, "test");
        sender.join().unwrap();
        assert_eq!(result.unwrap_err().0, 403);
    }

    #[test]
    fn parses_authenticated_loopback_request() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let sender = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            let body = br#"{"id":"abc","method":"project.list","params":{}}"#;
            write!(
                stream,
                "POST /rpc HTTP/1.1\r\nAuthorization: Bearer test\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        });
        let (mut server_stream, _) = listener.accept().unwrap();
        let request = read_http_request(&mut server_stream, "test").unwrap();
        sender.join().unwrap();
        assert_eq!(request.id, "abc");
        assert_eq!(request.method, "project.list");
    }
}

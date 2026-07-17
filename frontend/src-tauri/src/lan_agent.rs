//! Packaged outbound LAN agent for the authenticated Syzygy MCP coordinator.
//!
//! The GUI automation bridge remains loopback-only. This mode spawns the same executable in
//! `--mcp` mode, authenticates to an explicitly configured LAN coordinator, and forwards bounded
//! JSON-RPC calls over an encrypted, replay-protected stream.

use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, ErrorKind, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PROTOCOL: &str = "syzygy-lan-v1";
const DEFAULT_PORT: u16 = 37_663;
const MAX_LINE_BYTES: usize = 12 * 1024 * 1024;
const MAX_HANDSHAKE_BYTES: usize = 8 * 1024;
const DEFAULT_REQUEST_MS: u64 = 20_000;
const MAX_REQUEST_MS: u64 = 60_000;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug)]
struct Options {
    node_id: String,
    coordinator: String,
    port: u16,
    key_file: PathBuf,
}

impl Options {
    fn parse(arguments: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut values = arguments.into_iter();
        let mut node_id = None;
        let mut coordinator = None;
        let mut port = DEFAULT_PORT;
        let mut key_file = None;
        while let Some(argument) = values.next() {
            let next = |values: &mut dyn Iterator<Item = String>, flag: &str| {
                values
                    .next()
                    .ok_or_else(|| format!("{flag} requires a value"))
            };
            match argument.as_str() {
                "--lan-agent" => {}
                "--node-id" => node_id = Some(next(&mut values, "--node-id")?),
                "--coordinator" => coordinator = Some(next(&mut values, "--coordinator")?),
                "--port" => {
                    port = next(&mut values, "--port")?
                        .parse::<u16>()
                        .map_err(|_| "--port must be from 1 to 65535".to_string())?;
                }
                "--key-file" => key_file = Some(PathBuf::from(next(&mut values, "--key-file")?)),
                other => return Err(format!("Unknown LAN agent option: {other}")),
            }
        }
        let node_id = node_id.ok_or_else(|| "--node-id is required".to_string())?;
        if !valid_node_id(&node_id) {
            return Err(
                "node ID must be 1-64 characters using letters, numbers, dot, underscore, or dash"
                    .to_string(),
            );
        }
        Ok(Self {
            node_id,
            coordinator: coordinator.ok_or_else(|| "--coordinator is required".to_string())?,
            port,
            key_file: key_file.ok_or_else(|| "--key-file is required".to_string())?,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Challenge {
    r#type: String,
    protocol: String,
    server_nonce: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    r#type: &'static str,
    protocol: &'static str,
    node_id: String,
    client_nonce: String,
    proof: String,
    metadata: Value,
}

#[derive(Serialize, Deserialize)]
struct EncryptedFrame {
    sequence: u64,
    nonce: String,
    ciphertext: String,
    tag: String,
}

struct SecureChannel {
    node_id: String,
    send_key: [u8; 32],
    receive_key: [u8; 32],
    send_sequence: u64,
    receive_sequence: u64,
}

impl SecureChannel {
    fn encode(&mut self, message: &Value) -> Result<String, String> {
        self.send_sequence = self
            .send_sequence
            .checked_add(1)
            .ok_or_else(|| "LAN send sequence exhausted".to_string())?;
        let mut nonce_bytes = [0_u8; 12];
        getrandom::getrandom(&mut nonce_bytes)
            .map_err(|error| format!("Could not create LAN frame nonce: {error}"))?;
        let cipher = Aes256Gcm::new_from_slice(&self.send_key)
            .map_err(|_| "Could not initialize LAN encryption".to_string())?;
        let plaintext = serde_json::to_vec(message)
            .map_err(|error| format!("Could not encode LAN message: {error}"))?;
        let encrypted = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: &plaintext,
                    aad: &frame_aad(&self.node_id, "agent-to-server", self.send_sequence),
                },
            )
            .map_err(|_| "Could not encrypt LAN message".to_string())?;
        if encrypted.len() < 16 {
            return Err("LAN encryption returned an invalid frame".to_string());
        }
        let split = encrypted.len() - 16;
        let frame = EncryptedFrame {
            sequence: self.send_sequence,
            nonce: URL_SAFE_NO_PAD.encode(nonce_bytes),
            ciphertext: URL_SAFE_NO_PAD.encode(&encrypted[..split]),
            tag: URL_SAFE_NO_PAD.encode(&encrypted[split..]),
        };
        let encoded = serde_json::to_string(&frame)
            .map_err(|error| format!("Could not encode encrypted LAN frame: {error}"))?;
        if encoded.len() > MAX_LINE_BYTES {
            return Err("Encrypted LAN frame exceeds the size limit".to_string());
        }
        Ok(encoded)
    }

    fn decode(&mut self, line: &str) -> Result<Value, String> {
        if line.len() > MAX_LINE_BYTES {
            return Err("Encrypted LAN frame exceeds the size limit".to_string());
        }
        let frame: EncryptedFrame = serde_json::from_str(line)
            .map_err(|_| "Encrypted LAN frame is not valid JSON".to_string())?;
        let expected = self
            .receive_sequence
            .checked_add(1)
            .ok_or_else(|| "LAN receive sequence exhausted".to_string())?;
        if frame.sequence != expected {
            return Err(format!(
                "Encrypted LAN frame sequence mismatch: expected {expected}"
            ));
        }
        let nonce = decode_exact(&frame.nonce, 12, "nonce")?;
        let mut ciphertext = URL_SAFE_NO_PAD
            .decode(frame.ciphertext)
            .map_err(|_| "Encrypted LAN frame ciphertext is invalid".to_string())?;
        let tag = decode_exact(&frame.tag, 16, "tag")?;
        ciphertext.extend_from_slice(&tag);
        let cipher = Aes256Gcm::new_from_slice(&self.receive_key)
            .map_err(|_| "Could not initialize LAN decryption".to_string())?;
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &frame_aad(&self.node_id, "server-to-agent", expected),
                },
            )
            .map_err(|_| "Encrypted LAN frame authentication failed".to_string())?;
        let message = serde_json::from_slice(&plaintext)
            .map_err(|_| "Decrypted LAN message is not valid JSON".to_string())?;
        self.receive_sequence = expected;
        Ok(message)
    }
}

struct LocalMcp {
    child: Child,
    stdin: Option<BufWriter<ChildStdin>>,
    responses: Receiver<Result<Value, String>>,
    next_id: u64,
}

impl LocalMcp {
    fn start() -> Result<(Self, Value), String> {
        let executable = std::env::current_exe()
            .map_err(|error| format!("Could not locate this Syzygy executable: {error}"))?;
        let mut child = Command::new(executable)
            .arg("--mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not start local Syzygy MCP: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Local Syzygy MCP stdin is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Local Syzygy MCP stdout is unavailable".to_string())?;
        let (sender, responses) = mpsc::channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let result = line
                    .map_err(|error| format!("Could not read local Syzygy MCP: {error}"))
                    .and_then(|line| {
                        serde_json::from_str(&line)
                            .map_err(|_| "Local Syzygy MCP emitted invalid JSON".to_string())
                    });
                if sender.send(result).is_err() {
                    break;
                }
            }
        });
        let mut session = Self {
            child,
            stdin: Some(BufWriter::new(stdin)),
            responses,
            next_id: 1,
        };
        let initialized = session.request(
            "initialize",
            json!({
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "syzygy-packaged-lan-agent", "version": "1" }
            }),
            Duration::from_secs(20),
            || Ok(()),
        )?;
        session.notify("notifications/initialized", json!({}))?;
        Ok((session, initialized))
    }

    fn write(&mut self, message: &Value) -> Result<(), String> {
        let writer = self
            .stdin
            .as_mut()
            .ok_or_else(|| "Local Syzygy MCP is closed".to_string())?;
        serde_json::to_writer(&mut *writer, message)
            .map_err(|error| format!("Could not encode local MCP request: {error}"))?;
        writer
            .write_all(b"\n")
            .and_then(|_| writer.flush())
            .map_err(|error| format!("Could not write local MCP request: {error}"))
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
        mut on_wait: impl FnMut() -> Result<(), String>,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("Local Syzygy MCP {method} timed out"));
            }
            match self
                .responses
                .recv_timeout(remaining.min(HEARTBEAT_INTERVAL))
            {
                Ok(Ok(message)) => {
                    if message.get("id").and_then(Value::as_u64) != Some(id) {
                        continue;
                    }
                    if let Some(error) = message.get("error") {
                        return Err(error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Local Syzygy MCP request failed")
                            .to_string());
                    }
                    return Ok(message.get("result").cloned().unwrap_or(Value::Null));
                }
                Ok(Err(error)) => return Err(error),
                Err(RecvTimeoutError::Timeout) => on_wait()?,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("Local Syzygy MCP response channel closed".to_string())
                }
            }
        }
    }
}

impl Drop for LocalMcp {
    fn drop(&mut self) {
        self.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn run_from_args(arguments: impl IntoIterator<Item = String>) -> Result<(), String> {
    let options = Options::parse(arguments)?;
    let key = read_key(&options.key_file)?;
    let (mut local, initialized) = LocalMcp::start()?;
    let mut retry = Duration::from_secs(1);
    loop {
        match connect_and_run(&options, &key, &initialized, &mut local) {
            Ok(()) => retry = Duration::from_secs(1),
            Err(error) => eprintln!(
                "Syzygy LAN agent {} disconnected: {}. Retrying in {}s.",
                options.node_id,
                sanitize(&error),
                retry.as_secs()
            ),
        }
        std::thread::sleep(retry);
        retry = (retry * 2).min(Duration::from_secs(15));
    }
}

fn connect_and_run(
    options: &Options,
    key: &[u8; 32],
    initialized: &Value,
    local: &mut LocalMcp,
) -> Result<(), String> {
    let mut stream = connect(&options.coordinator, options.port)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|error| format!("Could not set LAN read deadline: {error}"))?;
    stream
        .set_nodelay(true)
        .map_err(|error| format!("Could not configure LAN socket: {error}"))?;
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|error| format!("Could not clone LAN socket: {error}"))?,
    );
    let challenge_line = read_line(&mut reader, MAX_HANDSHAKE_BYTES)?;
    let challenge: Challenge = serde_json::from_str(&challenge_line)
        .map_err(|_| "Coordinator challenge is invalid".to_string())?;
    if challenge.r#type != "challenge" || challenge.protocol != PROTOCOL {
        return Err("Coordinator protocol challenge is invalid".to_string());
    }
    let server_nonce = decode_exact(&challenge.server_nonce, 32, "server nonce")?;
    let mut client_nonce = [0_u8; 32];
    getrandom::getrandom(&mut client_nonce)
        .map_err(|error| format!("Could not create LAN client nonce: {error}"))?;
    let proof = agent_proof(key, &options.node_id, &server_nonce, &client_nonce)?;
    let (send_key, receive_key) = derive_keys(key, &options.node_id, &server_nonce, &client_nonce)?;
    write_line(
        &mut stream,
        &serde_json::to_string(&Hello {
            r#type: "hello",
            protocol: PROTOCOL,
            node_id: options.node_id.clone(),
            client_nonce: URL_SAFE_NO_PAD.encode(client_nonce),
            proof: URL_SAFE_NO_PAD.encode(proof),
            metadata: json!({
                "hostname": std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "unknown".to_string()),
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "packagedAgent": true,
                "mcpServer": initialized.get("serverInfo").cloned().unwrap_or(Value::Null)
            }),
        })
        .map_err(|error| format!("Could not encode LAN hello: {error}"))?,
    )?;
    let mut channel = SecureChannel {
        node_id: options.node_id.clone(),
        send_key,
        receive_key,
        send_sequence: 0,
        receive_sequence: 0,
    };
    let ready = channel.decode(&read_line(&mut reader, MAX_LINE_BYTES)?)?;
    if ready.get("type").and_then(Value::as_str) != Some("ready") {
        return Err("Coordinator did not complete the encrypted handshake".to_string());
    }
    eprintln!(
        "Syzygy LAN agent {} connected to {}:{}.",
        options.node_id, options.coordinator, options.port
    );
    loop {
        let line = match read_line(&mut reader, MAX_LINE_BYTES) {
            Ok(line) => line,
            Err(error) if error == "LAN read deadline elapsed" => {
                send_heartbeat(&mut stream, &mut channel)?;
                continue;
            }
            Err(error) => return Err(error),
        };
        let message = channel.decode(&line)?;
        match message.get("type").and_then(Value::as_str) {
            Some("heartbeat") => send_heartbeat(&mut stream, &mut channel)?,
            Some("request") => {
                let request_id = message
                    .get("requestId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Coordinator request ID is missing".to_string())?
                    .to_string();
                let method = message
                    .get("method")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Coordinator request method is missing".to_string())?
                    .to_string();
                let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
                let timeout_ms = message
                    .get("timeoutMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(DEFAULT_REQUEST_MS);
                if !(1_000..=MAX_REQUEST_MS).contains(&timeout_ms) {
                    return Err("Coordinator request deadline is invalid".to_string());
                }
                let result =
                    local.request(&method, params, Duration::from_millis(timeout_ms), || {
                        send_heartbeat(&mut stream, &mut channel)
                    });
                let response = match result {
                    Ok(result) => {
                        json!({ "type": "response", "requestId": request_id, "ok": true, "result": result })
                    }
                    Err(error) => {
                        json!({ "type": "response", "requestId": request_id, "ok": false, "error": sanitize(&error) })
                    }
                };
                let encoded = channel.encode(&response)?;
                write_line(&mut stream, &encoded)?;
            }
            _ => return Err("Coordinator sent an unsupported encrypted message".to_string()),
        }
    }
}

fn connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("Could not resolve LAN coordinator: {error}"))?;
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, Duration::from_secs(5)) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }
    Err(format!(
        "Could not connect to LAN coordinator: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no address".to_string())
    ))
}

fn read_key(path: &PathBuf) -> Result<[u8; 32], String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Could not read LAN pairing key: {error}"))?;
    let decoded = decode_exact(raw.trim(), 32, "pairing key")?;
    decoded
        .try_into()
        .map_err(|_| "LAN pairing key must contain 32 bytes".to_string())
}

fn agent_proof(
    key: &[u8; 32],
    node_id: &str,
    server_nonce: &[u8],
    client_nonce: &[u8],
) -> Result<Vec<u8>, String> {
    let mut hmac = <HmacSha256 as Mac>::new_from_slice(key)
        .map_err(|_| "Could not initialize LAN pairing proof".to_string())?;
    hmac.update(format!("agent\0{PROTOCOL}\0{node_id}\0").as_bytes());
    hmac.update(server_nonce);
    hmac.update(b"\0");
    hmac.update(client_nonce);
    Ok(hmac.finalize().into_bytes().to_vec())
}

fn derive_keys(
    key: &[u8; 32],
    node_id: &str,
    server_nonce: &[u8],
    client_nonce: &[u8],
) -> Result<([u8; 32], [u8; 32]), String> {
    let mut salt = Vec::with_capacity(server_nonce.len() + client_nonce.len());
    salt.extend_from_slice(server_nonce);
    salt.extend_from_slice(client_nonce);
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), key);
    let mut output = [0_u8; 64];
    hkdf.expand(format!("{PROTOCOL}\0{node_id}").as_bytes(), &mut output)
        .map_err(|_| "Could not derive LAN session keys".to_string())?;
    let mut send = [0_u8; 32];
    let mut receive = [0_u8; 32];
    send.copy_from_slice(&output[..32]);
    receive.copy_from_slice(&output[32..]);
    Ok((send, receive))
}

fn frame_aad(node_id: &str, direction: &str, sequence: u64) -> Vec<u8> {
    format!("{PROTOCOL}\0{node_id}\0{direction}\0{sequence}").into_bytes()
}

fn decode_exact(value: &str, length: usize, label: &str) -> Result<Vec<u8>, String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| format!("LAN {label} is invalid"))?;
    if decoded.len() != length {
        return Err(format!("LAN {label} must contain {length} bytes"));
    }
    Ok(decoded)
}

fn read_line(reader: &mut BufReader<TcpStream>, max: usize) -> Result<String, String> {
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => return Err("LAN connection closed".to_string()),
        Ok(_) => {}
        Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
            return Err("LAN read deadline elapsed".to_string())
        }
        Err(error) => return Err(format!("Could not read LAN connection: {error}")),
    }
    if line.len() > max {
        return Err("LAN line exceeds the size limit".to_string());
    }
    Ok(line.trim().to_string())
}

fn write_line(stream: &mut TcpStream, line: &str) -> Result<(), String> {
    stream
        .write_all(line.as_bytes())
        .and_then(|_| stream.write_all(b"\n"))
        .and_then(|_| stream.flush())
        .map_err(|error| format!("Could not write LAN connection: {error}"))
}

fn send_heartbeat(stream: &mut TcpStream, channel: &mut SecureChannel) -> Result<(), String> {
    let sent_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let encoded = channel.encode(&json!({ "type": "heartbeat", "sentAt": sent_at }))?;
    write_line(stream, &encoded)
}

fn valid_node_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn sanitize(message: &str) -> String {
    message
        .chars()
        .map(|character| {
            if matches!(character, '\r' | '\n' | '\t') {
                ' '
            } else {
                character
            }
        })
        .take(500)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_identity_is_bounded() {
        assert!(valid_node_id("office-a.local"));
        assert!(!valid_node_id("../office-a"));
        assert!(!valid_node_id(""));
    }

    #[test]
    fn channel_round_trip_rejects_replay() {
        let key = [7_u8; 32];
        let (agent_send, agent_receive) =
            derive_keys(&key, "office-a", &[1_u8; 32], &[2_u8; 32]).unwrap();
        let mut agent = SecureChannel {
            node_id: "office-a".to_string(),
            send_key: agent_send,
            receive_key: agent_receive,
            send_sequence: 0,
            receive_sequence: 0,
        };
        let mut server = SecureChannel {
            node_id: "office-a".to_string(),
            send_key: agent_receive,
            receive_key: agent_send,
            send_sequence: 0,
            receive_sequence: 0,
        };
        let outbound = agent.encode(&json!({ "type": "heartbeat" })).unwrap();
        let decoded = decode_server_frame(&mut server, &outbound).unwrap();
        assert_eq!(
            decoded.get("type").and_then(Value::as_str),
            Some("heartbeat")
        );
        assert!(decode_server_frame(&mut server, &outbound)
            .unwrap_err()
            .contains("sequence mismatch"));
    }

    fn decode_server_frame(channel: &mut SecureChannel, line: &str) -> Result<Value, String> {
        let previous = channel.receive_sequence;
        let frame: EncryptedFrame = serde_json::from_str(line).unwrap();
        let expected = previous + 1;
        if frame.sequence != expected {
            return Err(format!(
                "Encrypted LAN frame sequence mismatch: expected {expected}"
            ));
        }
        let nonce = decode_exact(&frame.nonce, 12, "nonce")?;
        let mut ciphertext = URL_SAFE_NO_PAD.decode(frame.ciphertext).unwrap();
        ciphertext.extend_from_slice(&decode_exact(&frame.tag, 16, "tag")?);
        let cipher = Aes256Gcm::new_from_slice(&channel.receive_key).unwrap();
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &frame_aad(&channel.node_id, "agent-to-server", expected),
                },
            )
            .map_err(|_| "authentication failed".to_string())?;
        channel.receive_sequence = expected;
        serde_json::from_slice(&plaintext).map_err(|error| error.to_string())
    }
}

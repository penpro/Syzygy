//! Small app-owned y-websocket-compatible relay.
//!
//! The server deliberately interprets only the two outer y-websocket message tags needed to
//! distinguish document sync from ephemeral awareness. It never interprets Syzygy domain data.
//! Document sync frames are stored in a bounded append-only room log; awareness is memory-only.

use crate::collaboration_identity::{verify_relay_admin_signature, RelayAdminIdentityClaim};
use crate::collaboration_relay_membership::{
    authorize, issue_member, load_registry, registry_path, report_room, revoke_member,
    rotate_member, validate_relay_device_binding, RelayAuthorization, RelayDeviceBinding,
    RelayMemberCredential, RelayMemberRole, RelayMembershipRegistry, RelayRoomMembershipReport,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{Request, Response};
use tungstenite::{accept_hdr, Error as WebsocketError, HandshakeError, Message};

const LOG_MAGIC: &[u8] = b"SYZYGY-YWS-RELAY-V1\n";
pub const MAX_FRAME_BYTES: usize = 12 * 1024 * 1024;
pub const MAX_ROOM_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_ROOM_FRAMES: usize = 8_192;
pub const MAX_ROOM_CLIENTS: usize = 32;
pub const MAX_ACTIVE_ROOMS: usize = 256;
pub const MAX_SERVER_BYTES: usize = 512 * 1024 * 1024;
pub const MAX_SERVER_CONNECTIONS: usize = 256;
const OUTGOING_QUEUE: usize = 256;
const ACCEPT_POLL: Duration = Duration::from_millis(25);
const SOCKET_POLL: Duration = Duration::from_millis(50);
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(5);
const REPLAY_DEADLINE: Duration = Duration::from_secs(15);
const MAX_AUTH_REPLAY_ENTRIES: usize = 4_096;
const REMOTE_ADMIN_PATH_PREFIX: &str = "/__syzygy_relay_admin_v1/";
const MAX_REMOTE_ADMIN_MESSAGE_BYTES: usize = 64 * 1024;
const EMPTY_STATE_VECTOR_SYNC_STEP_ONE: &[u8] = &[0, 0, 1, 0];
// y-protocol sync step two containing Yjs's canonical empty update. This completes a viewer's
// handshake after retained frames without asking the viewer to send document state to the relay.
const EMPTY_UPDATE_SYNC_STEP_TWO: &[u8] = &[0, 1, 2, 0, 0];
// y-websocket's query-awareness message asks connected peers to rebroadcast their current
// ephemeral state. It restores presence after a reconnect without retaining awareness server-side.
const QUERY_AWARENESS: &[u8] = &[3];

type PeerId = u64;
struct Peer {
    sender: mpsc::SyncSender<Vec<u8>>,
    evicted: Arc<AtomicBool>,
}

struct Room {
    frames: Vec<Vec<u8>>,
    hashes: HashSet<[u8; 32]>,
    bytes: usize,
    peers: HashMap<PeerId, Peer>,
}

impl Room {
    fn from_frames(frames: Vec<Vec<u8>>) -> Self {
        let bytes = frames.iter().map(Vec::len).sum();
        let hashes = frames.iter().map(|frame| frame_hash(frame)).collect();
        Self {
            frames,
            hashes,
            bytes,
            peers: HashMap::new(),
        }
    }
}

struct RelayState {
    data_dir: PathBuf,
    membership: RelayMembershipRegistry,
    rooms: HashMap<String, Room>,
    total_bytes: usize,
    next_peer_id: AtomicU64,
    auth_replays: HashMap<String, u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum RelayRemoteAdminAction {
    Status,
    Issue {
        role: RelayMemberRole,
        #[serde(rename = "expiresInSeconds")]
        expires_in_seconds: Option<u64>,
        device: RelayDeviceBinding,
    },
    Rotate {
        #[serde(rename = "memberId")]
        member_id: String,
        #[serde(rename = "expiresInSeconds")]
        expires_in_seconds: Option<u64>,
        device: Option<RelayDeviceBinding>,
    },
    Revoke {
        #[serde(rename = "memberId")]
        member_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelayRemoteAdminRequest {
    schema_version: u8,
    claim: RelayAdminIdentityClaim,
    action: serde_json::Value,
    signature: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayRemoteAdminResponse {
    schema_version: u8,
    ok: bool,
    error: Option<String>,
    room: Option<RelayRoomMembershipReport>,
    credential: Option<RelayMemberCredential>,
}

fn wall_clock_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn role_name(role: RelayMemberRole) -> &'static str {
    match role {
        RelayMemberRole::Admin => "admin",
        RelayMemberRole::Editor => "editor",
        RelayMemberRole::Viewer => "viewer",
    }
}

fn expiry_name(expires_in_seconds: Option<u64>) -> String {
    expires_in_seconds
        .map(|value| value.to_string())
        .unwrap_or_else(|| "none".into())
}

fn device_name(device: Option<&RelayDeviceBinding>) -> Result<String, String> {
    let Some(device) = device else {
        return Ok("none".into());
    };
    validate_relay_device_binding(device)?;
    Ok(format!(
        "{}\n{}\n{}\n{}",
        device.schema_version, device.algorithm, device.key_id, device.public_key
    ))
}

fn canonical_remote_admin_action(action: &RelayRemoteAdminAction) -> Result<Vec<u8>, String> {
    let value = match action {
        RelayRemoteAdminAction::Status => "status".into(),
        RelayRemoteAdminAction::Issue {
            role,
            expires_in_seconds,
            device,
        } => format!(
            "issue\n{}\n{}\n{}",
            role_name(*role),
            expiry_name(*expires_in_seconds),
            device_name(Some(device))?,
        ),
        RelayRemoteAdminAction::Rotate {
            member_id,
            expires_in_seconds,
            device,
        } => format!(
            "rotate\n{member_id}\n{}\n{}",
            expiry_name(*expires_in_seconds),
            device_name(device.as_ref())?,
        ),
        RelayRemoteAdminAction::Revoke { member_id } => format!("revoke\n{member_id}"),
    };
    Ok(value.into_bytes())
}

fn remote_admin_action_sha256(action: &RelayRemoteAdminAction) -> Result<String, String> {
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(canonical_remote_admin_action(action)?)))
}

fn parse_remote_admin_action(value: serde_json::Value) -> Result<RelayRemoteAdminAction, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Relay administrator action is invalid".to_string())?;
    let kind = object
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Relay administrator action is invalid".to_string())?;
    let expected = match kind {
        "status" => &["kind"][..],
        "issue" => &["kind", "role", "expiresInSeconds", "device"][..],
        "rotate" => &["kind", "memberId", "expiresInSeconds", "device"][..],
        "revoke" => &["kind", "memberId"][..],
        _ => return Err("Relay administrator action is invalid".into()),
    };
    if object.len() != expected.len() || !expected.iter().all(|key| object.contains_key(*key)) {
        return Err("Relay administrator action is invalid".into());
    }
    serde_json::from_value(value).map_err(|_| "Relay administrator action is invalid".into())
}

fn is_unique_local_ipv6(address: Ipv6Addr) -> bool {
    address.octets()[0] & 0xfe == 0xfc
}

pub fn is_private_listen_address(value: &str) -> bool {
    match value.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => address.is_private() || address.is_loopback(),
        Ok(IpAddr::V6(address)) => address.is_loopback() || is_unique_local_ipv6(address),
        Err(_) => false,
    }
}

pub fn valid_room_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (32..=128).contains(&bytes.len())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn room_from_path(path: &str) -> Option<String> {
    let room = path.strip_prefix('/')?;
    if room.contains('/') || !valid_room_id(room) {
        return None;
    }
    Some(room.to_string())
}

fn remote_admin_room_from_path(path: &str) -> Option<String> {
    let room = path.strip_prefix(REMOTE_ADMIN_PATH_PREFIX)?;
    if room.contains('/') || !valid_room_id(room) {
        return None;
    }
    Some(room.to_string())
}

fn room_log_path(data_dir: &Path, room_id: &str) -> PathBuf {
    data_dir.join(format!("{room_id}.updates"))
}

fn storage_bytes(data_dir: &Path) -> Result<usize, String> {
    let mut total = 0usize;
    for entry in fs::read_dir(data_dir)
        .map_err(|error| format!("Could not inspect relay storage: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Could not inspect relay storage: {error}"))?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("updates") {
            continue;
        }
        let length: usize = entry
            .metadata()
            .map_err(|error| format!("Could not inspect relay room log: {error}"))?
            .len()
            .try_into()
            .map_err(|_| "Relay storage size overflowed".to_string())?;
        total = total
            .checked_add(length)
            .ok_or_else(|| "Relay storage size overflowed".to_string())?;
        if total > MAX_SERVER_BYTES {
            return Err("Relay storage exceeds its 512 MiB server bound".into());
        }
    }
    Ok(total)
}

fn frame_hash(frame: &[u8]) -> [u8; 32] {
    Sha256::digest(frame).into()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrameClass {
    SyncStepOne,
    DocumentWrite,
    NonDocument,
}

fn read_var_uint(frame: &[u8], offset: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *frame.get(*offset)?;
        *offset += 1;
        value |= u64::from(byte & 0x7f).checked_shl(shift)?;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift = shift.checked_add(7)?;
        if shift >= 64 {
            return None;
        }
    }
}

fn classify_frame(frame: &[u8]) -> Result<FrameClass, String> {
    let mut offset = 0usize;
    let outer = read_var_uint(frame, &mut offset)
        .ok_or_else(|| "Relay frame has a malformed message tag".to_string())?;
    if outer != 0 {
        return Ok(FrameClass::NonDocument);
    }
    match read_var_uint(frame, &mut offset) {
        Some(0) => Ok(FrameClass::SyncStepOne),
        Some(1 | 2) => Ok(FrameClass::DocumentWrite),
        _ => Err("Relay frame has an unsupported sync message".into()),
    }
}

fn is_persistable_sync_frame(frame: &[u8]) -> bool {
    classify_frame(frame) == Ok(FrameClass::DocumentWrite)
}

fn is_canonical_empty_sync_update(frame: &[u8]) -> bool {
    frame == EMPTY_UPDATE_SYNC_STEP_TWO
}

fn encode_log(frames: &[Vec<u8>]) -> Result<Vec<u8>, String> {
    let mut encoded = Vec::with_capacity(
        LOG_MAGIC.len() + frames.iter().map(|frame| frame.len() + 4).sum::<usize>(),
    );
    encoded.extend_from_slice(LOG_MAGIC);
    for frame in frames {
        let length: u32 = frame
            .len()
            .try_into()
            .map_err(|_| "Relay frame is too large to encode".to_string())?;
        encoded.extend_from_slice(&length.to_be_bytes());
        encoded.extend_from_slice(frame);
    }
    Ok(encoded)
}

fn load_room_log(path: &Path) -> Result<Vec<Vec<u8>>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read relay room log: {error}"))?;
    if bytes.len() > MAX_ROOM_BYTES + LOG_MAGIC.len() + MAX_ROOM_FRAMES * 4 {
        return Err("Relay room log exceeds its storage bound".into());
    }
    if !bytes.starts_with(LOG_MAGIC) {
        return Err("Relay room log has an unsupported or damaged header".into());
    }
    let mut offset = LOG_MAGIC.len();
    let mut frames = Vec::new();
    let mut total = 0usize;
    while offset < bytes.len() {
        if bytes.len() - offset < 4 {
            break;
        }
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        if length > MAX_FRAME_BYTES {
            return Err("Relay room log contains an oversized record".into());
        }
        if bytes.len() - offset < length {
            break;
        }
        let frame = bytes[offset..offset + length].to_vec();
        if !is_persistable_sync_frame(&frame) {
            return Err("Relay room log contains a non-document frame".into());
        }
        total = total
            .checked_add(frame.len())
            .ok_or_else(|| "Relay room log size overflowed".to_string())?;
        if total > MAX_ROOM_BYTES || frames.len() >= MAX_ROOM_FRAMES {
            return Err("Relay room log exceeds its storage bound".into());
        }
        frames.push(frame);
        offset += length;
    }
    if offset != bytes.len() {
        // A power loss may leave one partial tail record. Preserve every complete record and
        // rewrite only the damaged tail.
        let repaired = encode_log(&frames)?;
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)
            .map_err(|error| format!("Could not open relay room log for repair: {error}"))?;
        file.write_all(&repaired)
            .and_then(|_| file.sync_data())
            .map_err(|error| format!("Could not repair relay room log: {error}"))?;
    }
    Ok(frames)
}

fn ensure_room_log(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("Could not create relay room log: {error}"))?;
    file.write_all(LOG_MAGIC)
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("Could not initialize relay room log: {error}"))
}

fn append_frame(path: &Path, frame: &[u8]) -> Result<(), String> {
    ensure_room_log(path)?;
    let mut file = OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|error| format!("Could not open relay room log: {error}"))?;
    let length: u32 = frame
        .len()
        .try_into()
        .map_err(|_| "Relay frame is too large to encode".to_string())?;
    file.write_all(&length.to_be_bytes())
        .and_then(|_| file.write_all(frame))
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("Could not durably append relay update: {error}"))
}

fn room<'a>(state: &'a mut RelayState, room_id: &str) -> Result<&'a mut Room, String> {
    if !state.rooms.contains_key(room_id) {
        if state.rooms.len() >= MAX_ACTIVE_ROOMS {
            return Err("Relay has reached its 256-active-room limit".into());
        }
        let frames = load_room_log(&room_log_path(&state.data_dir, room_id))?;
        state
            .rooms
            .insert(room_id.to_string(), Room::from_frames(frames));
    }
    state
        .rooms
        .get_mut(room_id)
        .ok_or_else(|| "Relay room could not be initialized".to_string())
}

fn register_peer(
    shared: &Arc<Mutex<RelayState>>,
    room_id: &str,
) -> Result<
    (
        PeerId,
        mpsc::Receiver<Vec<u8>>,
        Arc<AtomicBool>,
        Vec<Vec<u8>>,
    ),
    String,
> {
    let mut state = shared
        .lock()
        .map_err(|_| "Relay state lock was poisoned".to_string())?;
    let peer_id = state.next_peer_id.fetch_add(1, Ordering::Relaxed);
    let room = room(&mut state, room_id)?;
    if room.peers.len() >= MAX_ROOM_CLIENTS {
        return Err("Relay room has reached its 32-client limit".into());
    }
    let (sender, receiver) = mpsc::sync_channel(OUTGOING_QUEUE);
    let evicted = Arc::new(AtomicBool::new(false));
    room.peers.insert(
        peer_id,
        Peer {
            sender,
            evicted: evicted.clone(),
        },
    );
    Ok((peer_id, receiver, evicted, room.frames.clone()))
}

fn remove_peer(shared: &Arc<Mutex<RelayState>>, room_id: &str, peer_id: PeerId) {
    if let Ok(mut state) = shared.lock() {
        if let Some(room) = state.rooms.get_mut(room_id) {
            room.peers.remove(&peer_id);
        }
    }
}

fn persist_if_new(
    shared: &Arc<Mutex<RelayState>>,
    room_id: &str,
    frame: &[u8],
) -> Result<(), String> {
    if !is_persistable_sync_frame(frame) {
        return Ok(());
    }
    let mut state = shared
        .lock()
        .map_err(|_| "Relay state lock was poisoned".to_string())?;
    let data_dir = state.data_dir.clone();
    let hash = frame_hash(frame);
    let record_bytes = frame.len().saturating_add(4);
    {
        let room = room(&mut state, room_id)?;
        if room.hashes.contains(&hash) {
            return Ok(());
        }
        if room.frames.len() >= MAX_ROOM_FRAMES
            || room.bytes.saturating_add(frame.len()) > MAX_ROOM_BYTES
        {
            return Err("Relay room reached its bounded update-log quota".into());
        }
    }
    if state.total_bytes.saturating_add(record_bytes) > MAX_SERVER_BYTES {
        return Err("Relay storage reached its 512 MiB server quota".into());
    }
    append_frame(&room_log_path(&data_dir, room_id), frame)?;
    state.total_bytes += record_bytes;
    let room = state
        .rooms
        .get_mut(room_id)
        .ok_or_else(|| "Relay room disappeared during persistence".to_string())?;
    room.bytes += frame.len();
    room.hashes.insert(hash);
    room.frames.push(frame.to_vec());
    Ok(())
}

fn broadcast(shared: &Arc<Mutex<RelayState>>, room_id: &str, sender_id: PeerId, frame: &[u8]) {
    let Ok(mut state) = shared.lock() else {
        return;
    };
    let Some(room) = state.rooms.get_mut(room_id) else {
        return;
    };
    let stale = room
        .peers
        .iter()
        .filter_map(|(peer_id, peer)| {
            if *peer_id == sender_id {
                return None;
            }
            peer.sender.try_send(frame.to_vec()).err().map(|_| {
                peer.evicted.store(true, Ordering::Relaxed);
                *peer_id
            })
        })
        .collect::<Vec<_>>();
    for peer_id in stale {
        room.peers.remove(&peer_id);
    }
}

fn send_binary(
    socket: &mut tungstenite::WebSocket<TcpStream>,
    frame: Vec<u8>,
) -> Result<(), String> {
    socket
        .send(Message::Binary(frame))
        .map_err(|error| format!("Could not send relay frame: {error}"))
}

fn send_remote_admin_response(
    socket: &mut tungstenite::WebSocket<TcpStream>,
    response: RelayRemoteAdminResponse,
) -> Result<(), String> {
    let encoded = serde_json::to_string(&response)
        .map_err(|error| format!("Could not encode relay administrator response: {error}"))?;
    if encoded.len() > MAX_REMOTE_ADMIN_MESSAGE_BYTES {
        return Err("Relay administrator response exceeds its 64 KiB limit".into());
    }
    socket
        .send(Message::Text(encoded.into()))
        .map_err(|error| format!("Could not send relay administrator response: {error}"))
}

fn evict_room_peers(state: &mut RelayState, room_id: &str) {
    if let Some(room) = state.rooms.get_mut(room_id) {
        for peer in room.peers.values() {
            peer.evicted.store(true, Ordering::Relaxed);
        }
    }
}

fn execute_remote_admin_action(
    shared: &Arc<Mutex<RelayState>>,
    room_id: &str,
    expected_revision: u64,
    action: RelayRemoteAdminAction,
) -> Result<(RelayRoomMembershipReport, Option<RelayMemberCredential>), String> {
    let mut state = shared
        .lock()
        .map_err(|_| "Relay state lock was poisoned".to_string())?;
    let path = registry_path(&state.data_dir);
    let (room, credential, mutated) = match action {
        RelayRemoteAdminAction::Status => {
            if expected_revision != 0 {
                return Err("Relay administrator status requests must use revision zero".into());
            }
            (report_room(&path, room_id)?, None, false)
        }
        RelayRemoteAdminAction::Issue {
            role,
            expires_in_seconds,
            device,
        } => {
            let (credential, room) = issue_member(
                &path,
                room_id,
                expected_revision,
                role,
                expires_in_seconds,
                Some(device),
            )?;
            (room, Some(credential), true)
        }
        RelayRemoteAdminAction::Rotate {
            member_id,
            expires_in_seconds,
            device,
        } => {
            let (credential, room) = rotate_member(
                &path,
                room_id,
                &member_id,
                expected_revision,
                expires_in_seconds,
                device,
            )?;
            (room, Some(credential), true)
        }
        RelayRemoteAdminAction::Revoke { member_id } => (
            revoke_member(&path, room_id, &member_id, expected_revision)?,
            None,
            true,
        ),
    };
    if mutated {
        state.membership = load_registry(&path)?;
        evict_room_peers(&mut state, room_id);
    }
    Ok((room, credential))
}

fn handle_remote_admin_connection(
    mut socket: tungstenite::WebSocket<TcpStream>,
    shared: Arc<Mutex<RelayState>>,
    project_id: &str,
    room_id: &str,
    authorization: RelayAuthorization,
) -> Result<(), String> {
    let (administrator_member_id, device) = match authorization {
        RelayAuthorization::Member {
            member_id,
            role: RelayMemberRole::Admin,
            replay: Some(_),
            device: Some(device),
        } => (member_id, device),
        _ => return Err("Relay administrator authorization was denied".into()),
    };
    socket
        .get_mut()
        .set_read_timeout(Some(HANDSHAKE_DEADLINE))
        .map_err(|error| format!("Could not bound relay administrator request: {error}"))?;
    let request_deadline = Instant::now() + HANDSHAKE_DEADLINE;
    let text = loop {
        if Instant::now() >= request_deadline {
            return Err("Relay administrator request exceeded its five-second deadline".into());
        }
        match socket.read() {
            Ok(Message::Text(text)) => break text,
            Ok(Message::Ping(payload)) => socket
                .send(Message::Pong(payload))
                .map_err(|error| format!("Could not answer relay administrator ping: {error}"))?,
            Ok(Message::Close(_)) => {
                return Err("Relay administrator closed before sending a request".into())
            }
            Ok(_) => return Err("Relay administrator requests must be one text message".into()),
            Err(WebsocketError::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(error) => {
                return Err(format!(
                    "Could not read relay administrator request: {error}"
                ))
            }
        }
    };
    if text.len() > MAX_REMOTE_ADMIN_MESSAGE_BYTES {
        return Err("Relay administrator request exceeds its 64 KiB limit".into());
    }
    let request: RelayRemoteAdminRequest = serde_json::from_str(text.as_ref())
        .map_err(|_| "Relay administrator request is invalid".to_string())?;
    let action = parse_remote_admin_action(request.action)?;
    if request.schema_version != 1
        || request.claim.project_id != project_id
        || request.claim.room_id != room_id
        || request.claim.administrator_member_id != administrator_member_id
        || request.claim.issued_at_ms != device.issued_at_ms
        || request.claim.nonce != device.nonce
        || request.claim.action_sha256 != remote_admin_action_sha256(&action)?
    {
        return Err("Relay administrator request binding is invalid".into());
    }
    verify_relay_admin_signature(
        &device.public_key,
        &device.key_id,
        &request.claim,
        &request.signature,
    )
    .map_err(|_| "Relay administrator request signature was denied".to_string())?;

    let response = match execute_remote_admin_action(
        &shared,
        room_id,
        request.claim.expected_revision,
        action,
    ) {
        Ok((room, credential)) => RelayRemoteAdminResponse {
            schema_version: 1,
            ok: true,
            error: None,
            room: Some(room),
            credential,
        },
        Err(error) => RelayRemoteAdminResponse {
            schema_version: 1,
            ok: false,
            error: Some(error),
            room: None,
            credential: None,
        },
    };
    send_remote_admin_response(&mut socket, response)?;
    let _ = socket.close(None);
    Ok(())
}

fn handle_connection(
    stream: TcpStream,
    shared: Arc<Mutex<RelayState>>,
    stopping: Arc<AtomicBool>,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(HANDSHAKE_DEADLINE))
        .map_err(|error| format!("Could not bound relay handshake reads: {error}"))?;
    stream
        .set_write_timeout(Some(HANDSHAKE_DEADLINE))
        .map_err(|error| format!("Could not bound relay handshake writes: {error}"))?;
    let target = Arc::new(Mutex::new((None::<String>, None::<String>)));
    let captured_target = target.clone();
    let handshake_deadline = Instant::now() + HANDSHAKE_DEADLINE;
    let accepted = accept_hdr(stream, move |request: &Request, response: Response| {
        if let Ok(mut target) = captured_target.lock() {
            target.0 = Some(request.uri().path().to_string());
            target.1 = request.uri().query().map(str::to_string);
        }
        Ok(response)
    });
    let mut socket = match accepted {
        Ok(socket) => socket,
        Err(HandshakeError::Failure(error)) => {
            return Err(format!("WebSocket relay handshake failed: {error}"))
        }
        Err(HandshakeError::Interrupted(mut handshake)) => loop {
            if Instant::now() >= handshake_deadline {
                return Err("WebSocket relay handshake exceeded its five-second deadline".into());
            }
            match handshake.handshake() {
                Ok(socket) => break socket,
                Err(HandshakeError::Failure(error)) => {
                    return Err(format!("WebSocket relay handshake failed: {error}"))
                }
                Err(HandshakeError::Interrupted(next)) => {
                    handshake = next;
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        },
    };
    socket
        .get_mut()
        .set_read_timeout(Some(SOCKET_POLL))
        .map_err(|error| format!("Could not configure relay read polling: {error}"))?;
    socket
        .get_mut()
        .set_write_timeout(Some(HANDSHAKE_DEADLINE))
        .map_err(|error| format!("Could not configure relay write deadline: {error}"))?;
    let (path, query) = target
        .lock()
        .map(|target| target.clone())
        .map_err(|_| "Relay handshake target lock was poisoned".to_string())?;
    let remote_admin_room = path.as_deref().and_then(remote_admin_room_from_path);
    let room_id = remote_admin_room
        .clone()
        .or_else(|| path.as_deref().and_then(room_from_path))
        .ok_or_else(|| "WebSocket relay room path is invalid".to_string())?;
    let (authorization, room_project_id) = {
        let mut state = shared
            .lock()
            .map_err(|_| "Relay state lock was poisoned".to_string())?;
        let authorization = authorize(&state.membership, &room_id, query.as_deref())?;
        let room_project_id = if remote_admin_room.is_some() {
            Some(report_room(&registry_path(&state.data_dir), &room_id)?.project_id)
        } else {
            None
        };
        if let RelayAuthorization::Member {
            replay: Some(replay),
            ..
        } = &authorization
        {
            let current_time_ms = wall_clock_ms();
            state
                .auth_replays
                .retain(|_, expires_at_ms| *expires_at_ms > current_time_ms);
            if state.auth_replays.contains_key(&replay.key) {
                return Err("Relay member signed device authorization was already used".into());
            }
            if state.auth_replays.len() >= MAX_AUTH_REPLAY_ENTRIES {
                return Err("Relay signed authorization replay cache is full".into());
            }
            state
                .auth_replays
                .insert(replay.key.clone(), replay.expires_at_ms);
        }
        (authorization, room_project_id)
    };
    if remote_admin_room.is_some() {
        return handle_remote_admin_connection(
            socket,
            shared,
            room_project_id
                .as_deref()
                .ok_or_else(|| "Relay administrator room is not managed".to_string())?,
            &room_id,
            authorization,
        );
    }
    let can_write = match authorization {
        RelayAuthorization::LegacyBearer => true,
        RelayAuthorization::Member { role, .. } => role.can_write(),
    };
    let (peer_id, outgoing, evicted, retained) = register_peer(&shared, &room_id)?;
    let result = (|| {
        broadcast(&shared, &room_id, peer_id, QUERY_AWARENESS);
        let replay_deadline = Instant::now() + REPLAY_DEADLINE;
        for frame in retained {
            if Instant::now() >= replay_deadline {
                return Err("Relay room replay exceeded its 15-second deadline".into());
            }
            send_binary(&mut socket, frame)?;
        }
        if can_write {
            // Ask writable clients for full state. This lets a locally durable editor seed or
            // repair the server log without the relay interpreting Yjs updates.
            send_binary(&mut socket, EMPTY_STATE_VECTOR_SYNC_STEP_ONE.to_vec())?;
        } else {
            // A viewer must never be asked for document state. Retained frames were sent first;
            // this empty step-two only completes y-websocket's sync handshake.
            send_binary(&mut socket, EMPTY_UPDATE_SYNC_STEP_TWO.to_vec())?;
        }
        while !stopping.load(Ordering::Relaxed) && !evicted.load(Ordering::Relaxed) {
            while let Ok(frame) = outgoing.try_recv() {
                send_binary(&mut socket, frame)?;
            }
            match socket.read() {
                Ok(Message::Binary(frame)) => {
                    if frame.len() > MAX_FRAME_BYTES {
                        return Err("Relay frame exceeds the 12 MiB limit".into());
                    }
                    let class = classify_frame(&frame)?;
                    if class == FrameClass::DocumentWrite && !can_write {
                        if is_canonical_empty_sync_update(&frame) {
                            continue;
                        }
                        return Err("Relay member role does not permit document updates".into());
                    }
                    persist_if_new(&shared, &room_id, &frame)?;
                    broadcast(&shared, &room_id, peer_id, &frame);
                    if class == FrameClass::SyncStepOne {
                        send_binary(
                            &mut socket,
                            if can_write {
                                EMPTY_STATE_VECTOR_SYNC_STEP_ONE.to_vec()
                            } else {
                                EMPTY_UPDATE_SYNC_STEP_TWO.to_vec()
                            },
                        )?;
                    }
                }
                Ok(Message::Ping(payload)) => socket
                    .send(Message::Pong(payload))
                    .map_err(|error| format!("Could not answer relay ping: {error}"))?,
                Ok(Message::Close(_)) => break,
                Ok(Message::Text(_)) => {
                    return Err("Relay accepts binary protocol frames only".into())
                }
                Ok(_) => {}
                Err(WebsocketError::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(WebsocketError::ConnectionClosed | WebsocketError::AlreadyClosed) => break,
                Err(error) => return Err(format!("Relay connection failed: {error}")),
            }
        }
        Ok(())
    })();
    remove_peer(&shared, &room_id, peer_id);
    result
}

pub fn run_server(
    listener: TcpListener,
    data_dir: PathBuf,
    stopping: Arc<AtomicBool>,
) -> Result<(), String> {
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("Could not create relay storage directory: {error}"))?;
    let total_bytes = storage_bytes(&data_dir)?;
    let membership = load_registry(&registry_path(&data_dir))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure relay listener: {error}"))?;
    let shared = Arc::new(Mutex::new(RelayState {
        data_dir,
        membership,
        rooms: HashMap::new(),
        total_bytes,
        next_peer_id: AtomicU64::new(1),
        auth_replays: HashMap::new(),
    }));
    let active_connections = Arc::new(AtomicUsize::new(0));
    while !stopping.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                if active_connections.fetch_add(1, Ordering::Relaxed) >= MAX_SERVER_CONNECTIONS {
                    active_connections.fetch_sub(1, Ordering::Relaxed);
                    drop(stream);
                    continue;
                }
                let shared = shared.clone();
                let stopping = stopping.clone();
                let active_connections = active_connections.clone();
                std::thread::spawn(move || {
                    if let Err(error) = handle_connection(stream, shared, stopping) {
                        eprintln!("Syzygy collaboration relay connection closed: {error}");
                    }
                    active_connections.fetch_sub(1, Ordering::Relaxed);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL)
            }
            Err(error) => return Err(format!("Collaboration relay accept failed: {error}")),
        }
    }
    Ok(())
}

fn argument_value(arguments: &[String], name: &str) -> Result<String, String> {
    arguments
        .windows(2)
        .find_map(|pair| (pair[0] == name).then(|| pair[1].clone()))
        .ok_or_else(|| format!("Missing {name}"))
}

pub fn run_from_args(arguments: impl Iterator<Item = String>) -> Result<(), String> {
    let arguments = arguments.collect::<Vec<_>>();
    let listen = argument_value(&arguments, "--listen")?;
    if !is_private_listen_address(&listen) {
        return Err("Relay listen address must be an explicit private or loopback IP".into());
    }
    let port = argument_value(&arguments, "--port")?
        .parse::<u16>()
        .map_err(|_| "Relay port must be between 1 and 65535".to_string())?;
    if port == 0 {
        return Err("Relay port must be between 1 and 65535".into());
    }
    let data_dir = PathBuf::from(argument_value(&arguments, "--data-dir")?);
    if !data_dir.is_absolute() {
        return Err("Relay storage directory must be absolute".into());
    }
    let address: SocketAddr = format!("{listen}:{port}")
        .parse()
        .map_err(|_| "Relay listen address is invalid".to_string())?;
    let listener = TcpListener::bind(address)
        .map_err(|error| format!("Could not bind collaboration relay at {address}: {error}"))?;
    let stopping = Arc::new(AtomicBool::new(false));
    let stdin_stopping = stopping.clone();
    std::thread::spawn(move || {
        let mut byte = [0u8; 1];
        let mut stdin = std::io::stdin();
        loop {
            match stdin.read(&mut byte) {
                Ok(0) | Err(_) => {
                    stdin_stopping.store(true, Ordering::Relaxed);
                    return;
                }
                Ok(_) => {}
            }
        }
    });
    eprintln!("SYZYGY_COLLABORATION_RELAY_READY ws://{address}");
    run_server(listener, data_dir, stopping)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "syzygy-relay-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn limits_hosts_rooms_and_persisted_message_classes() {
        assert!(is_private_listen_address("127.0.0.1"));
        assert!(is_private_listen_address("192.168.1.20"));
        assert!(is_private_listen_address("fd00::1"));
        assert!(!is_private_listen_address("8.8.8.8"));
        assert!(!is_private_listen_address("relay.example.test"));
        assert!(valid_room_id(&"a".repeat(32)));
        assert!(!valid_room_id("short"));
        assert!(is_persistable_sync_frame(&[0, 1, 2]));
        assert!(is_persistable_sync_frame(&[0, 2, 2]));
        assert!(!is_persistable_sync_frame(&[0, 0, 1, 0]));
        assert!(!is_persistable_sync_frame(&[1, 2, 3]));
        assert!(is_canonical_empty_sync_update(EMPTY_UPDATE_SYNC_STEP_TWO));
        assert!(!is_canonical_empty_sync_update(&[0, 1, 2, 0, 1]));
        assert_eq!(
            classify_frame(&[0, 0, 1, 0]).unwrap(),
            FrameClass::SyncStepOne
        );
        assert_eq!(
            classify_frame(&[0, 1, 2]).unwrap(),
            FrameClass::DocumentWrite
        );
        assert_eq!(
            classify_frame(&[0, 2, 2]).unwrap(),
            FrameClass::DocumentWrite
        );
        assert_eq!(classify_frame(&[1, 2, 3]).unwrap(), FrameClass::NonDocument);
        assert_eq!(
            classify_frame(QUERY_AWARENESS).unwrap(),
            FrameClass::NonDocument
        );
        assert!(classify_frame(&[0, 3]).is_err());
        assert!(classify_frame(&[0x80]).is_err());
        assert_eq!(MAX_ACTIVE_ROOMS, 256);
        assert_eq!(MAX_SERVER_BYTES, 512 * 1024 * 1024);
        assert_eq!(MAX_SERVER_CONNECTIONS, 256);
    }

    #[test]
    fn repairs_only_a_partial_tail_and_rejects_non_document_records() {
        let directory = temp_dir("log");
        fs::create_dir_all(&directory).unwrap();
        let path = room_log_path(&directory, &"r".repeat(32));
        let good = vec![0, 2, 5, 6];
        let mut bytes = encode_log(&[good.clone()]).unwrap();
        bytes.extend_from_slice(&99u32.to_be_bytes());
        bytes.extend_from_slice(&[1, 2]);
        fs::write(&path, bytes).unwrap();
        assert_eq!(load_room_log(&path).unwrap(), vec![good.clone()]);
        assert_eq!(load_room_log(&path).unwrap(), vec![good]);

        fs::write(&path, encode_log(&[vec![1, 2, 3]]).unwrap()).unwrap();
        assert!(load_room_log(&path).unwrap_err().contains("non-document"));

        let mut oversized = LOG_MAGIC.to_vec();
        oversized.extend_from_slice(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes());
        fs::write(&path, oversized).unwrap();
        assert!(load_room_log(&path).unwrap_err().contains("oversized"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn remote_administrator_actions_are_strict_camel_case_and_semantically_canonical() {
        let public_key = URL_SAFE_NO_PAD.encode([7u8; 32]);
        let fingerprint = URL_SAFE_NO_PAD.encode(Sha256::digest([7u8; 32]));
        let device = RelayDeviceBinding {
            schema_version: 1,
            algorithm: "Ed25519".into(),
            key_id: format!("ed25519-sha256:{fingerprint}"),
            public_key: public_key.clone(),
        };
        let issue = parse_remote_admin_action(serde_json::json!({
            "kind": "issue",
            "role": "editor",
            "expiresInSeconds": 3600,
            "device": device,
        }))
        .unwrap();
        assert_eq!(
            String::from_utf8(canonical_remote_admin_action(&issue).unwrap()).unwrap(),
            format!(
                "issue\neditor\n3600\n1\nEd25519\ned25519-sha256:{}\n{}",
                fingerprint, public_key,
            )
        );
        assert_eq!(remote_admin_action_sha256(&issue).unwrap().len(), 43);
        assert!(parse_remote_admin_action(serde_json::json!({
            "kind": "rotate",
            "member_id": "m".repeat(24),
            "expires_in_seconds": null,
            "device": null,
        }))
        .is_err());
        assert!(parse_remote_admin_action(serde_json::json!({
            "kind": "status",
            "unexpected": true,
        }))
        .is_err());
    }
}

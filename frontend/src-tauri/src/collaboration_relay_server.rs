//! Small app-owned y-websocket-compatible relay.
//!
//! The server deliberately interprets only the two outer y-websocket message tags needed to
//! distinguish document sync from ephemeral awareness. It never interprets Syzygy domain data.
//! Document sync frames are stored in a bounded append-only room log; awareness is memory-only.

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
use tungstenite::{accept_hdr, Error as WebsocketError, Message};

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
const EMPTY_STATE_VECTOR_SYNC_STEP_ONE: &[u8] = &[0, 0, 1, 0];

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
    rooms: HashMap<String, Room>,
    total_bytes: usize,
    next_peer_id: AtomicU64,
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

fn is_persistable_sync_frame(frame: &[u8]) -> bool {
    frame.len() >= 2 && frame[0] == 0 && matches!(frame[1], 1 | 2)
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
    let path = Arc::new(Mutex::new(None::<String>));
    let captured_path = path.clone();
    let mut socket = accept_hdr(stream, move |request: &Request, response: Response| {
        if let Ok(mut path) = captured_path.lock() {
            *path = Some(request.uri().path().to_string());
        }
        Ok(response)
    })
    .map_err(|error| format!("WebSocket relay handshake failed: {error}"))?;
    socket
        .get_mut()
        .set_read_timeout(Some(SOCKET_POLL))
        .map_err(|error| format!("Could not configure relay read polling: {error}"))?;
    socket
        .get_mut()
        .set_write_timeout(Some(HANDSHAKE_DEADLINE))
        .map_err(|error| format!("Could not configure relay write deadline: {error}"))?;
    let room_id = path
        .lock()
        .ok()
        .and_then(|path| path.clone())
        .and_then(|path| room_from_path(&path))
        .ok_or_else(|| "WebSocket relay room path is invalid".to_string())?;
    let (peer_id, outgoing, evicted, retained) = register_peer(&shared, &room_id)?;
    let result = (|| {
        let replay_deadline = Instant::now() + REPLAY_DEADLINE;
        for frame in retained {
            if Instant::now() >= replay_deadline {
                return Err("Relay room replay exceeded its 15-second deadline".into());
            }
            send_binary(&mut socket, frame)?;
        }
        // Ask this client for its full state. This lets a locally durable client seed or repair the
        // server log without the relay interpreting Yjs updates.
        send_binary(&mut socket, EMPTY_STATE_VECTOR_SYNC_STEP_ONE.to_vec())?;
        while !stopping.load(Ordering::Relaxed) && !evicted.load(Ordering::Relaxed) {
            while let Ok(frame) = outgoing.try_recv() {
                send_binary(&mut socket, frame)?;
            }
            match socket.read() {
                Ok(Message::Binary(frame)) => {
                    if frame.len() > MAX_FRAME_BYTES {
                        return Err("Relay frame exceeds the 12 MiB limit".into());
                    }
                    persist_if_new(&shared, &room_id, &frame)?;
                    broadcast(&shared, &room_id, peer_id, &frame);
                    if frame.starts_with(&[0, 0]) {
                        send_binary(&mut socket, EMPTY_STATE_VECTOR_SYNC_STEP_ONE.to_vec())?;
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
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure relay listener: {error}"))?;
    let shared = Arc::new(Mutex::new(RelayState {
        data_dir,
        rooms: HashMap::new(),
        total_bytes,
        next_peer_id: AtomicU64::new(1),
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
}

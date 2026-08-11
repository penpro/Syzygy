//! Restart-safe membership registry for the bundled collaboration relay.
//!
//! Member capabilities are bearer credentials because a browser WebSocket client must present
//! them. Only SHA-256 digests are stored by the relay operator. Registry mutation remains a local
//! Tauri control-plane operation; the LAN relay exposes no membership-management endpoint.

use crate::collaboration_identity::{
    validate_relay_device_identity, verify_relay_access_signature, RelayAccessIdentityClaim,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MEMBERSHIP_FILE: &str = "members-v1.json";
const REGISTRY_SCHEMA_VERSION: u8 = 1;
const UNBOUND_CREDENTIAL_SCHEMA_VERSION: u8 = 2;
const BOUND_CREDENTIAL_SCHEMA_VERSION: u8 = 3;
const REPORT_SCHEMA_VERSION: u8 = 3;
const MAX_REGISTRY_BYTES: usize = 1024 * 1024;
const MAX_ROOMS: usize = 256;
const MAX_MEMBERS_PER_ROOM: usize = 64;
const MEMBER_ID_BYTES: usize = 24;
const CAPABILITY_BYTES: usize = 32;
const MAX_AUTH_QUERY_BYTES: usize = 512;
const MAX_SIGNED_AUTH_AGE_MS: u64 = 60_000;
const MAX_SIGNED_AUTH_FUTURE_SKEW_MS: u64 = 15_000;
const MIN_EXPIRY_SECONDS: u64 = 5 * 60;
const MAX_EXPIRY_SECONDS: u64 = 365 * 24 * 60 * 60;

fn initial_capability_generation() -> u32 {
    1
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RelayMemberRole {
    Admin,
    Editor,
    Viewer,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayDeviceBinding {
    pub schema_version: u8,
    pub algorithm: String,
    pub key_id: String,
    pub public_key: String,
}

impl RelayMemberRole {
    pub fn can_write(self) -> bool {
        matches!(self, Self::Admin | Self::Editor)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredMember {
    member_id: String,
    role: RelayMemberRole,
    capability_sha256: String,
    #[serde(default = "initial_capability_generation")]
    capability_generation: u32,
    created_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    rotated_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revoked_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device: Option<RelayDeviceBinding>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRoom {
    room_id: String,
    project_id: String,
    created_at_ms: u64,
    members: Vec<StoredMember>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayMembershipRegistry {
    schema_version: u8,
    revision: u64,
    rooms: Vec<StoredRoom>,
}

impl Default for RelayMembershipRegistry {
    fn default() -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            revision: 0,
            rooms: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayMemberCredential {
    pub schema_version: u8,
    pub room_id: String,
    pub member_id: String,
    pub role: RelayMemberRole,
    pub capability: String,
    pub capability_generation: u32,
    pub expires_at_ms: Option<u64>,
    pub registry_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_key_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayMemberSummary {
    pub member_id: String,
    pub role: RelayMemberRole,
    pub created_at_ms: u64,
    pub rotated_at_ms: Option<u64>,
    pub expires_at_ms: Option<u64>,
    pub capability_generation: u32,
    pub revoked_at_ms: Option<u64>,
    pub device_key_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayRoomMembershipReport {
    pub schema_version: u8,
    pub registry_revision: u64,
    pub room_id: String,
    pub project_id: String,
    pub protected: bool,
    pub members: Vec<RelayMemberSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RelayAuthorization {
    LegacyBearer,
    Member {
        member_id: String,
        role: RelayMemberRole,
        replay: Option<RelayAuthorizationReplay>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayAuthorizationReplay {
    pub key: String,
    pub expires_at_ms: u64,
}

fn stable_id(value: &str, min: usize, max: usize) -> bool {
    let bytes = value.as_bytes();
    (min..=max).contains(&bytes.len())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn validate_device_binding(device: &RelayDeviceBinding) -> Result<(), String> {
    if device.schema_version != 1 || device.algorithm != "Ed25519" {
        return Err("Relay member device enrollment is invalid".into());
    }
    validate_relay_device_identity(&device.key_id, &device.public_key)
        .map(|_| ())
        .map_err(|_| "Relay member device enrollment is invalid".to_string())
}

fn validate_registry(registry: &RelayMembershipRegistry) -> Result<(), String> {
    if registry.schema_version != REGISTRY_SCHEMA_VERSION || registry.rooms.len() > MAX_ROOMS {
        return Err("Saved relay membership registry is invalid".into());
    }
    let mut room_ids = std::collections::HashSet::new();
    for room in &registry.rooms {
        if !stable_id(&room.room_id, 32, 128)
            || !stable_id(&room.project_id, 1, 200)
            || room.created_at_ms == 0
            || room.members.is_empty()
            || room.members.len() > MAX_MEMBERS_PER_ROOM
            || !room_ids.insert(&room.room_id)
        {
            return Err("Saved relay membership registry is invalid".into());
        }
        let mut member_ids = std::collections::HashSet::new();
        let mut active_admins = 0usize;
        for member in &room.members {
            if !stable_id(&member.member_id, 16, 128)
                || !valid_digest(&member.capability_sha256)
                || member.capability_generation == 0
                || member.created_at_ms < room.created_at_ms
                || member
                    .rotated_at_ms
                    .is_some_and(|rotated| rotated < member.created_at_ms)
                || member
                    .expires_at_ms
                    .is_some_and(|expires| expires <= member.created_at_ms)
                || matches!(
                    (member.expires_at_ms, member.rotated_at_ms),
                    (Some(expires), Some(rotated)) if expires <= rotated
                )
                || member
                    .revoked_at_ms
                    .is_some_and(|revoked| revoked < member.created_at_ms)
                || !member_ids.insert(&member.member_id)
            {
                return Err("Saved relay membership registry is invalid".into());
            }
            if let Some(device) = &member.device {
                validate_device_binding(device)
                    .map_err(|_| "Saved relay membership registry is invalid".to_string())?;
            }
            if member.role == RelayMemberRole::Admin && member.revoked_at_ms.is_none() {
                active_admins += 1;
            }
        }
        if active_admins == 0 {
            return Err("Saved relay membership registry has no active administrator".into());
        }
    }
    Ok(())
}

fn previous_path(path: &Path) -> PathBuf {
    path.with_extension("json.previous")
}

fn temporary_path(path: &Path) -> PathBuf {
    path.with_extension("json.tmp")
}

fn read_registry_file(path: &Path) -> Result<RelayMembershipRegistry, String> {
    let metadata =
        fs::metadata(path).map_err(|_| "Could not read relay membership registry".to_string())?;
    if metadata.len() > MAX_REGISTRY_BYTES as u64 {
        return Err("Saved relay membership registry is invalid".into());
    }
    let bytes =
        fs::read(path).map_err(|_| "Could not read relay membership registry".to_string())?;
    let registry: RelayMembershipRegistry = serde_json::from_slice(&bytes)
        .map_err(|_| "Saved relay membership registry is invalid".to_string())?;
    validate_registry(&registry)?;
    Ok(registry)
}

pub fn registry_path(data_dir: &Path) -> PathBuf {
    data_dir.join(MEMBERSHIP_FILE)
}

pub fn load_registry(path: &Path) -> Result<RelayMembershipRegistry, String> {
    if path.exists() {
        return read_registry_file(path);
    }
    let previous = previous_path(path);
    if previous.exists() {
        return read_registry_file(&previous);
    }
    Ok(RelayMembershipRegistry::default())
}

fn save_registry(path: &Path, registry: &RelayMembershipRegistry) -> Result<(), String> {
    validate_registry(registry)?;
    let bytes = serde_json::to_vec_pretty(registry)
        .map_err(|_| "Could not encode relay membership registry".to_string())?;
    if bytes.len() > MAX_REGISTRY_BYTES {
        return Err("Relay membership registry reached its storage limit".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Relay membership registry path has no parent folder".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "Could not create collaboration-relay storage".to_string())?;
    let temporary = temporary_path(path);
    let previous = previous_path(path);
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| "Could not write relay membership registry".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not write relay membership registry".to_string())?;
    drop(file);
    if previous.exists() {
        fs::remove_file(&previous)
            .map_err(|_| "Could not prepare relay membership recovery".to_string())?;
    }
    if path.exists() {
        fs::rename(path, &previous)
            .map_err(|_| "Could not prepare relay membership recovery".to_string())?;
    }
    if fs::rename(&temporary, path).is_err() {
        if previous.exists() && !path.exists() {
            let _ = fs::rename(&previous, path);
        }
        return Err("Could not finish saving relay membership registry".into());
    }
    if previous.exists() {
        let _ = fs::remove_file(previous);
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
        .max(1)
}

fn random_urlsafe(bytes: usize) -> Result<String, String> {
    let mut value = vec![0u8; bytes];
    getrandom::getrandom(&mut value)
        .map_err(|_| "Could not generate a relay member capability".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

fn capability_digest(capability: &str) -> String {
    use std::fmt::Write as _;
    Sha256::digest(capability.as_bytes()).iter().fold(
        String::with_capacity(64),
        |mut encoded, byte| {
            let _ = write!(encoded, "{byte:02x}");
            encoded
        },
    )
}

fn expiration_at(
    created_at_ms: u64,
    expires_in_seconds: Option<u64>,
) -> Result<Option<u64>, String> {
    let Some(seconds) = expires_in_seconds else {
        return Ok(None);
    };
    if !(MIN_EXPIRY_SECONDS..=MAX_EXPIRY_SECONDS).contains(&seconds) {
        return Err("Relay member lifetime must be between five minutes and one year".into());
    }
    seconds
        .checked_mul(1_000)
        .and_then(|duration| created_at_ms.checked_add(duration))
        .map(Some)
        .ok_or_else(|| "Relay member lifetime overflowed".to_string())
}

fn issue_record(
    role: RelayMemberRole,
    created_at_ms: u64,
    expires_at_ms: Option<u64>,
    device: Option<RelayDeviceBinding>,
) -> Result<(StoredMember, String), String> {
    if let Some(device) = &device {
        validate_device_binding(device)?;
    }
    let member_id = random_urlsafe(MEMBER_ID_BYTES)?;
    let capability = random_urlsafe(CAPABILITY_BYTES)?;
    Ok((
        StoredMember {
            member_id,
            role,
            capability_sha256: capability_digest(&capability),
            capability_generation: initial_capability_generation(),
            created_at_ms,
            rotated_at_ms: None,
            expires_at_ms,
            revoked_at_ms: None,
            device,
        },
        capability,
    ))
}

fn room_report(registry: &RelayMembershipRegistry, room: &StoredRoom) -> RelayRoomMembershipReport {
    RelayRoomMembershipReport {
        schema_version: REPORT_SCHEMA_VERSION,
        registry_revision: registry.revision,
        room_id: room.room_id.clone(),
        project_id: room.project_id.clone(),
        protected: true,
        members: room
            .members
            .iter()
            .map(|member| RelayMemberSummary {
                member_id: member.member_id.clone(),
                role: member.role,
                created_at_ms: member.created_at_ms,
                rotated_at_ms: member.rotated_at_ms,
                expires_at_ms: member.expires_at_ms,
                capability_generation: member.capability_generation,
                revoked_at_ms: member.revoked_at_ms,
                device_key_id: member.device.as_ref().map(|device| device.key_id.clone()),
            })
            .collect(),
    }
}

pub fn create_room(
    path: &Path,
    project_id: &str,
    room_id: &str,
    device: Option<RelayDeviceBinding>,
) -> Result<(RelayMemberCredential, RelayRoomMembershipReport), String> {
    if !stable_id(project_id, 1, 200) || !stable_id(room_id, 32, 128) {
        return Err("Relay room membership input is invalid".into());
    }
    let mut registry = load_registry(path)?;
    if registry.rooms.iter().any(|room| room.room_id == room_id) {
        return Err("Relay room already has member access enabled".into());
    }
    if registry.rooms.len() >= MAX_ROOMS {
        return Err("Relay membership registry reached its room limit".into());
    }
    let created_at_ms = now_ms();
    let (admin, capability) = issue_record(RelayMemberRole::Admin, created_at_ms, None, device)?;
    let member_id = admin.member_id.clone();
    let device_key_id = admin.device.as_ref().map(|device| device.key_id.clone());
    registry.rooms.push(StoredRoom {
        room_id: room_id.into(),
        project_id: project_id.into(),
        created_at_ms,
        members: vec![admin],
    });
    registry.revision = registry
        .revision
        .checked_add(1)
        .ok_or_else(|| "Relay membership revision overflowed".to_string())?;
    save_registry(path, &registry)?;
    let room = registry.rooms.last().expect("room was just inserted");
    Ok((
        RelayMemberCredential {
            schema_version: if device_key_id.is_some() {
                BOUND_CREDENTIAL_SCHEMA_VERSION
            } else {
                UNBOUND_CREDENTIAL_SCHEMA_VERSION
            },
            room_id: room_id.into(),
            member_id,
            role: RelayMemberRole::Admin,
            capability,
            capability_generation: initial_capability_generation(),
            expires_at_ms: None,
            registry_revision: registry.revision,
            device_key_id,
        },
        room_report(&registry, room),
    ))
}

pub fn issue_member(
    path: &Path,
    room_id: &str,
    expected_revision: u64,
    role: RelayMemberRole,
    expires_in_seconds: Option<u64>,
    device: Option<RelayDeviceBinding>,
) -> Result<(RelayMemberCredential, RelayRoomMembershipReport), String> {
    if !stable_id(room_id, 32, 128) {
        return Err("Relay room membership input is invalid".into());
    }
    let mut registry = load_registry(path)?;
    if registry.revision != expected_revision {
        return Err("Relay membership changed; refresh and try again".into());
    }
    let room = registry
        .rooms
        .iter_mut()
        .find(|room| room.room_id == room_id)
        .ok_or_else(|| "Relay room is not managed by this installation".to_string())?;
    if room.members.len() >= MAX_MEMBERS_PER_ROOM {
        return Err("Relay room reached its member limit".into());
    }
    let created_at_ms = now_ms();
    let expires_at_ms = expiration_at(created_at_ms, expires_in_seconds)?;
    let (member, capability) = issue_record(role, created_at_ms, expires_at_ms, device)?;
    let member_id = member.member_id.clone();
    let device_key_id = member.device.as_ref().map(|device| device.key_id.clone());
    room.members.push(member);
    registry.revision = registry
        .revision
        .checked_add(1)
        .ok_or_else(|| "Relay membership revision overflowed".to_string())?;
    save_registry(path, &registry)?;
    let room = registry
        .rooms
        .iter()
        .find(|room| room.room_id == room_id)
        .expect("room was just mutated");
    Ok((
        RelayMemberCredential {
            schema_version: if device_key_id.is_some() {
                BOUND_CREDENTIAL_SCHEMA_VERSION
            } else {
                UNBOUND_CREDENTIAL_SCHEMA_VERSION
            },
            room_id: room_id.into(),
            member_id,
            role,
            capability,
            capability_generation: initial_capability_generation(),
            expires_at_ms,
            registry_revision: registry.revision,
            device_key_id,
        },
        room_report(&registry, room),
    ))
}

pub fn rotate_member(
    path: &Path,
    room_id: &str,
    member_id: &str,
    expected_revision: u64,
    expires_in_seconds: Option<u64>,
    device: Option<RelayDeviceBinding>,
) -> Result<(RelayMemberCredential, RelayRoomMembershipReport), String> {
    if !stable_id(room_id, 32, 128) || !stable_id(member_id, 16, 128) {
        return Err("Relay room membership input is invalid".into());
    }
    let mut registry = load_registry(path)?;
    if registry.revision != expected_revision {
        return Err("Relay membership changed; refresh and try again".into());
    }
    let room_index = registry
        .rooms
        .iter()
        .position(|room| room.room_id == room_id)
        .ok_or_else(|| "Relay room is not managed by this installation".to_string())?;
    let member_index = registry.rooms[room_index]
        .members
        .iter()
        .position(|member| member.member_id == member_id)
        .ok_or_else(|| "Relay member is not registered in this room".to_string())?;
    if registry.rooms[room_index].members[member_index]
        .revoked_at_ms
        .is_some()
    {
        return Err("Revoked relay members cannot be recovered; issue a new member".into());
    }
    let rotated_at_ms = now_ms();
    let expires_at_ms = expiration_at(rotated_at_ms, expires_in_seconds)?;
    if let Some(device) = &device {
        validate_device_binding(device)?;
    }
    let capability = random_urlsafe(CAPABILITY_BYTES)?;
    let member = &mut registry.rooms[room_index].members[member_index];
    member.capability_sha256 = capability_digest(&capability);
    member.capability_generation = member
        .capability_generation
        .checked_add(1)
        .ok_or_else(|| "Relay member capability generation overflowed".to_string())?;
    member.rotated_at_ms = Some(rotated_at_ms);
    member.expires_at_ms = expires_at_ms;
    if device.is_some() {
        member.device = device;
    }
    let role = member.role;
    let capability_generation = member.capability_generation;
    let device_key_id = member.device.as_ref().map(|device| device.key_id.clone());
    registry.revision = registry
        .revision
        .checked_add(1)
        .ok_or_else(|| "Relay membership revision overflowed".to_string())?;
    save_registry(path, &registry)?;
    Ok((
        RelayMemberCredential {
            schema_version: if device_key_id.is_some() {
                BOUND_CREDENTIAL_SCHEMA_VERSION
            } else {
                UNBOUND_CREDENTIAL_SCHEMA_VERSION
            },
            room_id: room_id.into(),
            member_id: member_id.into(),
            role,
            capability,
            capability_generation,
            expires_at_ms,
            registry_revision: registry.revision,
            device_key_id,
        },
        room_report(&registry, &registry.rooms[room_index]),
    ))
}

pub fn revoke_member(
    path: &Path,
    room_id: &str,
    member_id: &str,
    expected_revision: u64,
) -> Result<RelayRoomMembershipReport, String> {
    if !stable_id(room_id, 32, 128) || !stable_id(member_id, 16, 128) {
        return Err("Relay room membership input is invalid".into());
    }
    let mut registry = load_registry(path)?;
    if registry.revision != expected_revision {
        return Err("Relay membership changed; refresh and try again".into());
    }
    let room_index = registry
        .rooms
        .iter()
        .position(|room| room.room_id == room_id)
        .ok_or_else(|| "Relay room is not managed by this installation".to_string())?;
    let member_index = registry.rooms[room_index]
        .members
        .iter()
        .position(|member| member.member_id == member_id)
        .ok_or_else(|| "Relay member is not registered in this room".to_string())?;
    let target = &registry.rooms[room_index].members[member_index];
    if target.revoked_at_ms.is_some() {
        return Err("Relay member is already revoked".into());
    }
    if target.role == RelayMemberRole::Admin
        && registry.rooms[room_index]
            .members
            .iter()
            .filter(|member| {
                member.role == RelayMemberRole::Admin && member.revoked_at_ms.is_none()
            })
            .count()
            == 1
    {
        return Err("Relay room must retain one active administrator".into());
    }
    registry.rooms[room_index].members[member_index].revoked_at_ms = Some(now_ms());
    registry.revision = registry
        .revision
        .checked_add(1)
        .ok_or_else(|| "Relay membership revision overflowed".to_string())?;
    save_registry(path, &registry)?;
    Ok(room_report(&registry, &registry.rooms[room_index]))
}

pub fn report_room(path: &Path, room_id: &str) -> Result<RelayRoomMembershipReport, String> {
    if !stable_id(room_id, 32, 128) {
        return Err("Relay room membership input is invalid".into());
    }
    let registry = load_registry(path)?;
    let room = registry
        .rooms
        .iter()
        .find(|room| room.room_id == room_id)
        .ok_or_else(|| "Relay room is not managed by this installation".to_string())?;
    Ok(room_report(&registry, room))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

pub fn authorize_at(
    registry: &RelayMembershipRegistry,
    room_id: &str,
    query: Option<&str>,
    current_time_ms: u64,
) -> Result<RelayAuthorization, String> {
    let Some(room) = registry.rooms.iter().find(|room| room.room_id == room_id) else {
        return Ok(RelayAuthorization::LegacyBearer);
    };
    if query.unwrap_or_default().len() > MAX_AUTH_QUERY_BYTES {
        return Err("Relay member authorization is invalid".into());
    }
    let mut member_id = None;
    let mut capability = None;
    let mut capability_generation = None;
    let mut issued_at_ms = None;
    let mut nonce = None;
    let mut signature = None;
    let mut count = 0usize;
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        count += 1;
        match key.as_ref() {
            "member" if member_id.is_none() => member_id = Some(value.into_owned()),
            "capability" if capability.is_none() => capability = Some(value.into_owned()),
            "generation" if capability_generation.is_none() => {
                capability_generation = Some(value.into_owned())
            }
            "issued" if issued_at_ms.is_none() => issued_at_ms = Some(value.into_owned()),
            "nonce" if nonce.is_none() => nonce = Some(value.into_owned()),
            "signature" if signature.is_none() => signature = Some(value.into_owned()),
            _ => return Err("Relay member authorization is invalid".into()),
        }
    }
    if count < 2 {
        return Err("Relay member authorization is required".into());
    }
    let member_id =
        member_id.ok_or_else(|| "Relay member authorization is required".to_string())?;
    let capability =
        capability.ok_or_else(|| "Relay member authorization is required".to_string())?;
    if !stable_id(&member_id, 16, 128) || !stable_id(&capability, 32, 128) {
        return Err("Relay member authorization is invalid".into());
    }
    let member = room
        .members
        .iter()
        .find(|member| {
            member.member_id == member_id
                && member.revoked_at_ms.is_none()
                && member
                    .expires_at_ms
                    .map(|expires_at_ms| current_time_ms < expires_at_ms)
                    .unwrap_or(true)
        })
        .ok_or_else(|| "Relay member authorization was denied".to_string())?;
    let presented = capability_digest(&capability);
    if !constant_time_eq(presented.as_bytes(), member.capability_sha256.as_bytes()) {
        return Err("Relay member authorization was denied".into());
    }
    let replay = if let Some(device) = &member.device {
        if count != 6 {
            return Err("Relay member signed device authorization is required".into());
        }
        let capability_generation_text = capability_generation
            .ok_or_else(|| "Relay member signed device authorization is required".to_string())?;
        let capability_generation = capability_generation_text
            .parse::<u32>()
            .map_err(|_| "Relay member signed device authorization is invalid".to_string())?;
        let issued_at_text = issued_at_ms
            .ok_or_else(|| "Relay member signed device authorization is required".to_string())?;
        let issued_at_ms = issued_at_text
            .parse::<u64>()
            .map_err(|_| "Relay member signed device authorization is invalid".to_string())?;
        if capability_generation.to_string() != capability_generation_text
            || issued_at_ms.to_string() != issued_at_text
        {
            return Err("Relay member signed device authorization is invalid".into());
        }
        let nonce = nonce
            .ok_or_else(|| "Relay member signed device authorization is required".to_string())?;
        let signature = signature
            .ok_or_else(|| "Relay member signed device authorization is required".to_string())?;
        let expires_at_ms = issued_at_ms
            .checked_add(MAX_SIGNED_AUTH_AGE_MS)
            .ok_or_else(|| "Relay member signed device authorization is invalid".to_string())?;
        let latest_accepted_issue = current_time_ms
            .checked_add(MAX_SIGNED_AUTH_FUTURE_SKEW_MS)
            .unwrap_or(u64::MAX);
        if capability_generation != member.capability_generation
            || issued_at_ms > latest_accepted_issue
            || current_time_ms >= expires_at_ms
        {
            return Err("Relay member signed device authorization was denied".into());
        }
        let claim = RelayAccessIdentityClaim {
            schema_version: 1,
            room_id: room_id.into(),
            member_id: member_id.clone(),
            capability_generation,
            issued_at_ms,
            nonce: nonce.clone(),
            capability: capability.clone(),
        };
        verify_relay_access_signature(&device.public_key, &device.key_id, &claim, &signature)
            .map_err(|_| "Relay member signed device authorization was denied".to_string())?;
        Some(RelayAuthorizationReplay {
            key: format!("{}:{room_id}:{member_id}:{nonce}", device.key_id),
            expires_at_ms,
        })
    } else {
        if count != 2 {
            return Err("Relay member authorization is invalid".into());
        }
        None
    };
    Ok(RelayAuthorization::Member {
        member_id,
        role: member.role,
        replay,
    })
}

pub fn authorize(
    registry: &RelayMembershipRegistry,
    room_id: &str,
    query: Option<&str>,
) -> Result<RelayAuthorization, String> {
    authorize_at(registry, room_id, query, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "syzygy-relay-members-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ))
    }

    fn enrolled_device() -> (RelayDeviceBinding, Ed25519KeyPair) {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let public_key = key_pair.public_key().as_ref();
        let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(public_key));
        (
            RelayDeviceBinding {
                schema_version: 1,
                algorithm: "Ed25519".into(),
                key_id: format!("ed25519-sha256:{digest}"),
                public_key: URL_SAFE_NO_PAD.encode(public_key),
            },
            key_pair,
        )
    }

    fn signed_query(
        credential: &RelayMemberCredential,
        key_pair: &Ed25519KeyPair,
        issued_at_ms: u64,
        nonce: &str,
    ) -> String {
        let claim = RelayAccessIdentityClaim {
            schema_version: 1,
            room_id: credential.room_id.clone(),
            member_id: credential.member_id.clone(),
            capability_generation: credential.capability_generation,
            issued_at_ms,
            nonce: nonce.into(),
            capability: credential.capability.clone(),
        };
        let message = crate::collaboration_identity::canonical_relay_access_claim(&claim).unwrap();
        let signature = URL_SAFE_NO_PAD.encode(key_pair.sign(&message).as_ref());
        format!(
            "member={}&capability={}&generation={}&issued={}&nonce={}&signature={}",
            credential.member_id,
            credential.capability,
            credential.capability_generation,
            issued_at_ms,
            nonce,
            signature,
        )
    }

    #[test]
    fn creates_digest_only_credentials_and_enforces_roles_and_revocation() {
        let directory = directory("lifecycle");
        let path = registry_path(&directory);
        let room_id = "r".repeat(32);
        let (admin, initial) = create_room(&path, "project-a", &room_id, None).unwrap();
        let bytes = fs::read_to_string(&path).unwrap();
        assert!(!bytes.contains(&admin.capability));
        assert!(matches!(
            authorize(
                &load_registry(&path).unwrap(),
                &room_id,
                Some(&format!(
                    "member={}&capability={}",
                    admin.member_id, admin.capability
                ))
            )
            .unwrap(),
            RelayAuthorization::Member {
                role: RelayMemberRole::Admin,
                ..
            }
        ));
        let (viewer, report) = issue_member(
            &path,
            &room_id,
            initial.registry_revision,
            RelayMemberRole::Viewer,
            None,
            None,
        )
        .unwrap();
        assert!(!viewer.role.can_write());
        assert_eq!(report.members.len(), 2);
        let revoked =
            revoke_member(&path, &room_id, &viewer.member_id, report.registry_revision).unwrap();
        assert!(authorize(
            &load_registry(&path).unwrap(),
            &room_id,
            Some(&format!(
                "member={}&capability={}",
                viewer.member_id, viewer.capability
            ))
        )
        .is_err());
        assert!(
            revoke_member(&path, &room_id, &admin.member_id, revoked.registry_revision)
                .unwrap_err()
                .contains("retain one active administrator")
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn expires_and_rotates_capabilities_without_reusing_member_identity() {
        let directory = directory("rotation");
        let path = registry_path(&directory);
        let room_id = "x".repeat(32);
        let (_, initial) = create_room(&path, "project-a", &room_id, None).unwrap();
        let (editor, report) = issue_member(
            &path,
            &room_id,
            initial.registry_revision,
            RelayMemberRole::Editor,
            Some(MIN_EXPIRY_SECONDS),
            None,
        )
        .unwrap();
        let original_query = format!(
            "member={}&capability={}",
            editor.member_id, editor.capability
        );
        let original_expiry = editor.expires_at_ms.unwrap();
        assert!(authorize_at(
            &load_registry(&path).unwrap(),
            &room_id,
            Some(&original_query),
            original_expiry - 1,
        )
        .is_ok());
        assert!(authorize_at(
            &load_registry(&path).unwrap(),
            &room_id,
            Some(&original_query),
            original_expiry,
        )
        .is_err());
        let (rotated, rotated_report) = rotate_member(
            &path,
            &room_id,
            &editor.member_id,
            report.registry_revision,
            None,
            None,
        )
        .unwrap();
        assert_eq!(rotated.member_id, editor.member_id);
        assert_eq!(rotated.role, editor.role);
        assert_eq!(rotated.capability_generation, 2);
        assert_eq!(rotated.expires_at_ms, None);
        assert!(authorize(
            &load_registry(&path).unwrap(),
            &room_id,
            Some(&original_query)
        )
        .is_err());
        assert!(authorize(
            &load_registry(&path).unwrap(),
            &room_id,
            Some(&format!(
                "member={}&capability={}",
                rotated.member_id, rotated.capability
            )),
        )
        .is_ok());
        let stored = fs::read_to_string(&path).unwrap();
        assert!(!stored.contains(&editor.capability));
        assert!(!stored.contains(&rotated.capability));
        assert_eq!(rotated_report.members[1].capability_generation, 2);
        assert!(rotated_report.members[1].rotated_at_ms.is_some());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn enrolled_member_requires_fresh_signed_device_proof_and_preserves_binding_on_rotation() {
        let directory = directory("signed-device");
        let path = registry_path(&directory);
        let room_id = "s".repeat(32);
        let (_, initial) = create_room(&path, "project-a", &room_id, None).unwrap();
        let (device, key_pair) = enrolled_device();
        let (viewer, report) = issue_member(
            &path,
            &room_id,
            initial.registry_revision,
            RelayMemberRole::Viewer,
            None,
            Some(device.clone()),
        )
        .unwrap();
        assert_eq!(viewer.schema_version, BOUND_CREDENTIAL_SCHEMA_VERSION);
        assert_eq!(
            viewer.device_key_id.as_deref(),
            Some(device.key_id.as_str())
        );
        assert_eq!(
            report.members[1].device_key_id.as_deref(),
            Some(device.key_id.as_str())
        );
        assert!(authorize(
            &load_registry(&path).unwrap(),
            &room_id,
            Some(&format!(
                "member={}&capability={}",
                viewer.member_id, viewer.capability
            )),
        )
        .unwrap_err()
        .contains("signed device"));

        let current_time_ms = now_ms();
        let nonce = "n4FQe-J9xYRu0cXm1pWd7gHo2Lk8BvSz5TaUcEiOjM0";
        let query = signed_query(&viewer, &key_pair, current_time_ms, nonce);
        let authorization = authorize_at(
            &load_registry(&path).unwrap(),
            &room_id,
            Some(&query),
            current_time_ms,
        )
        .unwrap();
        assert!(matches!(
            authorization,
            RelayAuthorization::Member {
                role: RelayMemberRole::Viewer,
                replay: Some(_),
                ..
            }
        ));
        assert!(authorize_at(
            &load_registry(&path).unwrap(),
            &room_id,
            Some(&query),
            current_time_ms + MAX_SIGNED_AUTH_AGE_MS,
        )
        .is_err());
        assert!(authorize_at(
            &load_registry(&path).unwrap(),
            &room_id,
            Some(&query.replace("generation=1", "generation=01")),
            current_time_ms,
        )
        .is_err());

        let (rotated, _) = rotate_member(
            &path,
            &room_id,
            &viewer.member_id,
            report.registry_revision,
            None,
            None,
        )
        .unwrap();
        assert_eq!(rotated.schema_version, BOUND_CREDENTIAL_SCHEMA_VERSION);
        assert_eq!(
            rotated.device_key_id.as_deref(),
            Some(device.key_id.as_str())
        );
        assert!(authorize(&load_registry(&path).unwrap(), &room_id, Some(&query),).is_err());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn missing_registry_is_legacy_but_registered_rooms_fail_closed() {
        let directory = directory("compatibility");
        let path = registry_path(&directory);
        let room_id = "m".repeat(32);
        assert_eq!(
            authorize(&load_registry(&path).unwrap(), &room_id, None).unwrap(),
            RelayAuthorization::LegacyBearer
        );
        create_room(&path, "project-a", &room_id, None).unwrap();
        let registry = load_registry(&path).unwrap();
        assert!(authorize(&registry, &room_id, None).is_err());
        assert!(authorize(&registry, &room_id, Some("member=x&capability=y")).is_err());
        assert_eq!(
            authorize(&registry, &"z".repeat(32), None).unwrap(),
            RelayAuthorization::LegacyBearer
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn stale_and_malformed_mutations_leave_registry_unchanged() {
        let directory = directory("guards");
        let path = registry_path(&directory);
        let room_id = "g".repeat(32);
        let (_, report) = create_room(&path, "project-a", &room_id, None).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(issue_member(
            &path,
            &room_id,
            report.registry_revision + 1,
            RelayMemberRole::Editor,
            None,
            None,
        )
        .unwrap_err()
        .contains("changed"));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(issue_member(
            &path,
            &room_id,
            report.registry_revision,
            RelayMemberRole::Editor,
            Some(MIN_EXPIRY_SECONDS - 1),
            None,
        )
        .unwrap_err()
        .contains("five minutes"));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(issue_member(
            &path,
            "short",
            report.registry_revision,
            RelayMemberRole::Editor,
            None,
            None,
        )
        .is_err());
        assert!(revoke_member(&path, &room_id, "short", report.registry_revision).is_err());
        assert!(rotate_member(
            &path,
            &room_id,
            "short",
            report.registry_revision,
            None,
            None,
        )
        .is_err());
        assert!(authorize(
            &load_registry(&path).unwrap(),
            &room_id,
            Some(&"x".repeat(MAX_AUTH_QUERY_BYTES + 1))
        )
        .is_err());
        fs::write(
            &path,
            br#"{"schemaVersion":1,"revision":1,"rooms":[],"authority":"all"}"#,
        )
        .unwrap();
        assert!(load_registry(&path).is_err());
        let _ = fs::remove_dir_all(directory);
    }
}

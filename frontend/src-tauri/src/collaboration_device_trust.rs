//! Local, project-scoped approval state for self-signed collaboration device keys.
//!
//! This registry is a per-installation user preference. It does not grant relay access, create a
//! shared role, authenticate a person, or become part of a project/archive. Mutations use an exact
//! expected-state guard and a crash-recoverable replace sequence.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const REGISTRY_FILE: &str = "collaboration-device-trust-v1.json";
const REGISTRY_SCHEMA_VERSION: u8 = 1;
const DECISION_SCHEMA_VERSION: u8 = 1;
const MAX_REGISTRY_BYTES: usize = 1024 * 1024;
const MAX_PROJECTS: usize = 64;
const MAX_DEVICES_PER_PROJECT: usize = 64;
const SCOPE: &str = "local-installation-project-device-key-only";
static TRUST_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceTrustStatus {
    Unapproved,
    Approved,
    Revoked,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceTrustAction {
    Approve,
    Revoke,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDecision {
    schema_version: u8,
    status: DeviceTrustStatus,
    updated_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustRegistry {
    schema_version: u8,
    projects: BTreeMap<String, BTreeMap<String, StoredDecision>>,
}

impl Default for TrustRegistry {
    fn default() -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            projects: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTrustDecision {
    pub key_id: String,
    pub status: DeviceTrustStatus,
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTrustReport {
    pub schema_version: u8,
    pub project_id: String,
    pub scope: String,
    pub decisions: Vec<DeviceTrustDecision>,
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

fn stable_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 200
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'-')
        })
}

fn valid_key_id(value: &str) -> bool {
    let Some(encoded) = value.strip_prefix("ed25519-sha256:") else {
        return false;
    };
    let Ok(decoded) = URL_SAFE_NO_PAD.decode(encoded) else {
        return false;
    };
    decoded.len() == 32 && URL_SAFE_NO_PAD.encode(decoded) == encoded
}

fn validate_registry(registry: &TrustRegistry) -> Result<(), String> {
    if registry.schema_version != REGISTRY_SCHEMA_VERSION || registry.projects.len() > MAX_PROJECTS
    {
        return Err("Saved collaboration device approvals are invalid".into());
    }
    for (project_id, decisions) in &registry.projects {
        if !stable_id(project_id) || decisions.len() > MAX_DEVICES_PER_PROJECT {
            return Err("Saved collaboration device approvals are invalid".into());
        }
        for (key_id, decision) in decisions {
            if !valid_key_id(key_id)
                || decision.schema_version != DECISION_SCHEMA_VERSION
                || decision.status == DeviceTrustStatus::Unapproved
                || decision.updated_at_ms == 0
            {
                return Err("Saved collaboration device approvals are invalid".into());
            }
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

fn read_registry_file(path: &Path) -> Result<TrustRegistry, String> {
    let metadata = fs::metadata(path)
        .map_err(|_| "Could not read collaboration device approvals".to_string())?;
    if metadata.len() > MAX_REGISTRY_BYTES as u64 {
        return Err("Saved collaboration device approvals are invalid".into());
    }
    let bytes =
        fs::read(path).map_err(|_| "Could not read collaboration device approvals".to_string())?;
    let registry: TrustRegistry = serde_json::from_slice(&bytes)
        .map_err(|_| "Saved collaboration device approvals are invalid".to_string())?;
    validate_registry(&registry)?;
    Ok(registry)
}

fn load_registry(path: &Path) -> Result<TrustRegistry, String> {
    if path.exists() {
        return read_registry_file(path);
    }
    let previous = previous_path(path);
    if previous.exists() {
        return read_registry_file(&previous);
    }
    Ok(TrustRegistry::default())
}

fn save_registry(path: &Path, registry: &TrustRegistry) -> Result<(), String> {
    validate_registry(registry)?;
    let bytes = serde_json::to_vec_pretty(registry)
        .map_err(|_| "Could not encode collaboration device approvals".to_string())?;
    if bytes.len() > MAX_REGISTRY_BYTES {
        return Err("Collaboration device approvals reached their storage limit".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Collaboration device approval path has no parent folder".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "Could not create the Syzygy data folder".to_string())?;
    let temporary = temporary_path(path);
    let previous = previous_path(path);
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| "Could not write collaboration device approvals".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not write collaboration device approvals".to_string())?;
    drop(file);

    if previous.exists() {
        fs::remove_file(&previous)
            .map_err(|_| "Could not prepare collaboration device approval recovery".to_string())?;
    }
    if path.exists() {
        fs::rename(path, &previous)
            .map_err(|_| "Could not prepare collaboration device approval recovery".to_string())?;
    }
    if fs::rename(&temporary, path).is_err() {
        if previous.exists() && !path.exists() {
            let _ = fs::rename(&previous, path);
        }
        return Err("Could not finish saving collaboration device approvals".into());
    }
    if previous.exists() {
        // The primary file is already complete and always wins on read. A stale recovery copy is
        // harmless and the next save retries its removal; do not report a false mutation failure.
        let _ = fs::remove_file(previous);
    }
    Ok(())
}

fn current_status(registry: &TrustRegistry, project_id: &str, key_id: &str) -> DeviceTrustStatus {
    registry
        .projects
        .get(project_id)
        .and_then(|project| project.get(key_id))
        .map(|decision| decision.status)
        .unwrap_or(DeviceTrustStatus::Unapproved)
}

fn report(registry: &TrustRegistry, project_id: &str) -> DeviceTrustReport {
    let decisions = registry
        .projects
        .get(project_id)
        .into_iter()
        .flat_map(|project| project.iter())
        .map(|(key_id, decision)| DeviceTrustDecision {
            key_id: key_id.clone(),
            status: decision.status,
            updated_at_ms: decision.updated_at_ms,
        })
        .collect();
    DeviceTrustReport {
        schema_version: REGISTRY_SCHEMA_VERSION,
        project_id: project_id.into(),
        scope: SCOPE.into(),
        decisions,
    }
}

fn change(
    path: &Path,
    project_id: &str,
    key_id: &str,
    expected_status: DeviceTrustStatus,
    action: DeviceTrustAction,
) -> Result<DeviceTrustReport, String> {
    if !stable_id(project_id) || !valid_key_id(key_id) {
        return Err("Collaboration device approval input is invalid".into());
    }
    let mut registry = load_registry(path)?;
    if current_status(&registry, project_id, key_id) != expected_status {
        return Err("Collaboration device approval changed; refresh and try again".into());
    }
    let next_status = match (expected_status, action) {
        (
            DeviceTrustStatus::Unapproved | DeviceTrustStatus::Revoked,
            DeviceTrustAction::Approve,
        ) => DeviceTrustStatus::Approved,
        (DeviceTrustStatus::Approved, DeviceTrustAction::Revoke) => DeviceTrustStatus::Revoked,
        _ => return Err("Collaboration device approval transition is invalid".into()),
    };
    if !registry.projects.contains_key(project_id) && registry.projects.len() >= MAX_PROJECTS {
        return Err("Collaboration device approvals reached their project limit".into());
    }
    let project = registry.projects.entry(project_id.into()).or_default();
    if !project.contains_key(key_id) && project.len() >= MAX_DEVICES_PER_PROJECT {
        return Err("Collaboration device approvals reached this project's device limit".into());
    }
    project.insert(
        key_id.into(),
        StoredDecision {
            schema_version: DECISION_SCHEMA_VERSION,
            status: next_status,
            updated_at_ms: now_ms(),
        },
    );
    save_registry(path, &registry)?;
    Ok(report(&registry, project_id))
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(REGISTRY_FILE))
        .map_err(|_| "Could not locate the Syzygy data folder".to_string())
}

#[tauri::command]
pub fn collaboration_device_trust_status(
    app: AppHandle,
    project_id: String,
) -> Result<DeviceTrustReport, String> {
    if !stable_id(&project_id) {
        return Err("Collaboration device approval input is invalid".into());
    }
    let _guard = TRUST_LOCK
        .lock()
        .map_err(|_| "Collaboration device approvals are unavailable".to_string())?;
    let registry = load_registry(&registry_path(&app)?)?;
    Ok(report(&registry, &project_id))
}

#[tauri::command]
pub fn collaboration_device_trust_change(
    app: AppHandle,
    project_id: String,
    key_id: String,
    expected_status: DeviceTrustStatus,
    action: DeviceTrustAction,
) -> Result<DeviceTrustReport, String> {
    let _guard = TRUST_LOCK
        .lock()
        .map_err(|_| "Collaboration device approvals are unavailable".to_string())?;
    change(
        &registry_path(&app)?,
        &project_id,
        &key_id,
        expected_status,
        action,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "syzygy-device-trust-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ))
    }

    fn key_id(seed: u16) -> String {
        let digest = Sha256::digest(seed.to_be_bytes());
        format!("ed25519-sha256:{}", URL_SAFE_NO_PAD.encode(digest))
    }

    #[test]
    fn approval_revocation_and_reapproval_are_project_scoped_and_stale_guarded() {
        let directory = directory("lifecycle");
        let path = directory.join(REGISTRY_FILE);
        let key = key_id(1);
        let approved = change(
            &path,
            "project-a",
            &key,
            DeviceTrustStatus::Unapproved,
            DeviceTrustAction::Approve,
        )
        .unwrap();
        assert_eq!(approved.decisions[0].status, DeviceTrustStatus::Approved);
        assert_eq!(
            report(&load_registry(&path).unwrap(), "project-b")
                .decisions
                .len(),
            0
        );
        assert!(change(
            &path,
            "project-a",
            &key,
            DeviceTrustStatus::Unapproved,
            DeviceTrustAction::Approve,
        )
        .unwrap_err()
        .contains("changed"));
        let revoked = change(
            &path,
            "project-a",
            &key,
            DeviceTrustStatus::Approved,
            DeviceTrustAction::Revoke,
        )
        .unwrap();
        assert_eq!(revoked.decisions[0].status, DeviceTrustStatus::Revoked);
        let reapproved = change(
            &path,
            "project-a",
            &key,
            DeviceTrustStatus::Revoked,
            DeviceTrustAction::Approve,
        )
        .unwrap();
        assert_eq!(reapproved.decisions[0].status, DeviceTrustStatus::Approved);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn malformed_primary_fails_closed_and_missing_primary_recovers_previous() {
        let directory = directory("recovery");
        let path = directory.join(REGISTRY_FILE);
        let key = key_id(2);
        change(
            &path,
            "project-a",
            &key,
            DeviceTrustStatus::Unapproved,
            DeviceTrustAction::Approve,
        )
        .unwrap();
        let valid = fs::read(&path).unwrap();
        fs::write(previous_path(&path), br#"{\"invalid\":true}"#).unwrap();
        assert_eq!(
            current_status(&load_registry(&path).unwrap(), "project-a", &key),
            DeviceTrustStatus::Approved
        );
        fs::write(
            &path,
            br#"{"schemaVersion":1,"projects":{},"authority":"admin"}"#,
        )
        .unwrap();
        assert_eq!(
            load_registry(&path).unwrap_err(),
            "Saved collaboration device approvals are invalid"
        );
        fs::remove_file(&path).unwrap();
        fs::write(previous_path(&path), valid).unwrap();
        assert_eq!(
            current_status(&load_registry(&path).unwrap(), "project-a", &key),
            DeviceTrustStatus::Approved
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn invalid_inputs_and_per_project_bounds_leave_saved_bytes_unchanged() {
        let directory = directory("bounds");
        let path = directory.join(REGISTRY_FILE);
        assert!(change(
            &path,
            "../project",
            &key_id(1),
            DeviceTrustStatus::Unapproved,
            DeviceTrustAction::Approve,
        )
        .is_err());
        assert!(change(
            &path,
            "project-a",
            "ed25519-sha256:weak",
            DeviceTrustStatus::Unapproved,
            DeviceTrustAction::Approve,
        )
        .is_err());
        for seed in 0..MAX_DEVICES_PER_PROJECT as u16 {
            change(
                &path,
                "project-a",
                &key_id(seed),
                DeviceTrustStatus::Unapproved,
                DeviceTrustAction::Approve,
            )
            .unwrap();
        }
        let before = fs::read(&path).unwrap();
        assert!(change(
            &path,
            "project-a",
            &key_id(MAX_DEVICES_PER_PROJECT as u16 + 1),
            DeviceTrustStatus::Unapproved,
            DeviceTrustAction::Approve,
        )
        .unwrap_err()
        .contains("device limit"));
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn project_bound_rejects_an_extra_project_without_changing_saved_bytes() {
        let directory = directory("project-bound");
        let path = directory.join(REGISTRY_FILE);
        let key = key_id(3);
        for index in 0..MAX_PROJECTS {
            change(
                &path,
                &format!("project-{index}"),
                &key,
                DeviceTrustStatus::Unapproved,
                DeviceTrustAction::Approve,
            )
            .unwrap();
        }
        let before = fs::read(&path).unwrap();
        assert!(change(
            &path,
            "project-overflow",
            &key,
            DeviceTrustStatus::Unapproved,
            DeviceTrustAction::Approve,
        )
        .unwrap_err()
        .contains("project limit"));
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::remove_dir_all(directory).unwrap();
    }
}

//! Append-only Google Drive transport for collaborative Yjs project updates and shared titles.
//! Active updates are immutable files. Shared titles are a bounded content-addressed parent graph,
//! so concurrent renames remain visible until an explicit all-tip reconciliation. Explicit bounded
//! compaction first appends a complete Yjs snapshot, then moves only records the live caller has
//! applied into a recoverable archive folder. Concurrent writers never replace one another; Yjs
//! remains the document merge authority and local IndexedDB remains the offline durability layer.

use crate::google_drive::{
    collaboration_access, folder_metadata, selected_workspace_access, DriveWorkspace,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::time::Duration;

const FILES_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_ENDPOINT: &str = "https://www.googleapis.com/upload/drive/v3/files";
const PROJECTS_FOLDER: &str = ".syzygy-projects";
const MANIFEST_FILE: &str = "manifest.json";
const UPDATES_FOLDER: &str = "updates";
const COMPACTED_UPDATES_FOLDER: &str = "compacted-updates";
const TITLE_EVENT_PREFIX: &str = "title-event-";
const TITLE_SNAPSHOT_PREFIX: &str = "title-snapshot-";
const COMPACTED_TITLE_HISTORY_FOLDER: &str = "compacted-title-history";
const QUARANTINED_TITLE_HISTORY_FOLDER: &str = "quarantined-title-history";
const MAX_UPDATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PULL_BYTES: usize = 32 * 1024 * 1024;
const MAX_UPDATE_FILES: usize = 5_000;
const MAX_KNOWN_IDS: usize = 10_000;
const MAX_LISTED_FILES: usize = 10_000;
const MAX_COMPACTION_BATCH: usize = 200;
const COMPACTION_CONCURRENCY: usize = 8;
const DRIVE_REQUEST_TIMEOUT_SECONDS: u64 = 30;
const COMPACTION_ARCHIVE_DEADLINE_SECONDS: u64 = 60;
const MAX_TITLE_EVENTS: usize = 200;
const MAX_TITLE_EVENT_READS: usize = 400;
const MAX_TITLE_PARENTS: usize = 20;
const MAX_TITLE_HISTORY_EVENTS: usize = 5_000;
const MAX_TITLE_SNAPSHOTS: usize = 8;
const MAX_TITLE_REPAIR_ACTIVE_FILES: usize = 501;
const MAX_TITLE_REPAIR_ARCHIVE_FILES: usize = 5_200;
const MAX_TITLE_REPAIR_QUARANTINE_FILES: usize = 5_200;
const MAX_TITLE_REPAIR_SNAPSHOTS: usize = 64;
const MAX_TITLE_REPAIR_BYTES: usize = 32 * 1024 * 1024;
const TITLE_REPAIR_DEADLINE_SECONDS: u64 = 120;
const MAX_PROJECT_ROOTS: usize = 200;
const MAX_DISCOVERED_PROJECTS: usize = 1_000;
const PROJECT_CATALOG_CONCURRENCY: usize = 8;
const PROJECT_CATALOG_DEADLINE_SECONDS: u64 = 12;
const _: () = assert!(
    PROJECT_CATALOG_DEADLINE_SECONDS < crate::automation::AUTOMATION_RESPONSE_TIMEOUT_SECONDS
);

fn esc(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

fn drive_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(DRIVE_REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| format!("Drive project HTTP client could not start: {error}"))
}

async fn with_drive_project_deadline<T, F>(
    operation: &str,
    deadline: Duration,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    tokio::time::timeout(deadline, future).await.map_err(|_| {
        let deadline_label = if deadline.as_secs() > 0 {
            format!("{}-second", deadline.as_secs())
        } else {
            format!("{}-millisecond", deadline.as_millis())
        };
        format!(
            "Drive project {operation} exceeded its {deadline_label} deadline; retry after checking the connection."
        )
    })?
}

async fn with_project_catalog_deadline<T, F>(operation: &str, future: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    with_drive_project_deadline(
        operation,
        Duration::from_secs(PROJECT_CATALOG_DEADLINE_SECONDS),
        future,
    )
    .await
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn validate_identity(label: &str, value: &str) -> Result<(), String> {
    if valid_identity(value) {
        Ok(())
    } else {
        Err(format!("Drive project {label} is invalid."))
    }
}

async fn require_success(
    response: reqwest::Response,
    operation: &str,
) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("Google returned HTTP {status}"));
    Err(format!(
        "Drive project {operation} failed: {message} (HTTP {status})"
    ))
}

async fn response_json(
    response: reqwest::Response,
    operation: &str,
) -> Result<serde_json::Value, String> {
    require_success(response, operation)
        .await?
        .json()
        .await
        .map_err(|error| format!("Drive project {operation} returned unreadable JSON: {error}"))
}

async fn find_child(
    token: &str,
    parent_id: &str,
    name: &str,
    mime_type: Option<&str>,
) -> Result<Option<String>, String> {
    let mime = mime_type
        .map(|value| format!(" and mimeType = '{}'", esc(value)))
        .unwrap_or_default();
    let query = format!(
        "name = '{}' and '{}' in parents and trashed = false{}",
        esc(name),
        esc(parent_id),
        mime
    );
    let response = drive_client()?
        .get(FILES_ENDPOINT)
        .bearer_auth(token)
        .query(&[
            ("q", query.as_str()),
            ("fields", "files(id)"),
            ("pageSize", "3"),
            ("supportsAllDrives", "true"),
            ("includeItemsFromAllDrives", "true"),
        ])
        .send()
        .await
        .map_err(|error| format!("Drive project lookup failed before Google responded: {error}"))?;
    let value = response_json(response, "lookup").await?;
    let files = value["files"].as_array().cloned().unwrap_or_default();
    if files.len() > 1 {
        return Err(format!(
            "Drive project storage contains duplicate entries named {name:?}; resolve them before syncing."
        ));
    }
    Ok(files
        .first()
        .and_then(|file| file["id"].as_str())
        .map(str::to_string))
}

async fn create_folder(token: &str, parent_id: &str, name: &str) -> Result<String, String> {
    let response = drive_client()?
        .post(FILES_ENDPOINT)
        .bearer_auth(token)
        .query(&[("supportsAllDrives", "true"), ("fields", "id")])
        .json(&serde_json::json!({
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id],
        }))
        .send()
        .await
        .map_err(|error| {
            format!("Drive project folder creation failed before Google responded: {error}")
        })?;
    let value = response_json(response, "folder creation").await?;
    value["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Drive project folder creation returned no file id.".to_string())
}

async fn find_or_create_folder(token: &str, parent_id: &str, name: &str) -> Result<String, String> {
    if let Some(id) = find_child(
        token,
        parent_id,
        name,
        Some("application/vnd.google-apps.folder"),
    )
    .await?
    {
        return Ok(id);
    }
    create_folder(token, parent_id, name).await
}

async fn create_text_file(
    token: &str,
    parent_id: &str,
    name: &str,
    content: &str,
) -> Result<String, String> {
    let metadata = serde_json::json!({ "name": name, "parents": [parent_id] }).to_string();
    let form = reqwest::multipart::Form::new()
        .part(
            "metadata",
            reqwest::multipart::Part::text(metadata)
                .mime_str("application/json")
                .map_err(|error| error.to_string())?,
        )
        .part(
            "media",
            reqwest::multipart::Part::text(content.to_string())
                .mime_str("application/json")
                .map_err(|error| error.to_string())?,
        );
    let response = drive_client()?
        .post(UPLOAD_ENDPOINT)
        .bearer_auth(token)
        .query(&[
            ("uploadType", "multipart"),
            ("fields", "id"),
            ("supportsAllDrives", "true"),
        ])
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            format!("Drive project record creation failed before Google responded: {error}")
        })?;
    let value = response_json(response, "record creation").await?;
    value["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Drive project record creation returned no file id.".to_string())
}

async fn create_metadata_record(
    token: &str,
    parent_id: &str,
    name: &str,
    description: &str,
) -> Result<String, String> {
    let response = drive_client()?
        .post(FILES_ENDPOINT)
        .bearer_auth(token)
        .query(&[("fields", "id"), ("supportsAllDrives", "true")])
        .json(&serde_json::json!({
            "name": name,
            "mimeType": "application/json",
            "description": description,
            "parents": [parent_id],
        }))
        .send()
        .await
        .map_err(|error| {
            format!("Drive project metadata creation failed before Google responded: {error}")
        })?;
    let value = response_json(response, "metadata creation").await?;
    value["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Drive project metadata creation returned no file id.".to_string())
}

async fn read_text_file(token: &str, file_id: &str) -> Result<String, String> {
    let response = drive_client()?
        .get(format!("{FILES_ENDPOINT}/{file_id}"))
        .bearer_auth(token)
        .query(&[("alt", "media"), ("supportsAllDrives", "true")])
        .send()
        .await
        .map_err(|error| format!("Drive project read failed before Google responded: {error}"))?;
    let bytes = require_success(response, "read")
        .await?
        .bytes()
        .await
        .map_err(|error| format!("Drive project read returned unreadable content: {error}"))?;
    if bytes.len() > MAX_UPDATE_BYTES * 2 {
        return Err("Drive project record exceeds the supported size limit.".into());
    }
    String::from_utf8(bytes.to_vec())
        .map_err(|_| "Drive project record is not valid UTF-8 JSON.".into())
}

async fn move_file_to_folder(
    token: &str,
    file_id: &str,
    from_parent_id: &str,
    to_parent_id: &str,
) -> Result<(), String> {
    let response = drive_client()?
        .patch(format!("{FILES_ENDPOINT}/{file_id}"))
        .bearer_auth(token)
        .query(&[
            ("addParents", to_parent_id),
            ("removeParents", from_parent_id),
            ("supportsAllDrives", "true"),
            ("fields", "id,parents"),
        ])
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|error| {
            format!("Drive project archive move failed before Google responded: {error}")
        })?;
    require_success(response, "archive update").await?;
    Ok(())
}

#[derive(Clone, Debug)]
struct ListedFile {
    id: String,
    name: String,
    size: usize,
    description: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct CompactionPlan {
    archive_ids: Vec<String>,
    remaining_included_count: usize,
    retained_concurrent_count: usize,
}

struct CompactionArchiveOutcome {
    active_update_count_before: usize,
    active_update_count_after: usize,
    archived_update_count: usize,
    failed_archive_count: usize,
    remaining_included_update_count: usize,
    retained_concurrent_update_count: usize,
}

fn plan_compaction(
    listed: &[ListedFile],
    included: &HashSet<String>,
    snapshot_update_id: &str,
) -> CompactionPlan {
    let eligible = listed
        .iter()
        .filter(|file| {
            file.name.starts_with("update-")
                && file.id != snapshot_update_id
                && included.contains(&file.id)
        })
        .map(|file| file.id.clone())
        .collect::<Vec<_>>();
    let retained_concurrent_count = listed
        .iter()
        .filter(|file| {
            file.name.starts_with("update-")
                && file.id != snapshot_update_id
                && !included.contains(&file.id)
        })
        .count();
    CompactionPlan {
        archive_ids: eligible
            .iter()
            .take(MAX_COMPACTION_BATCH)
            .cloned()
            .collect(),
        remaining_included_count: eligible.len().saturating_sub(MAX_COMPACTION_BATCH),
        retained_concurrent_count,
    }
}

async fn list_children(token: &str, parent_id: &str) -> Result<Vec<ListedFile>, String> {
    list_children_filtered(
        token,
        parent_id,
        None,
        false,
        MAX_LISTED_FILES,
        "Drive folder contains too many records to inspect safely.",
    )
    .await
}

async fn list_title_event_files(token: &str, parent_id: &str) -> Result<Vec<ListedFile>, String> {
    list_children_filtered(
        token,
        parent_id,
        Some(TITLE_EVENT_PREFIX),
        true,
        MAX_TITLE_EVENT_READS,
        "Drive project contains too many shared title events to inspect safely.",
    )
    .await
}

async fn list_title_snapshot_files(
    token: &str,
    parent_id: &str,
) -> Result<Vec<ListedFile>, String> {
    list_children_filtered(
        token,
        parent_id,
        Some(TITLE_SNAPSHOT_PREFIX),
        false,
        MAX_TITLE_SNAPSHOTS,
        "Drive project contains too many active title snapshots to inspect safely.",
    )
    .await
}

async fn list_children_filtered(
    token: &str,
    parent_id: &str,
    name_contains: Option<&str>,
    include_description: bool,
    max_files: usize,
    limit_error: &str,
) -> Result<Vec<ListedFile>, String> {
    let mut query = format!("'{}' in parents and trashed = false", esc(parent_id));
    if let Some(fragment) = name_contains {
        query.push_str(&format!(" and name contains '{}'", esc(fragment)));
    }
    let fields = if include_description {
        "nextPageToken,files(id,name,size,description)"
    } else {
        "nextPageToken,files(id,name,size)"
    };
    let mut page_token: Option<String> = None;
    let mut files = Vec::new();
    loop {
        let mut request = drive_client()?
            .get(FILES_ENDPOINT)
            .bearer_auth(token)
            .query(&[
                ("q", query.as_str()),
                ("fields", fields),
                ("pageSize", "1000"),
                ("supportsAllDrives", "true"),
                ("includeItemsFromAllDrives", "true"),
            ]);
        if let Some(token) = page_token.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }
        let response = request.send().await.map_err(|error| {
            format!("Drive project listing failed before Google responded: {error}")
        })?;
        let value = response_json(response, "listing").await?;
        if let Some(page) = value["files"].as_array() {
            for file in page {
                let Some(id) = file["id"].as_str() else {
                    continue;
                };
                let Some(name) = file["name"].as_str() else {
                    continue;
                };
                let size = file["size"]
                    .as_str()
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                files.push(ListedFile {
                    id: id.to_string(),
                    name: name.to_string(),
                    size,
                    description: include_description
                        .then(|| file["description"].as_str().map(str::to_string))
                        .flatten(),
                });
                if files.len() > max_files {
                    return Err(limit_error.into());
                }
            }
        }
        page_token = value["nextPageToken"].as_str().map(str::to_string);
        if page_token.is_none() {
            break;
        }
    }
    Ok(files)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProjectManifest {
    schema_version: u8,
    project_id: String,
    document_id: String,
    title: String,
    created_at: u64,
}

impl StoredProjectManifest {
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("Drive project manifest uses an unsupported schema version.".into());
        }
        validate_identity("id", &self.project_id)?;
        validate_identity("document id", &self.document_id)?;
        if self.title.trim().is_empty() || self.title.chars().count() > 200 {
            return Err("Drive project title is invalid.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProjectTitleEvent {
    schema_version: u8,
    project_id: String,
    document_id: String,
    parent_revisions: Vec<String>,
    title: String,
    participant_id: String,
    display_name: String,
    timestamp: u64,
}

impl StoredProjectTitleEvent {
    fn validate_for(&self, manifest: &StoredProjectManifest) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("Drive project title event uses an unsupported schema version.".into());
        }
        if self.project_id != manifest.project_id || self.document_id != manifest.document_id {
            return Err("Drive project title event identity does not match its manifest.".into());
        }
        validate_identity("title participant id", &self.participant_id)?;
        if self.title.trim().is_empty() || self.title.chars().count() > 200 {
            return Err("Drive project shared title is invalid.".into());
        }
        if self.display_name.trim().is_empty() || self.display_name.chars().count() > 200 {
            return Err("Drive project title author name is invalid.".into());
        }
        if self.timestamp == 0
            || self.parent_revisions.len() > MAX_TITLE_PARENTS
            || self
                .parent_revisions
                .iter()
                .any(|revision| !valid_sha256(revision))
        {
            return Err("Drive project title event metadata is invalid or too large.".into());
        }
        let mut canonical_parents = self.parent_revisions.clone();
        canonical_parents.sort();
        canonical_parents.dedup();
        if canonical_parents != self.parent_revisions {
            return Err("Drive project title event parents must be unique and sorted.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProjectTitleSnapshot {
    schema_version: u8,
    project_id: String,
    document_id: String,
    events: Vec<StoredProjectTitleEvent>,
}

impl StoredProjectTitleSnapshot {
    fn new(
        manifest: &StoredProjectManifest,
        events: &HashMap<String, StoredProjectTitleEvent>,
    ) -> Result<Self, String> {
        if events.is_empty() {
            return Err("Drive project title history has no events to retain.".into());
        }
        let mut ordered = events
            .iter()
            .map(|(revision, event)| (revision.clone(), event.clone()))
            .collect::<Vec<_>>();
        ordered.sort_by(|left, right| left.0.cmp(&right.0));
        let snapshot = Self {
            schema_version: 1,
            project_id: manifest.project_id.clone(),
            document_id: manifest.document_id.clone(),
            events: ordered.into_iter().map(|(_, event)| event).collect(),
        };
        snapshot.validate_for(manifest)?;
        Ok(snapshot)
    }

    fn validate_for(&self, manifest: &StoredProjectManifest) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("Drive project title snapshot uses an unsupported schema version.".into());
        }
        if self.project_id != manifest.project_id || self.document_id != manifest.document_id {
            return Err(
                "Drive project title snapshot identity does not match its manifest.".into(),
            );
        }
        if self.events.is_empty() || self.events.len() > MAX_TITLE_HISTORY_EVENTS {
            return Err("Drive project title snapshot event count is invalid or too large.".into());
        }
        let mut revisions = Vec::with_capacity(self.events.len());
        let mut by_revision = HashSet::with_capacity(self.events.len());
        for event in &self.events {
            event.validate_for(manifest)?;
            let revision = title_event_revision(event)?;
            if !by_revision.insert(revision.clone()) {
                return Err("Drive project title snapshot repeats an event revision.".into());
            }
            revisions.push(revision);
        }
        let mut canonical = revisions.clone();
        canonical.sort();
        if canonical != revisions {
            return Err("Drive project title snapshot events are not canonically ordered.".into());
        }
        if self.events.iter().any(|event| {
            event
                .parent_revisions
                .iter()
                .any(|parent| !by_revision.contains(parent))
        }) {
            return Err("Drive project title snapshot references a missing parent.".into());
        }
        Ok(())
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn title_event_revision(event: &StoredProjectTitleEvent) -> Result<String, String> {
    let bytes = serde_json::to_vec(event)
        .map_err(|error| format!("Drive project title event could not be encoded: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn title_snapshot_revision(snapshot: &StoredProjectTitleSnapshot) -> Result<String, String> {
    let bytes = serde_json::to_vec(snapshot)
        .map_err(|error| format!("Drive project title snapshot could not be encoded: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn base_title_revision(manifest: &StoredProjectManifest) -> String {
    let bytes = serde_json::to_vec(manifest)
        .expect("StoredProjectManifest contains no fallible serialization types");
    format!("base-{:x}", Sha256::digest(bytes))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveProjectTitleTip {
    revision: String,
    parent_revisions: Vec<String>,
    title: String,
    participant_id: String,
    display_name: String,
    timestamp: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveProjectTitleState {
    project_id: String,
    document_id: String,
    base_title: String,
    title: String,
    revision_guards: Vec<String>,
    conflict: bool,
    event_count: usize,
    active_event_count: usize,
    snapshot_count: usize,
    tips: Vec<DriveProjectTitleTip>,
}

struct ProjectTitleHistory {
    state: DriveProjectTitleState,
    events: HashMap<String, StoredProjectTitleEvent>,
    active_event_files: Vec<ListedFile>,
    snapshot_files: Vec<ListedFile>,
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum TitleRepairLocation {
    Active,
    Archive,
    Quarantine,
}

#[derive(Clone, Debug)]
enum TitleRepairPayload {
    Event {
        revision: String,
        event: StoredProjectTitleEvent,
    },
    Snapshot {
        revision: String,
        snapshot: StoredProjectTitleSnapshot,
    },
}

#[derive(Clone, Debug)]
struct TitleRepairRecord {
    file: ListedFile,
    location: TitleRepairLocation,
    content_sha256: String,
    observed_bytes: usize,
    payload: Result<TitleRepairPayload, String>,
}

#[derive(Debug)]
struct TitleRepairInventory {
    active: Vec<TitleRepairRecord>,
    archived: Vec<TitleRepairRecord>,
    quarantined: Vec<TitleRepairRecord>,
}

#[derive(Debug)]
struct TitleRepairPlan {
    repair_revision: String,
    repair_required: bool,
    recoverable_events: HashMap<String, StoredProjectTitleEvent>,
    snapshot: Option<StoredProjectTitleSnapshot>,
    snapshot_revision: Option<String>,
    quarantine_active: Vec<ListedFile>,
    archive_active: Vec<ListedFile>,
    invalid_archived_record_count: usize,
    recoverable_quarantined_record_count: usize,
    invalid_quarantined_record_count: usize,
    active_record_count: usize,
    archived_record_count: usize,
    quarantined_record_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveProjectTitleRepairInspection {
    repair_revision: String,
    repair_required: bool,
    recoverable_event_count: usize,
    active_record_count: usize,
    archived_record_count: usize,
    quarantined_record_count: usize,
    quarantine_candidate_count: usize,
    archive_candidate_count: usize,
    invalid_archived_record_count: usize,
    recoverable_quarantined_record_count: usize,
    invalid_quarantined_record_count: usize,
    move_count_this_run: usize,
    remaining_move_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveProjectTitleRepairResult {
    repair_revision: String,
    snapshot_revision: Option<String>,
    recoverable_event_count: usize,
    quarantined_record_count: usize,
    archived_record_count: usize,
    failed_move_count: usize,
    remaining_move_count: usize,
    complete: bool,
    state: Option<DriveProjectTitleState>,
}

fn project_title_history(
    manifest: &StoredProjectManifest,
    listed: &[ListedFile],
    snapshots: &[(ListedFile, StoredProjectTitleSnapshot)],
) -> Result<ProjectTitleHistory, String> {
    if snapshots.len() > MAX_TITLE_SNAPSHOTS {
        return Err(
            "Drive project contains too many active title snapshots to inspect safely.".into(),
        );
    }
    let mut events = HashMap::<String, StoredProjectTitleEvent>::new();
    let mut snapshot_files = Vec::with_capacity(snapshots.len());
    for (file, snapshot) in snapshots {
        snapshot.validate_for(manifest)?;
        for event in &snapshot.events {
            let revision = title_event_revision(event)?;
            if let Some(existing) = events.insert(revision, event.clone()) {
                if existing != *event {
                    return Err(
                        "Drive project title revision is duplicated with different content.".into(),
                    );
                }
            }
        }
        snapshot_files.push(file.clone());
    }
    let mut matching_files = 0usize;
    let mut active_event_files = Vec::new();
    for file in listed
        .iter()
        .filter(|file| file.name.starts_with(TITLE_EVENT_PREFIX))
    {
        matching_files += 1;
        if matching_files > MAX_TITLE_EVENT_READS {
            return Err(
                "Drive project contains too many shared title events to inspect safely.".into(),
            );
        }
        let revision = file
            .name
            .strip_prefix(TITLE_EVENT_PREFIX)
            .and_then(|value| value.strip_suffix(".json"))
            .ok_or("Drive project title event filename is malformed.")?;
        if !valid_sha256(revision) {
            return Err("Drive project title event revision is malformed.".into());
        }
        let description = file
            .description
            .as_deref()
            .ok_or("Drive project title event has no immutable description.")?;
        let event: StoredProjectTitleEvent = serde_json::from_str(description)
            .map_err(|_| "Drive project title event is malformed.".to_string())?;
        event.validate_for(manifest)?;
        if title_event_revision(&event)? != revision {
            return Err(
                "Drive project title event content hash does not match its filename.".into(),
            );
        }
        if let Some(existing) = events.insert(revision.to_string(), event.clone()) {
            if existing != event {
                return Err(
                    "Drive project title revision is duplicated with different content.".into(),
                );
            }
        }
        active_event_files.push(file.clone());
    }
    if events.len() > MAX_TITLE_HISTORY_EVENTS {
        return Err("Drive project shared-title history exceeds its retained event limit.".into());
    }

    for event in events.values() {
        if event
            .parent_revisions
            .iter()
            .any(|parent| !events.contains_key(parent))
        {
            return Err("Drive project title history references a missing parent.".into());
        }
    }
    let referenced = events
        .values()
        .flat_map(|event| event.parent_revisions.iter().cloned())
        .collect::<HashSet<_>>();
    let mut tip_revisions = events
        .keys()
        .filter(|revision| !referenced.contains(*revision))
        .cloned()
        .collect::<Vec<_>>();
    tip_revisions.sort();
    if tip_revisions.len() > MAX_TITLE_PARENTS {
        return Err(
            "Drive project title history has too many simultaneous tips to reconcile safely."
                .into(),
        );
    }
    let tips = tip_revisions
        .iter()
        .filter_map(|revision| {
            events.get(revision).map(|event| DriveProjectTitleTip {
                revision: revision.clone(),
                parent_revisions: event.parent_revisions.clone(),
                title: event.title.clone(),
                participant_id: event.participant_id.clone(),
                display_name: event.display_name.clone(),
                timestamp: event.timestamp,
            })
        })
        .collect::<Vec<_>>();
    let title = tips
        .first()
        .map(|tip| tip.title.clone())
        .unwrap_or_else(|| manifest.title.clone());
    let revision_guards = if tip_revisions.is_empty() {
        vec![base_title_revision(manifest)]
    } else {
        tip_revisions
    };
    Ok(ProjectTitleHistory {
        state: DriveProjectTitleState {
            project_id: manifest.project_id.clone(),
            document_id: manifest.document_id.clone(),
            base_title: manifest.title.clone(),
            title,
            conflict: tips.len() > 1,
            event_count: events.len(),
            active_event_count: active_event_files.len(),
            snapshot_count: snapshot_files.len(),
            revision_guards,
            tips,
        },
        events,
        active_event_files,
        snapshot_files,
    })
}

#[cfg(test)]
fn project_title_state(
    manifest: &StoredProjectManifest,
    listed: &[ListedFile],
) -> Result<DriveProjectTitleState, String> {
    project_title_history(manifest, listed, &[]).map(|history| history.state)
}

fn title_record_revision(name: &str, prefix: &str) -> Option<String> {
    name.strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(".json"))
        .filter(|value| valid_sha256(value))
        .map(str::to_string)
}

fn parse_title_event_repair_record(
    manifest: &StoredProjectManifest,
    file: &ListedFile,
) -> Result<TitleRepairPayload, String> {
    let revision = title_record_revision(&file.name, TITLE_EVENT_PREFIX)
        .ok_or("Drive project title event filename is malformed.")?;
    let description = file
        .description
        .as_deref()
        .ok_or("Drive project title event has no metadata body.")?;
    let event: StoredProjectTitleEvent = serde_json::from_str(description)
        .map_err(|_| "Drive project title event metadata is malformed.".to_string())?;
    event.validate_for(manifest)?;
    if title_event_revision(&event)? != revision {
        return Err("Drive project title event content hash does not match its filename.".into());
    }
    Ok(TitleRepairPayload::Event { revision, event })
}

fn parse_title_snapshot_repair_record(
    manifest: &StoredProjectManifest,
    file: &ListedFile,
    content: &str,
) -> Result<TitleRepairPayload, String> {
    let revision = title_record_revision(&file.name, TITLE_SNAPSHOT_PREFIX)
        .ok_or("Drive project title snapshot filename is malformed.")?;
    let snapshot: StoredProjectTitleSnapshot = serde_json::from_str(content)
        .map_err(|_| "Drive project title snapshot is malformed.".to_string())?;
    snapshot.validate_for(manifest)?;
    if title_snapshot_revision(&snapshot)? != revision {
        return Err(
            "Drive project title snapshot content hash does not match its filename.".into(),
        );
    }
    Ok(TitleRepairPayload::Snapshot { revision, snapshot })
}

fn title_repair_inventory_revision(
    manifest: &StoredProjectManifest,
    inventory: &TitleRepairInventory,
) -> Result<String, String> {
    let mut records = inventory
        .active
        .iter()
        .chain(inventory.archived.iter())
        .chain(inventory.quarantined.iter())
        .map(|record| {
            serde_json::json!({
                "location": record.location,
                "id": record.file.id,
                "name": record.file.name,
                "size": record.file.size,
                "contentSha256": record.content_sha256,
            })
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        left["location"]
            .as_str()
            .cmp(&right["location"].as_str())
            .then(left["name"].as_str().cmp(&right["name"].as_str()))
            .then(left["id"].as_str().cmp(&right["id"].as_str()))
    });
    let bytes = serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 1,
        "projectId": manifest.project_id,
        "documentId": manifest.document_id,
        "records": records,
    }))
    .map_err(|error| format!("Drive title repair inventory could not be encoded: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn insert_repair_event(
    events: &mut HashMap<String, StoredProjectTitleEvent>,
    revision: &str,
    event: &StoredProjectTitleEvent,
) -> Result<(), String> {
    if let Some(existing) = events.insert(revision.to_string(), event.clone()) {
        if existing != *event {
            return Err("Drive title repair found one revision with conflicting content.".into());
        }
    }
    Ok(())
}

fn plan_title_repair(
    manifest: &StoredProjectManifest,
    inventory: &TitleRepairInventory,
) -> Result<TitleRepairPlan, String> {
    let mut events = HashMap::<String, StoredProjectTitleEvent>::new();
    for record in inventory
        .active
        .iter()
        .chain(inventory.archived.iter())
        .chain(inventory.quarantined.iter())
    {
        match &record.payload {
            Ok(TitleRepairPayload::Event { revision, event }) => {
                insert_repair_event(&mut events, revision, event)?;
            }
            Ok(TitleRepairPayload::Snapshot { snapshot, .. }) => {
                for event in &snapshot.events {
                    let revision = title_event_revision(event)?;
                    insert_repair_event(&mut events, &revision, event)?;
                }
            }
            Err(_) => {}
        }
    }
    if events.len() > MAX_TITLE_HISTORY_EVENTS {
        return Err("Drive title repair exceeds the 5,000-event recovery limit.".into());
    }

    let mut recoverable_revisions = events.keys().cloned().collect::<HashSet<_>>();
    loop {
        let invalid = recoverable_revisions
            .iter()
            .filter(|revision| {
                events.get(*revision).is_some_and(|event| {
                    event
                        .parent_revisions
                        .iter()
                        .any(|parent| !recoverable_revisions.contains(parent))
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        if invalid.is_empty() {
            break;
        }
        for revision in invalid {
            recoverable_revisions.remove(&revision);
        }
    }
    let recoverable_events = events
        .into_iter()
        .filter(|(revision, _)| recoverable_revisions.contains(revision))
        .collect::<HashMap<_, _>>();
    let referenced = recoverable_events
        .values()
        .flat_map(|event| event.parent_revisions.iter().cloned())
        .collect::<HashSet<_>>();
    let tip_count = recoverable_events
        .keys()
        .filter(|revision| !referenced.contains(*revision))
        .count();
    if tip_count > MAX_TITLE_PARENTS {
        return Err(
            "Drive title repair found more than 20 recoverable title tips; reconcile or inspect the archive manually before repair."
                .into(),
        );
    }

    let active_has_invalid = inventory.active.iter().any(|record| match &record.payload {
        Err(_) => true,
        Ok(TitleRepairPayload::Event { revision, .. }) => !recoverable_revisions.contains(revision),
        Ok(TitleRepairPayload::Snapshot { .. }) => false,
    });
    let active_state = if active_has_invalid {
        None
    } else {
        let active_events = inventory
            .active
            .iter()
            .filter_map(|record| match &record.payload {
                Ok(TitleRepairPayload::Event { .. }) => Some(record.file.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        let active_snapshots = inventory
            .active
            .iter()
            .filter_map(|record| match &record.payload {
                Ok(TitleRepairPayload::Snapshot { snapshot, .. }) => {
                    Some((record.file.clone(), snapshot.clone()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        project_title_history(manifest, &active_events, &active_snapshots)
            .ok()
            .map(|history| history.state)
    };
    let repair_required = active_has_invalid
        || active_state
            .as_ref()
            .map(|state| state.event_count != recoverable_events.len())
            .unwrap_or(!recoverable_events.is_empty());

    let snapshot = if recoverable_events.is_empty() {
        None
    } else {
        Some(StoredProjectTitleSnapshot::new(
            manifest,
            &recoverable_events,
        )?)
    };
    let snapshot_revision = snapshot.as_ref().map(title_snapshot_revision).transpose()?;
    let mut quarantine_active = Vec::new();
    let mut archive_active = Vec::new();
    if repair_required {
        for record in &inventory.active {
            let valid = match &record.payload {
                Ok(TitleRepairPayload::Event { revision, .. }) => {
                    recoverable_revisions.contains(revision)
                }
                Ok(TitleRepairPayload::Snapshot { .. }) => true,
                Err(_) => false,
            };
            if !valid {
                quarantine_active.push(record.file.clone());
            } else if snapshot.is_some()
                && !matches!(
                    &record.payload,
                    Ok(TitleRepairPayload::Snapshot { revision, .. })
                        if Some(revision) == snapshot_revision.as_ref()
                )
            {
                archive_active.push(record.file.clone());
            }
        }
    }
    quarantine_active
        .sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    archive_active.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    let invalid_archived_record_count = inventory
        .archived
        .iter()
        .filter(|record| match &record.payload {
            Err(_) => true,
            Ok(TitleRepairPayload::Event { revision, .. }) => {
                !recoverable_revisions.contains(revision)
            }
            Ok(TitleRepairPayload::Snapshot { .. }) => false,
        })
        .count();
    let recoverable_quarantined_record_count = inventory
        .quarantined
        .iter()
        .filter(|record| match &record.payload {
            Ok(TitleRepairPayload::Event { revision, .. }) => {
                recoverable_revisions.contains(revision)
            }
            Ok(TitleRepairPayload::Snapshot { .. }) => true,
            Err(_) => false,
        })
        .count();
    let invalid_quarantined_record_count = inventory
        .quarantined
        .len()
        .saturating_sub(recoverable_quarantined_record_count);

    Ok(TitleRepairPlan {
        repair_revision: title_repair_inventory_revision(manifest, inventory)?,
        repair_required,
        recoverable_events,
        snapshot,
        snapshot_revision,
        quarantine_active,
        archive_active,
        invalid_archived_record_count,
        recoverable_quarantined_record_count,
        invalid_quarantined_record_count,
        active_record_count: inventory.active.len(),
        archived_record_count: inventory.archived.len(),
        quarantined_record_count: inventory.quarantined.len(),
    })
}

impl TitleRepairPlan {
    fn inspection(&self) -> DriveProjectTitleRepairInspection {
        let total_moves = self.quarantine_active.len() + self.archive_active.len();
        DriveProjectTitleRepairInspection {
            repair_revision: self.repair_revision.clone(),
            repair_required: self.repair_required,
            recoverable_event_count: self.recoverable_events.len(),
            active_record_count: self.active_record_count,
            archived_record_count: self.archived_record_count,
            quarantined_record_count: self.quarantined_record_count,
            quarantine_candidate_count: self.quarantine_active.len(),
            archive_candidate_count: self.archive_active.len(),
            invalid_archived_record_count: self.invalid_archived_record_count,
            recoverable_quarantined_record_count: self.recoverable_quarantined_record_count,
            invalid_quarantined_record_count: self.invalid_quarantined_record_count,
            move_count_this_run: total_moves.min(MAX_COMPACTION_BATCH),
            remaining_move_count: total_moves.saturating_sub(MAX_COMPACTION_BATCH),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveProjectDescriptor {
    schema_version: u8,
    project_id: String,
    document_id: String,
    title: String,
    created_at: u64,
    workspace_id: String,
    workspace_name: String,
    title_revision_guards: Vec<String>,
    title_conflict: bool,
    title_tip_count: usize,
}

impl DriveProjectDescriptor {
    fn from_manifest(manifest: StoredProjectManifest, workspace: &DriveWorkspace) -> Self {
        let title_revision_guards = vec![base_title_revision(&manifest)];
        Self {
            schema_version: manifest.schema_version,
            project_id: manifest.project_id,
            document_id: manifest.document_id,
            title: manifest.title,
            created_at: manifest.created_at,
            workspace_id: workspace.id.clone(),
            workspace_name: workspace.name.clone(),
            title_revision_guards,
            title_conflict: false,
            title_tip_count: 0,
        }
    }

    fn from_title_state(
        manifest: StoredProjectManifest,
        workspace: &DriveWorkspace,
        state: &DriveProjectTitleState,
    ) -> Self {
        Self {
            schema_version: manifest.schema_version,
            project_id: manifest.project_id,
            document_id: manifest.document_id,
            title: state.title.clone(),
            created_at: manifest.created_at,
            workspace_id: workspace.id.clone(),
            workspace_name: workspace.name.clone(),
            title_revision_guards: state.revision_guards.clone(),
            title_conflict: state.conflict,
            title_tip_count: state.tips.len(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveProjectCatalog {
    projects: Vec<DriveProjectDescriptor>,
    workspace_count: usize,
    skipped_root_count: usize,
}

#[derive(Clone, Debug)]
struct ProjectRoot {
    id: String,
    parent_ids: Vec<String>,
}

async fn list_project_roots(token: &str) -> Result<Vec<ProjectRoot>, String> {
    let query = format!(
        "name = '{}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        esc(PROJECTS_FOLDER)
    );
    let mut page_token: Option<String> = None;
    let mut roots = Vec::new();
    loop {
        let mut request = drive_client()?
            .get(FILES_ENDPOINT)
            .bearer_auth(token)
            .query(&[
                ("q", query.as_str()),
                ("fields", "nextPageToken,files(id,parents)"),
                ("pageSize", "200"),
                ("supportsAllDrives", "true"),
                ("includeItemsFromAllDrives", "true"),
            ]);
        if let Some(value) = page_token.as_deref() {
            request = request.query(&[("pageToken", value)]);
        }
        let response = request.send().await.map_err(|error| {
            format!("Drive project catalog failed before Google responded: {error}")
        })?;
        let value = response_json(response, "catalog listing").await?;
        if let Some(files) = value["files"].as_array() {
            for file in files {
                let Some(id) = file["id"].as_str() else {
                    continue;
                };
                let parent_ids = file["parents"]
                    .as_array()
                    .map(|parents| {
                        parents
                            .iter()
                            .filter_map(|parent| parent.as_str().map(str::to_string))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                roots.push(ProjectRoot {
                    id: id.to_string(),
                    parent_ids,
                });
                if roots.len() > MAX_PROJECT_ROOTS {
                    return Err(
                        "Drive contains too many Syzygy project roots to inspect safely.".into(),
                    );
                }
            }
        }
        page_token = value["nextPageToken"].as_str().map(str::to_string);
        if page_token.is_none() {
            break;
        }
    }
    Ok(roots)
}

fn unique_roots_by_workspace(roots: Vec<ProjectRoot>) -> (Vec<(String, String)>, usize) {
    let mut grouped: HashMap<String, Vec<String>> = HashMap::new();
    let mut skipped = 0;
    for root in roots {
        if root.parent_ids.len() != 1 {
            skipped += 1;
            continue;
        }
        grouped
            .entry(root.parent_ids[0].clone())
            .or_default()
            .push(root.id);
    }
    let mut unique = Vec::new();
    for (workspace_id, root_ids) in grouped {
        if root_ids.len() != 1 {
            skipped += root_ids.len();
            continue;
        }
        unique.push((workspace_id, root_ids[0].clone()));
    }
    unique.sort();
    (unique, skipped)
}

async fn projects_in_root(
    token: &str,
    root_id: &str,
    workspace: &DriveWorkspace,
) -> Result<Vec<DriveProjectDescriptor>, String> {
    let folders = list_children(token, root_id).await?;
    let reads = stream::iter(
        folders
            .into_iter()
            .filter(|file| file.name.starts_with("project-"))
            .map(|folder| async move {
                let Some(manifest_id) = find_child(token, &folder.id, MANIFEST_FILE, None).await?
                else {
                    return Ok(None);
                };
                let manifest: StoredProjectManifest =
                    serde_json::from_str(&read_text_file(token, &manifest_id).await?)
                        .map_err(|_| "A Drive project manifest is malformed.".to_string())?;
                manifest.validate()?;
                let title_state = load_project_title_state(token, &folder.id, &manifest).await?;
                Ok::<_, String>(Some(DriveProjectDescriptor::from_title_state(
                    manifest,
                    workspace,
                    &title_state,
                )))
            }),
    )
    .buffered(PROJECT_CATALOG_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;
    let mut projects = Vec::new();
    for read in reads {
        if let Some(project) = read? {
            projects.push(project);
        }
    }
    Ok(projects)
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProjectUpdate {
    schema_version: u8,
    project_id: String,
    document_id: String,
    sha256: String,
    update_base64: String,
}

impl StoredProjectUpdate {
    fn new(project_id: &str, document_id: &str, update_base64: String) -> Result<Self, String> {
        validate_identity("id", project_id)?;
        validate_identity("document id", document_id)?;
        let bytes = STANDARD
            .decode(&update_base64)
            .map_err(|_| "Drive project update is not valid base64.".to_string())?;
        if bytes.is_empty() || bytes.len() > MAX_UPDATE_BYTES {
            return Err("Drive project update is empty or exceeds 4 MiB.".into());
        }
        Ok(Self {
            schema_version: 1,
            project_id: project_id.to_string(),
            document_id: document_id.to_string(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            update_base64,
        })
    }

    fn validate_for(&self, project_id: &str, document_id: &str) -> Result<usize, String> {
        if self.schema_version != 1
            || self.project_id != project_id
            || self.document_id != document_id
        {
            return Err("Drive project update identity does not match its project.".into());
        }
        let bytes = STANDARD
            .decode(&self.update_base64)
            .map_err(|_| "Drive project update is not valid base64.".to_string())?;
        if bytes.is_empty() || bytes.len() > MAX_UPDATE_BYTES {
            return Err("Drive project update is empty or exceeds 4 MiB.".into());
        }
        if format!("{:x}", Sha256::digest(&bytes)) != self.sha256 {
            return Err("Drive project update failed its SHA-256 integrity check.".into());
        }
        Ok(bytes.len())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveProjectUpdate {
    id: String,
    update_base64: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveProjectPullResult {
    updates: Vec<DriveProjectUpdate>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveProjectPushResult {
    update_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveProjectCompactionResult {
    snapshot_update_id: String,
    snapshot_byte_length: usize,
    active_update_count_before: usize,
    active_update_count_after: usize,
    archived_update_count: usize,
    failed_archive_count: usize,
    remaining_included_update_count: usize,
    retained_concurrent_update_count: usize,
    complete: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveProjectTitleCompactionResult {
    snapshot_revision: String,
    retained_event_count: usize,
    active_event_count_before: usize,
    active_event_count_after: usize,
    archived_record_count: usize,
    failed_archive_count: usize,
    remaining_record_count: usize,
    complete: bool,
    state: DriveProjectTitleState,
}

async fn project_root(
    token: &str,
    workspace_id: &str,
    create: bool,
) -> Result<Option<String>, String> {
    if create {
        return find_or_create_folder(token, workspace_id, PROJECTS_FOLDER)
            .await
            .map(Some);
    }
    find_child(
        token,
        workspace_id,
        PROJECTS_FOLDER,
        Some("application/vnd.google-apps.folder"),
    )
    .await
}

async fn project_folder(
    token: &str,
    workspace_id: &str,
    project_id: &str,
    create: bool,
) -> Result<Option<String>, String> {
    validate_identity("id", project_id)?;
    let Some(root) = project_root(token, workspace_id, create).await? else {
        return Ok(None);
    };
    let name = format!("project-{project_id}");
    if create {
        return find_or_create_folder(token, &root, &name).await.map(Some);
    }
    find_child(
        token,
        &root,
        &name,
        Some("application/vnd.google-apps.folder"),
    )
    .await
}

async fn require_project_manifest(
    token: &str,
    workspace: &DriveWorkspace,
    project_id: &str,
    document_id: &str,
) -> Result<(String, StoredProjectManifest), String> {
    let folder = project_folder(token, &workspace.id, project_id, false)
        .await?
        .ok_or("This shared Drive project does not exist in the selected workspace.")?;
    let manifest_id = find_child(token, &folder, MANIFEST_FILE, None)
        .await?
        .ok_or("This shared Drive project has no manifest.")?;
    let manifest: StoredProjectManifest =
        serde_json::from_str(&read_text_file(token, &manifest_id).await?)
            .map_err(|_| "Drive project manifest is malformed.".to_string())?;
    manifest.validate()?;
    if manifest.project_id != project_id || manifest.document_id != document_id {
        return Err("Drive project identity does not match the requested project.".into());
    }
    Ok((folder, manifest))
}

async fn load_project_title_history(
    token: &str,
    project_folder_id: &str,
    manifest: &StoredProjectManifest,
) -> Result<ProjectTitleHistory, String> {
    let listed = list_title_event_files(token, project_folder_id).await?;
    let snapshot_files = list_title_snapshot_files(token, project_folder_id).await?;
    let snapshots = stream::iter(snapshot_files.into_iter())
        .map(|file| async move {
            let revision = file
                .name
                .strip_prefix(TITLE_SNAPSHOT_PREFIX)
                .and_then(|value| value.strip_suffix(".json"))
                .ok_or("Drive project title snapshot filename is malformed.")?;
            if !valid_sha256(revision) {
                return Err("Drive project title snapshot revision is malformed.".to_string());
            }
            let snapshot: StoredProjectTitleSnapshot =
                serde_json::from_str(&read_text_file(token, &file.id).await?)
                    .map_err(|_| "Drive project title snapshot is malformed.".to_string())?;
            snapshot.validate_for(manifest)?;
            if title_snapshot_revision(&snapshot)? != revision {
                return Err(
                    "Drive project title snapshot content hash does not match its filename."
                        .to_string(),
                );
            }
            Ok((file, snapshot))
        })
        .buffered(COMPACTION_CONCURRENCY)
        .collect::<Vec<Result<(ListedFile, StoredProjectTitleSnapshot), String>>>()
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    project_title_history(manifest, &listed, &snapshots)
}

async fn load_title_repair_records(
    token: &str,
    manifest: &StoredProjectManifest,
    location: TitleRepairLocation,
    listed: Vec<ListedFile>,
) -> Result<Vec<TitleRepairRecord>, String> {
    let recognized = listed
        .into_iter()
        .filter(|file| {
            file.name.starts_with(TITLE_EVENT_PREFIX)
                || file.name.starts_with(TITLE_SNAPSHOT_PREFIX)
        })
        .collect::<Vec<_>>();
    let declared_snapshot_bytes = recognized
        .iter()
        .filter(|file| file.name.starts_with(TITLE_SNAPSHOT_PREFIX))
        .try_fold(0usize, |total, file| total.checked_add(file.size))
        .ok_or("Drive title repair snapshot byte accounting overflowed.")?;
    let snapshot_count = recognized
        .iter()
        .filter(|file| file.name.starts_with(TITLE_SNAPSHOT_PREFIX))
        .count();
    if snapshot_count > MAX_TITLE_REPAIR_SNAPSHOTS {
        return Err(
            "Drive title repair contains too many snapshot records to inspect safely.".into(),
        );
    }
    if declared_snapshot_bytes > MAX_TITLE_REPAIR_BYTES {
        return Err("Drive title repair snapshot inventory exceeds its 32 MiB read limit.".into());
    }

    let records = stream::iter(recognized.into_iter())
        .map(|file| async move {
            if file.name.starts_with(TITLE_EVENT_PREFIX) {
                let raw = file.description.as_deref().unwrap_or_default().as_bytes();
                return Ok(TitleRepairRecord {
                    content_sha256: format!("{:x}", Sha256::digest(raw)),
                    observed_bytes: raw.len(),
                    payload: parse_title_event_repair_record(manifest, &file),
                    file,
                    location,
                });
            }
            if file.size > MAX_UPDATE_BYTES {
                return Ok(TitleRepairRecord {
                    content_sha256: format!(
                        "{:x}",
                        Sha256::digest(format!("oversized:{}", file.size).as_bytes())
                    ),
                    payload: Err(
                        "Drive project title snapshot exceeds its 4 MiB record limit.".into(),
                    ),
                    observed_bytes: 0,
                    file,
                    location,
                });
            }
            let content = read_text_file(token, &file.id).await?;
            let content_sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
            let payload = if content.len() > MAX_UPDATE_BYTES {
                Err("Drive project title snapshot exceeds its 4 MiB record limit.".into())
            } else {
                parse_title_snapshot_repair_record(manifest, &file, &content)
            };
            Ok(TitleRepairRecord {
                payload,
                content_sha256,
                observed_bytes: content.len(),
                file,
                location,
            })
        })
        .buffered(COMPACTION_CONCURRENCY)
        .collect::<Vec<Result<TitleRepairRecord, String>>>()
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    let actual_snapshot_bytes = records
        .iter()
        .filter(|record| record.file.name.starts_with(TITLE_SNAPSHOT_PREFIX))
        .try_fold(0usize, |total, record| {
            total.checked_add(record.observed_bytes)
        })
        .ok_or("Drive title repair observed byte accounting overflowed.")?;
    if actual_snapshot_bytes > MAX_TITLE_REPAIR_BYTES {
        return Err("Drive title repair snapshot inventory exceeds its 32 MiB read limit.".into());
    }
    Ok(records)
}

async fn load_title_repair_inventory(
    token: &str,
    project_folder_id: &str,
    manifest: &StoredProjectManifest,
) -> Result<TitleRepairInventory, String> {
    let active = list_children_filtered(
        token,
        project_folder_id,
        Some("title-"),
        true,
        MAX_TITLE_REPAIR_ACTIVE_FILES,
        "Drive title repair contains too many active records to inspect safely.",
    )
    .await?;
    let archived = if let Some(archive_folder) = find_child(
        token,
        project_folder_id,
        COMPACTED_TITLE_HISTORY_FOLDER,
        Some("application/vnd.google-apps.folder"),
    )
    .await?
    {
        list_children_filtered(
            token,
            &archive_folder,
            Some("title-"),
            true,
            MAX_TITLE_REPAIR_ARCHIVE_FILES,
            "Drive title repair archive contains too many records to inspect safely.",
        )
        .await?
    } else {
        Vec::new()
    };
    let quarantined = if let Some(quarantine_folder) = find_child(
        token,
        project_folder_id,
        QUARANTINED_TITLE_HISTORY_FOLDER,
        Some("application/vnd.google-apps.folder"),
    )
    .await?
    {
        list_children_filtered(
            token,
            &quarantine_folder,
            Some("title-"),
            true,
            MAX_TITLE_REPAIR_QUARANTINE_FILES,
            "Drive title repair quarantine contains too many records to inspect safely.",
        )
        .await?
    } else {
        Vec::new()
    };
    let active =
        load_title_repair_records(token, manifest, TitleRepairLocation::Active, active).await?;
    let archived =
        load_title_repair_records(token, manifest, TitleRepairLocation::Archive, archived).await?;
    let quarantined = load_title_repair_records(
        token,
        manifest,
        TitleRepairLocation::Quarantine,
        quarantined,
    )
    .await?;
    Ok(TitleRepairInventory {
        active,
        archived,
        quarantined,
    })
}

fn title_repair_inventory_unchanged(
    before: &TitleRepairInventory,
    after: &TitleRepairInventory,
    allowed_snapshot_id: Option<&str>,
    allowed_snapshot_revision: Option<&str>,
) -> bool {
    let record_map = |inventory: &TitleRepairInventory| {
        inventory
            .active
            .iter()
            .chain(inventory.archived.iter())
            .chain(inventory.quarantined.iter())
            .map(|record| {
                (
                    (record.location, record.file.id.clone()),
                    (
                        record.file.name.clone(),
                        record.file.size,
                        record.content_sha256.clone(),
                    ),
                )
            })
            .collect::<HashMap<_, _>>()
    };
    let before_records = record_map(before);
    let after_records = record_map(after);
    if before_records
        .iter()
        .any(|(key, value)| after_records.get(key) != Some(value))
    {
        return false;
    }
    after
        .active
        .iter()
        .chain(after.archived.iter())
        .chain(after.quarantined.iter())
        .filter(|record| !before_records.contains_key(&(record.location, record.file.id.clone())))
        .all(|record| {
            record.location == TitleRepairLocation::Active
                && Some(record.file.id.as_str()) == allowed_snapshot_id
                && matches!(
                    &record.payload,
                    Ok(TitleRepairPayload::Snapshot { revision, .. })
                        if Some(revision.as_str()) == allowed_snapshot_revision
                )
        })
}

async fn load_project_title_state(
    token: &str,
    project_folder_id: &str,
    manifest: &StoredProjectManifest,
) -> Result<DriveProjectTitleState, String> {
    load_project_title_history(token, project_folder_id, manifest)
        .await
        .map(|history| history.state)
}

async fn append_project_title_event(
    token: &str,
    project_folder_id: &str,
    manifest: &StoredProjectManifest,
    title: String,
    expected_revision_guards: Vec<String>,
    participant_id: String,
    display_name: String,
    timestamp: u64,
) -> Result<DriveProjectTitleState, String> {
    if expected_revision_guards.is_empty()
        || expected_revision_guards.len() > MAX_TITLE_PARENTS
        || {
            let mut canonical = expected_revision_guards.clone();
            canonical.sort();
            canonical.dedup();
            canonical != expected_revision_guards
        }
    {
        return Err(
            "Drive project title revision guards must be non-empty, unique, sorted, and bounded."
                .into(),
        );
    }
    let before = load_project_title_state(token, project_folder_id, manifest).await?;
    if before.revision_guards != expected_revision_guards {
        if !before.conflict && before.title == title.trim() {
            return Ok(before);
        }
        return Err(
            "Drive project title changed or gained a concurrent sibling; refresh before renaming."
                .into(),
        );
    }
    if !before.conflict && before.title == title.trim() {
        return Ok(before);
    }
    if before.active_event_count >= MAX_TITLE_EVENTS {
        return Err(
            "Drive project active shared-title history reached its safe limit; retain the title history before renaming."
                .into(),
        );
    }
    let parent_revisions = if expected_revision_guards.len() == 1
        && expected_revision_guards[0].starts_with("base-")
    {
        Vec::new()
    } else {
        expected_revision_guards
    };
    let event = StoredProjectTitleEvent {
        schema_version: 1,
        project_id: manifest.project_id.clone(),
        document_id: manifest.document_id.clone(),
        parent_revisions,
        title: title.trim().to_string(),
        participant_id: participant_id.trim().to_string(),
        display_name: display_name.trim().to_string(),
        timestamp,
    };
    event.validate_for(manifest)?;
    let revision = title_event_revision(&event)?;
    let name = format!("{TITLE_EVENT_PREFIX}{revision}.json");
    let description = serde_json::to_string(&event)
        .map_err(|error| format!("Drive project title event could not be encoded: {error}"))?;
    if find_child(token, project_folder_id, &name, None)
        .await?
        .is_none()
    {
        create_metadata_record(token, project_folder_id, &name, &description).await?;
    }
    load_project_title_state(token, project_folder_id, manifest).await
}

async fn push_update(
    token: &str,
    project_folder_id: &str,
    project_id: &str,
    document_id: &str,
    client_id: &str,
    update_base64: String,
) -> Result<DriveProjectPushResult, String> {
    validate_identity("client id", client_id)?;
    let update = StoredProjectUpdate::new(project_id, document_id, update_base64)?;
    let updates_folder = find_or_create_folder(token, project_folder_id, UPDATES_FOLDER).await?;
    let name = format!("update-{}.json", update.sha256);
    let content = serde_json::to_string(&update).map_err(|error| error.to_string())?;
    if let Some(existing_id) = find_child(token, &updates_folder, &name, None).await? {
        let existing: StoredProjectUpdate =
            serde_json::from_str(&read_text_file(token, &existing_id).await?)
                .map_err(|_| "Existing Drive project update is malformed.".to_string())?;
        existing.validate_for(project_id, document_id)?;
        if existing != update {
            return Err("Existing Drive update name collides with different content.".into());
        }
        return Ok(DriveProjectPushResult {
            update_id: existing_id,
        });
    }
    Ok(DriveProjectPushResult {
        update_id: create_text_file(token, &updates_folder, &name, &content).await?,
    })
}

#[tauri::command]
pub async fn google_drive_project_publish(
    app: tauri::AppHandle,
    project_id: String,
    document_id: String,
    title: String,
    created_at: u64,
    initial_update_base64: String,
) -> Result<DriveProjectDescriptor, String> {
    let (token, workspace) = selected_workspace_access(&app).await?;
    let manifest = StoredProjectManifest {
        schema_version: 1,
        project_id: project_id.trim().to_string(),
        document_id: document_id.trim().to_string(),
        title: title.trim().to_string(),
        created_at,
    };
    manifest.validate()?;
    let folder = project_folder(&token, &workspace.id, &manifest.project_id, true)
        .await?
        .ok_or("Drive project folder could not be created.")?;
    if let Some(manifest_id) = find_child(&token, &folder, MANIFEST_FILE, None).await? {
        let existing: StoredProjectManifest =
            serde_json::from_str(&read_text_file(&token, &manifest_id).await?)
                .map_err(|_| "Existing Drive project manifest is malformed.".to_string())?;
        existing.validate()?;
        if existing != manifest {
            return Err("A different Drive project already uses this project identity.".into());
        }
    } else {
        let content = serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?;
        create_text_file(&token, &folder, MANIFEST_FILE, &content).await?;
    }
    push_update(
        &token,
        &folder,
        &manifest.project_id,
        &manifest.document_id,
        "publisher",
        initial_update_base64,
    )
    .await?;
    Ok(DriveProjectDescriptor::from_manifest(manifest, &workspace))
}

#[tauri::command]
pub async fn google_drive_project_list(
    app: tauri::AppHandle,
) -> Result<Vec<DriveProjectDescriptor>, String> {
    with_project_catalog_deadline("selected-workspace catalog", list_selected_projects(app)).await
}

async fn list_selected_projects(
    app: tauri::AppHandle,
) -> Result<Vec<DriveProjectDescriptor>, String> {
    let (token, workspace) = selected_workspace_access(&app).await?;
    let Some(root) = project_root(&token, &workspace.id, false).await? else {
        return Ok(Vec::new());
    };
    let mut projects = projects_in_root(&token, &root, &workspace).await?;
    projects.sort_by(|left, right| {
        left.title
            .cmp(&right.title)
            .then(left.project_id.cmp(&right.project_id))
    });
    Ok(projects)
}

/// Discover Syzygy project roots across folders visible to the connected account. This explicit
/// browse operation does not change the selected workspace or grant project mutation authority.
/// Joining one result separately selects its exact parent workspace.
#[tauri::command]
pub async fn google_drive_project_discover(
    app: tauri::AppHandle,
) -> Result<DriveProjectCatalog, String> {
    with_project_catalog_deadline("cross-workspace catalog", discover_projects(app)).await
}

async fn discover_projects(app: tauri::AppHandle) -> Result<DriveProjectCatalog, String> {
    let token = collaboration_access(&app).await?;
    let (roots, mut skipped_root_count) =
        unique_roots_by_workspace(list_project_roots(&token).await?);
    let mut projects = Vec::new();
    let mut workspace_count = 0;
    for (workspace_id, root_id) in roots {
        let workspace = match folder_metadata(&token, &workspace_id).await {
            Ok(workspace) => workspace,
            Err(_) => {
                skipped_root_count += 1;
                continue;
            }
        };
        match projects_in_root(&token, &root_id, &workspace).await {
            Ok(mut discovered) => {
                workspace_count += 1;
                projects.append(&mut discovered);
                if projects.len() > MAX_DISCOVERED_PROJECTS {
                    return Err(
                        "Drive contains too many shared Syzygy projects to inspect safely.".into(),
                    );
                }
            }
            Err(_) => skipped_root_count += 1,
        }
    }
    projects.sort_by(|left, right| {
        left.workspace_name
            .cmp(&right.workspace_name)
            .then(left.title.cmp(&right.title))
            .then(left.project_id.cmp(&right.project_id))
    });
    Ok(DriveProjectCatalog {
        projects,
        workspace_count,
        skipped_root_count,
    })
}

#[tauri::command]
pub async fn google_drive_project_title_state(
    app: tauri::AppHandle,
    project_id: String,
    document_id: String,
) -> Result<DriveProjectTitleState, String> {
    let (token, workspace) = selected_workspace_access(&app).await?;
    let (folder, manifest) =
        require_project_manifest(&token, &workspace, project_id.trim(), document_id.trim()).await?;
    load_project_title_state(&token, &folder, &manifest).await
}

/// Append a content-addressed shared-title event against the exact current tip set. Concurrent
/// writers can still append siblings, but neither title is overwritten; the next read exposes the
/// conflict and the same command reconciles it by naming every current tip as a parent.
#[tauri::command]
pub async fn google_drive_project_title_update(
    app: tauri::AppHandle,
    project_id: String,
    document_id: String,
    title: String,
    expected_revision_guards: Vec<String>,
    participant_id: String,
    display_name: String,
    timestamp: u64,
) -> Result<DriveProjectTitleState, String> {
    let (token, workspace) = selected_workspace_access(&app).await?;
    let (folder, manifest) =
        require_project_manifest(&token, &workspace, project_id.trim(), document_id.trim()).await?;
    append_project_title_event(
        &token,
        &folder,
        &manifest,
        title,
        expected_revision_guards,
        participant_id,
        display_name,
        timestamp,
    )
    .await
}

/// Retain the complete validated title graph in an immutable content-addressed snapshot before
/// moving only the already-observed active title records into a recoverable archive folder. A
/// concurrent rename changes the exact guards and aborts before movement; one arriving after the
/// snapshot remains active and can resolve its parents from the snapshot.
#[tauri::command]
pub async fn google_drive_project_title_compact(
    app: tauri::AppHandle,
    project_id: String,
    document_id: String,
    expected_revision_guards: Vec<String>,
) -> Result<DriveProjectTitleCompactionResult, String> {
    if expected_revision_guards.is_empty()
        || expected_revision_guards.len() > MAX_TITLE_PARENTS
        || {
            let mut canonical = expected_revision_guards.clone();
            canonical.sort();
            canonical.dedup();
            canonical != expected_revision_guards
        }
    {
        return Err(
            "Drive project title retention guards must be non-empty, unique, sorted, and bounded."
                .into(),
        );
    }
    let (token, workspace) = selected_workspace_access(&app).await?;
    let (folder, manifest) =
        require_project_manifest(&token, &workspace, project_id.trim(), document_id.trim()).await?;
    let before = load_project_title_history(&token, &folder, &manifest).await?;
    if before.state.revision_guards != expected_revision_guards {
        return Err(
            "Drive project title changed or gained a concurrent sibling; refresh before retaining its history."
                .into(),
        );
    }
    let snapshot = StoredProjectTitleSnapshot::new(&manifest, &before.events)?;
    let snapshot_content = serde_json::to_string(&snapshot)
        .map_err(|error| format!("Drive project title snapshot could not be encoded: {error}"))?;
    if snapshot_content.len() > MAX_UPDATE_BYTES {
        return Err(
            "Drive project title snapshot exceeds its 4 MiB retained-history limit.".into(),
        );
    }
    let snapshot_revision = title_snapshot_revision(&snapshot)?;
    let snapshot_name = format!("{TITLE_SNAPSHOT_PREFIX}{snapshot_revision}.json");
    let snapshot_id = if let Some(existing_id) =
        find_child(&token, &folder, &snapshot_name, None).await?
    {
        let existing: StoredProjectTitleSnapshot =
            serde_json::from_str(&read_text_file(&token, &existing_id).await?)
                .map_err(|_| "Existing Drive project title snapshot is malformed.".to_string())?;
        if existing != snapshot {
            return Err(
                "Existing Drive title snapshot name collides with different content.".into(),
            );
        }
        existing_id
    } else {
        if before.snapshot_files.len() >= MAX_TITLE_SNAPSHOTS {
            return Err(
                "Drive project has too many active title snapshots to create another safely."
                    .into(),
            );
        }
        create_text_file(&token, &folder, &snapshot_name, &snapshot_content).await?
    };

    let after_snapshot = load_project_title_history(&token, &folder, &manifest).await?;
    if after_snapshot.state.revision_guards != expected_revision_guards {
        return Err(
            "Drive project title changed while its retained snapshot was being appended; no history records were archived."
                .into(),
        );
    }

    let mut candidates = before.active_event_files;
    candidates.extend(
        before
            .snapshot_files
            .into_iter()
            .filter(|file| file.id != snapshot_id),
    );
    candidates.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    let active_event_count_before = after_snapshot.state.active_event_count;
    let retained_event_count = after_snapshot.state.event_count;
    let candidate_count = candidates.len();
    let move_candidates = candidates
        .into_iter()
        .take(MAX_COMPACTION_BATCH)
        .collect::<Vec<_>>();

    let move_results = tokio::time::timeout(
        Duration::from_secs(COMPACTION_ARCHIVE_DEADLINE_SECONDS),
        async {
            let archive_folder = if move_candidates.is_empty() {
                None
            } else {
                Some(
                    find_or_create_folder(&token, &folder, COMPACTED_TITLE_HISTORY_FOLDER).await?,
                )
            };
            if let Some(archive_folder) = archive_folder.as_ref() {
                Ok::<Vec<Result<(), String>>, String>(
                    stream::iter(move_candidates.into_iter())
                        .map(|file| {
                            let token = &token;
                            let folder = &folder;
                            let archive_folder = archive_folder;
                            async move {
                                move_file_to_folder(token, &file.id, folder, archive_folder).await
                            }
                        })
                        .buffer_unordered(COMPACTION_CONCURRENCY)
                        .collect::<Vec<_>>()
                        .await,
                )
            } else {
                Ok(Vec::new())
            }
        },
    )
    .await
    .map_err(|_| {
        "Drive title retention reached its 60-second archive deadline after the complete snapshot was appended. Some records may already be archived; retry safely."
            .to_string()
    })??;
    let archived_record_count = move_results.iter().filter(|result| result.is_ok()).count();
    let failed_archive_count = move_results.len().saturating_sub(archived_record_count);
    let remaining_record_count = candidate_count.saturating_sub(archived_record_count);
    let after = load_project_title_history(&token, &folder, &manifest).await?;
    Ok(DriveProjectTitleCompactionResult {
        snapshot_revision,
        retained_event_count,
        active_event_count_before,
        active_event_count_after: after.state.active_event_count,
        archived_record_count,
        failed_archive_count,
        remaining_record_count,
        complete: failed_archive_count == 0 && remaining_record_count == 0,
        state: after.state,
    })
}

/// Inspect active and recoverable archived shared-title records without returning record IDs,
/// filenames, titles, author metadata, or snapshot bodies. The returned repair revision binds an
/// explicit follow-up repair to this exact content inventory.
#[tauri::command]
pub async fn google_drive_project_title_repair_inspect(
    app: tauri::AppHandle,
    project_id: String,
    document_id: String,
) -> Result<DriveProjectTitleRepairInspection, String> {
    with_drive_project_deadline(
        "title repair inspection",
        Duration::from_secs(TITLE_REPAIR_DEADLINE_SECONDS),
        async {
            let (token, workspace) = selected_workspace_access(&app).await?;
            let (folder, manifest) =
                require_project_manifest(&token, &workspace, project_id.trim(), document_id.trim())
                    .await?;
            let inventory = load_title_repair_inventory(&token, &folder, &manifest).await?;
            Ok(plan_title_repair(&manifest, &inventory)?.inspection())
        },
    )
    .await
}

/// Restore the maximal complete validated title graph from active plus recoverable archived
/// records. A new canonical snapshot is appended before valid active records are re-archived and
/// invalid active records are moved to a separate recoverable quarantine folder. The exact repair
/// inventory is rechecked after snapshot creation and before any move.
#[tauri::command]
pub async fn google_drive_project_title_repair(
    app: tauri::AppHandle,
    project_id: String,
    document_id: String,
    expected_repair_revision: String,
) -> Result<DriveProjectTitleRepairResult, String> {
    if !valid_sha256(expected_repair_revision.trim()) {
        return Err("Drive title repair revision is malformed.".into());
    }
    with_drive_project_deadline(
        "title repair",
        Duration::from_secs(TITLE_REPAIR_DEADLINE_SECONDS),
        async {
            let (token, workspace) = selected_workspace_access(&app).await?;
            let (folder, manifest) = require_project_manifest(
                &token,
                &workspace,
                project_id.trim(),
                document_id.trim(),
            )
            .await?;
            let inventory = load_title_repair_inventory(&token, &folder, &manifest).await?;
            let plan = plan_title_repair(&manifest, &inventory)?;
            if plan.repair_revision != expected_repair_revision.trim() {
                return Err(
                    "Drive title repair inventory changed; inspect it again before moving records."
                        .into(),
                );
            }
            if !plan.repair_required {
                return Err("Drive shared-title history does not currently require repair.".into());
            }

            let snapshot_id = if let (Some(snapshot), Some(snapshot_revision)) =
                (plan.snapshot.as_ref(), plan.snapshot_revision.as_ref())
            {
                let snapshot_content = serde_json::to_string(snapshot).map_err(|error| {
                    format!("Drive title repair snapshot could not be encoded: {error}")
                })?;
                if snapshot_content.len() > MAX_UPDATE_BYTES {
                    return Err(
                        "Drive title repair snapshot exceeds its 4 MiB recovery limit.".into(),
                    );
                }
                let snapshot_name = format!("{TITLE_SNAPSHOT_PREFIX}{snapshot_revision}.json");
                if let Some(existing_id) = find_child(&token, &folder, &snapshot_name, None).await? {
                    let existing_content = read_text_file(&token, &existing_id).await?;
                    let existing = parse_title_snapshot_repair_record(
                        &manifest,
                        &ListedFile {
                            id: existing_id.clone(),
                            name: snapshot_name,
                            size: existing_content.len(),
                            description: None,
                        },
                        &existing_content,
                    )?;
                    if !matches!(
                        existing,
                        TitleRepairPayload::Snapshot { snapshot: existing, .. } if &existing == snapshot
                    ) {
                        return Err(
                            "Existing Drive title repair snapshot collides with different content."
                                .into(),
                        );
                    }
                    Some(existing_id)
                } else {
                    if inventory.active.len() >= MAX_TITLE_REPAIR_ACTIVE_FILES {
                        return Err(
                            "Drive title repair has no bounded active-record slot for its recovery snapshot; preserve the folder and inspect it manually."
                                .into(),
                        );
                    }
                    Some(create_text_file(&token, &folder, &snapshot_name, &snapshot_content).await?)
                }
            } else {
                None
            };

            let after_snapshot = load_title_repair_inventory(&token, &folder, &manifest).await?;
            if !title_repair_inventory_unchanged(
                &inventory,
                &after_snapshot,
                snapshot_id.as_deref(),
                plan.snapshot_revision.as_deref(),
            ) {
                return Err(
                    "Drive title history changed while the recovery snapshot was being appended; no records were moved."
                        .into(),
                );
            }

            let quarantine_take = plan.quarantine_active.len().min(MAX_COMPACTION_BATCH);
            let archive_take = plan
                .archive_active
                .len()
                .min(MAX_COMPACTION_BATCH.saturating_sub(quarantine_take));
            let quarantine_moves = plan
                .quarantine_active
                .iter()
                .take(quarantine_take)
                .cloned()
                .collect::<Vec<_>>();
            let archive_moves = plan
                .archive_active
                .iter()
                .take(archive_take)
                .cloned()
                .collect::<Vec<_>>();
            let quarantine_folder = if quarantine_moves.is_empty() {
                None
            } else {
                Some(
                    find_or_create_folder(&token, &folder, QUARANTINED_TITLE_HISTORY_FOLDER)
                        .await?,
                )
            };
            let archive_folder = if archive_moves.is_empty() {
                None
            } else {
                Some(
                    find_or_create_folder(&token, &folder, COMPACTED_TITLE_HISTORY_FOLDER).await?,
                )
            };
            let mut moves = quarantine_moves
                .into_iter()
                .map(|file| (true, file, quarantine_folder.clone().expect("folder exists")))
                .collect::<Vec<_>>();
            moves.extend(
                archive_moves
                    .into_iter()
                    .map(|file| (false, file, archive_folder.clone().expect("folder exists"))),
            );
            let move_results = tokio::time::timeout(
                Duration::from_secs(COMPACTION_ARCHIVE_DEADLINE_SECONDS),
                stream::iter(moves.into_iter())
                    .map(|(quarantine, file, destination)| {
                        let token = &token;
                        let folder = &folder;
                        async move {
                            (
                                quarantine,
                                move_file_to_folder(token, &file.id, folder, &destination).await,
                            )
                        }
                    })
                    .buffer_unordered(COMPACTION_CONCURRENCY)
                    .collect::<Vec<_>>(),
            )
            .await
            .map_err(|_| {
                "Drive title repair reached its 60-second move deadline after the recovery snapshot was appended. Some records may already be archived or quarantined; inspect again before retrying."
                    .to_string()
            })?;
            let quarantined_record_count = move_results
                .iter()
                .filter(|(quarantine, result)| *quarantine && result.is_ok())
                .count();
            let archived_record_count = move_results
                .iter()
                .filter(|(quarantine, result)| !*quarantine && result.is_ok())
                .count();
            let failed_move_count = move_results
                .iter()
                .filter(|(_, result)| result.is_err())
                .count();
            let total_move_count = plan.quarantine_active.len() + plan.archive_active.len();
            let successful_move_count = quarantined_record_count + archived_record_count;
            let remaining_move_count = total_move_count.saturating_sub(successful_move_count);
            let remaining_quarantine_count = plan
                .quarantine_active
                .len()
                .saturating_sub(quarantined_record_count);
            let state = if remaining_quarantine_count == 0 {
                Some(load_project_title_state(&token, &folder, &manifest).await?)
            } else {
                None
            };
            Ok(DriveProjectTitleRepairResult {
                repair_revision: plan.repair_revision,
                snapshot_revision: plan.snapshot_revision,
                recoverable_event_count: plan.recoverable_events.len(),
                quarantined_record_count,
                archived_record_count,
                failed_move_count,
                remaining_move_count,
                complete: failed_move_count == 0 && remaining_move_count == 0,
                state,
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn google_drive_project_push(
    app: tauri::AppHandle,
    project_id: String,
    document_id: String,
    client_id: String,
    update_base64: String,
) -> Result<DriveProjectPushResult, String> {
    let (token, workspace) = selected_workspace_access(&app).await?;
    let (folder, _) =
        require_project_manifest(&token, &workspace, project_id.trim(), document_id.trim()).await?;
    push_update(
        &token,
        &folder,
        project_id.trim(),
        document_id.trim(),
        client_id.trim(),
        update_base64,
    )
    .await
}

/// Append a complete Yjs snapshot, then move only update records the live provider says it has
/// applied into a recoverable sibling folder. Unknown records are concurrent and remain active.
/// Moves are bounded and partial failure is returned explicitly so the caller can safely retry.
#[tauri::command]
pub async fn google_drive_project_compact(
    app: tauri::AppHandle,
    project_id: String,
    document_id: String,
    client_id: String,
    snapshot_update_base64: String,
    included_update_ids: Vec<String>,
) -> Result<DriveProjectCompactionResult, String> {
    if included_update_ids.is_empty()
        || included_update_ids.len() > MAX_KNOWN_IDS
        || included_update_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > 256)
        || included_update_ids.iter().collect::<HashSet<_>>().len() != included_update_ids.len()
    {
        return Err(
            "Drive compaction update list is invalid, empty, duplicated, or too large.".into(),
        );
    }
    validate_identity("client id", client_id.trim())?;
    let snapshot_byte_length = STANDARD
        .decode(&snapshot_update_base64)
        .map_err(|_| "Drive compaction snapshot is not valid base64.".to_string())?
        .len();
    if snapshot_byte_length == 0 || snapshot_byte_length > MAX_UPDATE_BYTES {
        return Err("Drive compaction snapshot is empty or exceeds 4 MiB.".into());
    }

    let included = included_update_ids.into_iter().collect::<HashSet<_>>();
    let (token, workspace) = selected_workspace_access(&app).await?;
    let (folder, _) =
        require_project_manifest(&token, &workspace, project_id.trim(), document_id.trim()).await?;
    let snapshot = push_update(
        &token,
        &folder,
        project_id.trim(),
        document_id.trim(),
        client_id.trim(),
        snapshot_update_base64,
    )
    .await?;
    let archive_outcome = tokio::time::timeout(
        Duration::from_secs(COMPACTION_ARCHIVE_DEADLINE_SECONDS),
        async {
            let updates_folder = find_or_create_folder(&token, &folder, UPDATES_FOLDER).await?;
            let mut listed = list_children(&token, &updates_folder).await?;
            listed.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
            let active_update_count_before = listed
                .iter()
                .filter(|file| file.name.starts_with("update-"))
                .count();
            let plan = plan_compaction(&listed, &included, &snapshot.update_id);

            for id in &plan.archive_ids {
                let file = listed
                    .iter()
                    .find(|file| &file.id == id)
                    .ok_or("Drive compaction plan referenced a missing update.")?;
                if file.size > MAX_UPDATE_BYTES * 2 {
                    return Err(
                        "Drive compaction candidate exceeds the supported size limit.".into(),
                    );
                }
                let update: StoredProjectUpdate =
                    serde_json::from_str(&read_text_file(&token, id).await?)
                        .map_err(|_| "Drive compaction candidate is malformed.".to_string())?;
                update.validate_for(project_id.trim(), document_id.trim())?;
            }

            let archive_folder = if plan.archive_ids.is_empty() {
                None
            } else {
                Some(find_or_create_folder(&token, &folder, COMPACTED_UPDATES_FOLDER).await?)
            };
            let move_results = if let Some(archive_folder) = archive_folder.as_ref() {
                stream::iter(plan.archive_ids.iter().cloned())
                    .map(|id| {
                        let token = &token;
                        let updates_folder = &updates_folder;
                        let archive_folder = archive_folder;
                        async move {
                            move_file_to_folder(token, &id, updates_folder, archive_folder).await
                        }
                    })
                    .buffer_unordered(COMPACTION_CONCURRENCY)
                    .collect::<Vec<_>>()
                    .await
            } else {
                Vec::new()
            };
            let archived_update_count = move_results.iter().filter(|result| result.is_ok()).count();
            let failed_archive_count = move_results.len().saturating_sub(archived_update_count);
            let remaining_included_update_count = plan
                .remaining_included_count
                .saturating_add(failed_archive_count);
            let active_update_count_after =
                active_update_count_before.saturating_sub(archived_update_count);

            Ok::<CompactionArchiveOutcome, String>(CompactionArchiveOutcome {
                active_update_count_before,
                active_update_count_after,
                archived_update_count,
                failed_archive_count,
                remaining_included_update_count,
                retained_concurrent_update_count: plan.retained_concurrent_count,
            })
        },
    )
    .await
    .map_err(|_| {
        "Drive compaction reached its 60-second archive deadline after the complete snapshot was appended. Some records may already be archived; retry compaction safely."
            .to_string()
    })??;

    Ok(DriveProjectCompactionResult {
        snapshot_update_id: snapshot.update_id,
        snapshot_byte_length,
        active_update_count_before: archive_outcome.active_update_count_before,
        active_update_count_after: archive_outcome.active_update_count_after,
        archived_update_count: archive_outcome.archived_update_count,
        failed_archive_count: archive_outcome.failed_archive_count,
        remaining_included_update_count: archive_outcome.remaining_included_update_count,
        retained_concurrent_update_count: archive_outcome.retained_concurrent_update_count,
        complete: archive_outcome.failed_archive_count == 0
            && archive_outcome.remaining_included_update_count == 0,
    })
}

#[tauri::command]
pub async fn google_drive_project_pull(
    app: tauri::AppHandle,
    project_id: String,
    document_id: String,
    known_update_ids: Vec<String>,
) -> Result<DriveProjectPullResult, String> {
    if known_update_ids.len() > MAX_KNOWN_IDS
        || known_update_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > 256)
    {
        return Err("Drive project known-update list is invalid or too large.".into());
    }
    let known = known_update_ids.into_iter().collect::<HashSet<_>>();
    let (token, workspace) = selected_workspace_access(&app).await?;
    let (folder, _) =
        require_project_manifest(&token, &workspace, project_id.trim(), document_id.trim()).await?;
    let Some(updates_folder) = find_child(
        &token,
        &folder,
        UPDATES_FOLDER,
        Some("application/vnd.google-apps.folder"),
    )
    .await?
    else {
        return Ok(DriveProjectPullResult {
            updates: Vec::new(),
        });
    };
    let mut listed = list_children(&token, &updates_folder).await?;
    listed.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    if listed
        .iter()
        .filter(|file| file.name.starts_with("update-"))
        .count()
        > MAX_UPDATE_FILES
    {
        return Err(
            "Drive project contains too many active update records; compact it before continuing."
                .into(),
        );
    }
    let mut total_bytes = 0usize;
    let mut updates = Vec::new();
    for file in listed {
        if known.contains(&file.id) || !file.name.starts_with("update-") {
            continue;
        }
        if file.size > MAX_UPDATE_BYTES * 2 {
            return Err("Drive project update record exceeds the supported size limit.".into());
        }
        let update: StoredProjectUpdate =
            serde_json::from_str(&read_text_file(&token, &file.id).await?)
                .map_err(|_| "Drive project update record is malformed.".to_string())?;
        total_bytes = total_bytes
            .checked_add(update.validate_for(project_id.trim(), document_id.trim())?)
            .ok_or("Drive project update size overflowed.")?;
        if total_bytes > MAX_PULL_BYTES {
            return Err("Drive project pull exceeds 32 MiB; compact it before continuing.".into());
        }
        updates.push(DriveProjectUpdate {
            id: file.id,
            update_base64: update.update_base64,
        });
    }
    Ok(DriveProjectPullResult { updates })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveProjectCanaryResult {
    pub passed: bool,
    pub workspace: String,
    pub project_listed: bool,
    pub updates_round_tripped: bool,
    pub cleanup_succeeded: bool,
}

/// Real-Drive headless transport canary. The frontend harness separately proves Yjs convergence;
/// this probe proves that two logical writers can append and retrieve immutable records through
/// the same Google endpoints used by the product, then removes its temporary project folder.
pub async fn run_live_canary(
    token: &str,
    workspace: DriveWorkspace,
) -> Result<DriveProjectCanaryResult, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let project_id = format!("canary{stamp}");
    let document_id = format!("document{stamp}");
    let manifest = StoredProjectManifest {
        schema_version: 1,
        project_id: project_id.clone(),
        document_id: document_id.clone(),
        title: "Temporary Drive project canary".into(),
        created_at: stamp as u64,
    };
    manifest.validate()?;
    let folder = project_folder(token, &workspace.id, &project_id, true)
        .await?
        .ok_or("Drive canary project folder could not be created.")?;

    let outcome = async {
        let content = serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?;
        create_text_file(token, &folder, MANIFEST_FILE, &content).await?;
        let first = push_update(
            token,
            &folder,
            &project_id,
            &document_id,
            "canaryA",
            STANDARD.encode(b"first immutable transport record"),
        )
        .await?;
        let second = push_update(
            token,
            &folder,
            &project_id,
            &document_id,
            "canaryB",
            STANDARD.encode(b"second immutable transport record"),
        )
        .await?;

        let root = project_root(token, &workspace.id, false)
            .await?
            .ok_or("Drive canary root was not visible after creation.")?;
        let project_listed = list_children(token, &root)
            .await?
            .iter()
            .any(|entry| entry.id == folder);
        let (verified_folder, _) =
            require_project_manifest(token, &workspace, &project_id, &document_id).await?;
        let updates_folder = find_child(
            token,
            &verified_folder,
            UPDATES_FOLDER,
            Some("application/vnd.google-apps.folder"),
        )
        .await?
        .ok_or("Drive canary updates folder was not visible after creation.")?;
        let ids = list_children(token, &updates_folder)
            .await?
            .into_iter()
            .map(|entry| entry.id)
            .collect::<HashSet<_>>();
        Ok::<_, String>((
            project_listed,
            ids.contains(&first.update_id) && ids.contains(&second.update_id),
        ))
    }
    .await;

    let cleanup = crate::google_drive::trash_file(token, &folder).await;
    match (outcome, cleanup) {
        (Ok((project_listed, updates_round_tripped)), Ok(())) => Ok(DriveProjectCanaryResult {
            passed: project_listed && updates_round_tripped,
            workspace: workspace.name,
            project_listed,
            updates_round_tripped,
            cleanup_succeeded: true,
        }),
        (Err(error), Ok(())) => Err(format!("{error} Temporary canary cleanup succeeded.")),
        (Ok(_), Err(cleanup_error)) => Err(cleanup_error),
        (Err(error), Err(cleanup_error)) => {
            Err(format!("{error} Cleanup also failed: {cleanup_error}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    struct DropCanary(Arc<AtomicBool>);

    impl Drop for DropCanary {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn whole_catalog_deadline_returns_success_and_cancels_stale_work() {
        tauri::async_runtime::block_on(async {
            let ready =
                with_drive_project_deadline("test catalog", Duration::from_millis(5), async {
                    Ok::<_, String>(42)
                })
                .await
                .expect("ready catalog");
            assert_eq!(ready, 42);

            let dropped = Arc::new(AtomicBool::new(false));
            let canary = DropCanary(dropped.clone());
            let error =
                with_drive_project_deadline("test catalog", Duration::from_millis(1), async move {
                    let _canary = canary;
                    std::future::pending::<Result<(), String>>().await
                })
                .await
                .expect_err("stale catalog must time out");
            assert_eq!(
                error,
                "Drive project test catalog exceeded its 1-millisecond deadline; retry after checking the connection."
            );
            assert!(dropped.load(Ordering::SeqCst));
        });
    }

    #[test]
    fn update_envelope_rechecks_identity_and_hash() {
        let update = StoredProjectUpdate::new("project-1", "document-1", STANDARD.encode(b"yjs"))
            .expect("valid update");
        assert_eq!(update.validate_for("project-1", "document-1"), Ok(3));
        assert!(update.validate_for("project-2", "document-1").is_err());

        let mut tampered = update;
        tampered.update_base64 = STANDARD.encode(b"evil");
        assert!(tampered.validate_for("project-1", "document-1").is_err());
    }

    #[test]
    fn identities_and_manifest_bounds_fail_closed() {
        assert!(valid_identity("project_1-ok"));
        assert!(!valid_identity("../project"));
        assert!(!valid_identity("project space"));
        let manifest = StoredProjectManifest {
            schema_version: 2,
            project_id: "project-1".into(),
            document_id: "document-1".into(),
            title: "Research".into(),
            created_at: 1,
        };
        assert!(manifest.validate().is_err());
    }

    fn title_manifest() -> StoredProjectManifest {
        StoredProjectManifest {
            schema_version: 1,
            project_id: "project-title".into(),
            document_id: "document-title".into(),
            title: "Original title".into(),
            created_at: 1,
        }
    }

    fn title_event(
        title: &str,
        participant_id: &str,
        timestamp: u64,
        mut parent_revisions: Vec<String>,
    ) -> StoredProjectTitleEvent {
        parent_revisions.sort();
        StoredProjectTitleEvent {
            schema_version: 1,
            project_id: "project-title".into(),
            document_id: "document-title".into(),
            parent_revisions,
            title: title.into(),
            participant_id: participant_id.into(),
            display_name: participant_id.into(),
            timestamp,
        }
    }

    fn title_event_file(event: &StoredProjectTitleEvent) -> ListedFile {
        let revision = title_event_revision(event).expect("title revision");
        ListedFile {
            id: format!("file-{revision}"),
            name: format!("{TITLE_EVENT_PREFIX}{revision}.json"),
            size: 0,
            description: Some(serde_json::to_string(event).expect("title event JSON")),
        }
    }

    fn title_repair_event_record(
        manifest: &StoredProjectManifest,
        event: &StoredProjectTitleEvent,
        location: TitleRepairLocation,
    ) -> TitleRepairRecord {
        let file = title_event_file(event);
        let raw = file.description.as_deref().expect("event description");
        TitleRepairRecord {
            payload: parse_title_event_repair_record(manifest, &file),
            content_sha256: format!("{:x}", Sha256::digest(raw.as_bytes())),
            observed_bytes: raw.len(),
            file,
            location,
        }
    }

    fn title_repair_snapshot_record(
        manifest: &StoredProjectManifest,
        snapshot: &StoredProjectTitleSnapshot,
        location: TitleRepairLocation,
    ) -> TitleRepairRecord {
        let revision = title_snapshot_revision(snapshot).expect("snapshot revision");
        let content = serde_json::to_string(snapshot).expect("snapshot JSON");
        let file = ListedFile {
            id: format!("snapshot-file-{revision}"),
            name: format!("{TITLE_SNAPSHOT_PREFIX}{revision}.json"),
            size: content.len(),
            description: None,
        };
        TitleRepairRecord {
            payload: parse_title_snapshot_repair_record(manifest, &file, &content),
            content_sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
            observed_bytes: content.len(),
            file,
            location,
        }
    }

    fn invalid_title_repair_record(location: TitleRepairLocation) -> TitleRepairRecord {
        let file = ListedFile {
            id: "invalid-title-file".into(),
            name: format!("{TITLE_EVENT_PREFIX}{}.json", "a".repeat(64)),
            size: 0,
            description: Some("{malformed".into()),
        };
        TitleRepairRecord {
            content_sha256: format!("{:x}", Sha256::digest(b"{malformed")),
            observed_bytes: 10,
            payload: Err("malformed fixture".into()),
            file,
            location,
        }
    }

    #[test]
    fn shared_title_repair_restores_archived_history_and_quarantines_only_active_damage() {
        let manifest = title_manifest();
        let root = title_event("Root", "alice", 10, vec![]);
        let root_revision = title_event_revision(&root).expect("root revision");
        let child = title_event("Child", "bob", 11, vec![root_revision]);
        let inventory = TitleRepairInventory {
            active: vec![invalid_title_repair_record(TitleRepairLocation::Active)],
            archived: vec![
                title_repair_event_record(&manifest, &root, TitleRepairLocation::Archive),
                title_repair_event_record(&manifest, &child, TitleRepairLocation::Archive),
            ],
            quarantined: vec![],
        };

        let plan = plan_title_repair(&manifest, &inventory).expect("repair plan");
        assert!(plan.repair_required);
        assert_eq!(plan.recoverable_events.len(), 2);
        assert_eq!(plan.quarantine_active.len(), 1);
        assert!(plan.archive_active.is_empty());
        assert_eq!(plan.invalid_archived_record_count, 0);
        assert_eq!(plan.snapshot.as_ref().expect("snapshot").events.len(), 2);
        assert_eq!(plan.inspection().move_count_this_run, 1);
    }

    #[test]
    fn shared_title_repair_archives_valid_active_records_only_after_complete_union_snapshot() {
        let manifest = title_manifest();
        let root = title_event("Root", "alice", 10, vec![]);
        let root_revision = title_event_revision(&root).expect("root revision");
        let child = title_event("Child", "bob", 11, vec![root_revision]);
        let inventory = TitleRepairInventory {
            active: vec![title_repair_event_record(
                &manifest,
                &root,
                TitleRepairLocation::Active,
            )],
            archived: vec![title_repair_event_record(
                &manifest,
                &child,
                TitleRepairLocation::Archive,
            )],
            quarantined: vec![],
        };

        let plan = plan_title_repair(&manifest, &inventory).expect("repair plan");
        assert!(plan.repair_required);
        assert_eq!(plan.recoverable_events.len(), 2);
        assert!(plan.quarantine_active.is_empty());
        assert_eq!(plan.archive_active.len(), 1);
        let snapshot = plan.snapshot.as_ref().expect("union snapshot");
        assert_eq!(snapshot.events.len(), 2);

        let healthy_inventory = TitleRepairInventory {
            active: vec![title_repair_snapshot_record(
                &manifest,
                snapshot,
                TitleRepairLocation::Active,
            )],
            archived: inventory.archived,
            quarantined: vec![],
        };
        let healthy = plan_title_repair(&manifest, &healthy_inventory).expect("healthy plan");
        assert!(!healthy.repair_required);
        assert!(healthy.quarantine_active.is_empty());
        assert!(healthy.archive_active.is_empty());
    }

    #[test]
    fn shared_title_repair_can_recover_valid_quarantine_without_trusting_malformed_records() {
        let manifest = title_manifest();
        let root = title_event("Recovered root", "alice", 10, vec![]);
        let inventory = TitleRepairInventory {
            active: vec![invalid_title_repair_record(TitleRepairLocation::Active)],
            archived: vec![],
            quarantined: vec![
                title_repair_event_record(&manifest, &root, TitleRepairLocation::Quarantine),
                invalid_title_repair_record(TitleRepairLocation::Quarantine),
            ],
        };

        let plan = plan_title_repair(&manifest, &inventory).expect("quarantine repair plan");
        assert!(plan.repair_required);
        assert_eq!(plan.recoverable_events.len(), 1);
        assert_eq!(plan.recoverable_quarantined_record_count, 1);
        assert_eq!(plan.invalid_quarantined_record_count, 1);
        assert_eq!(plan.quarantine_active.len(), 1);
        assert!(plan.snapshot.is_some());
    }

    #[test]
    fn shared_title_repair_guard_detects_changed_inventory_and_ignores_invalid_archive_orphans() {
        let manifest = title_manifest();
        let root = title_event("Root", "alice", 10, vec![]);
        let orphan = title_event("Orphan", "mallory", 11, vec!["b".repeat(64)]);
        let mut inventory = TitleRepairInventory {
            active: vec![invalid_title_repair_record(TitleRepairLocation::Active)],
            archived: vec![
                title_repair_event_record(&manifest, &root, TitleRepairLocation::Archive),
                title_repair_event_record(&manifest, &orphan, TitleRepairLocation::Archive),
            ],
            quarantined: vec![],
        };
        let first = plan_title_repair(&manifest, &inventory).expect("first plan");
        assert_eq!(first.recoverable_events.len(), 1);
        assert_eq!(first.invalid_archived_record_count, 1);

        inventory.archived[0].file.id.push_str("-changed");
        let second = plan_title_repair(&manifest, &inventory).expect("changed plan");
        assert_ne!(first.repair_revision, second.repair_revision);
        assert!(!title_repair_inventory_unchanged(
            &TitleRepairInventory {
                active: vec![],
                archived: vec![],
                quarantined: vec![],
            },
            &inventory,
            None,
            None,
        ));
    }

    #[test]
    fn shared_title_graph_retains_siblings_and_reconciles_every_tip() {
        let manifest = title_manifest();
        let base = project_title_state(&manifest, &[]).expect("base title");
        assert_eq!(base.title, "Original title");
        assert_eq!(base.revision_guards, vec![base_title_revision(&manifest)]);
        assert!(!base.conflict);

        let left = title_event("Left rename", "alice", 10, vec![]);
        let right = title_event("Right rename", "bob", 11, vec![]);
        let mut sibling_files = vec![title_event_file(&right), title_event_file(&left)];
        let siblings = project_title_state(&manifest, &sibling_files).expect("sibling titles");
        assert!(siblings.conflict);
        assert_eq!(siblings.event_count, 2);
        assert_eq!(siblings.active_event_count, 2);
        assert_eq!(siblings.snapshot_count, 0);
        assert_eq!(siblings.tips.len(), 2);
        assert_eq!(siblings.revision_guards.len(), 2);
        assert!(siblings.tips.iter().any(|tip| tip.title == "Left rename"));
        assert!(siblings.tips.iter().any(|tip| tip.title == "Right rename"));

        let merged = title_event(
            "Reconciled title",
            "carol",
            12,
            siblings.revision_guards.clone(),
        );
        sibling_files.push(title_event_file(&merged));
        let reconciled = project_title_state(&manifest, &sibling_files).expect("reconciled title");
        assert!(!reconciled.conflict);
        assert_eq!(reconciled.event_count, 3);
        assert_eq!(reconciled.title, "Reconciled title");
        assert_eq!(reconciled.tips.len(), 1);
        assert_eq!(reconciled.tips[0].parent_revisions.len(), 2);
    }

    #[test]
    fn shared_title_snapshot_retains_the_complete_graph_and_accepts_a_concurrent_child() {
        let manifest = title_manifest();
        let left = title_event("Left rename", "alice", 10, vec![]);
        let right = title_event("Right rename", "bob", 11, vec![]);
        let left_revision = title_event_revision(&left).expect("left revision");
        let right_revision = title_event_revision(&right).expect("right revision");
        let merged = title_event(
            "Reconciled title",
            "carol",
            12,
            vec![left_revision, right_revision],
        );
        let merged_revision = title_event_revision(&merged).expect("merged revision");
        let events = [left, right, merged]
            .into_iter()
            .map(|event| (title_event_revision(&event).expect("event revision"), event))
            .collect::<HashMap<_, _>>();
        let snapshot = StoredProjectTitleSnapshot::new(&manifest, &events).expect("snapshot");
        let snapshot_revision = title_snapshot_revision(&snapshot).expect("snapshot revision");
        let snapshot_file = ListedFile {
            id: "snapshot-file".into(),
            name: format!("{TITLE_SNAPSHOT_PREFIX}{snapshot_revision}.json"),
            size: serde_json::to_vec(&snapshot).expect("snapshot JSON").len(),
            description: None,
        };

        let retained =
            project_title_history(&manifest, &[], &[(snapshot_file.clone(), snapshot.clone())])
                .expect("retained history");
        assert_eq!(retained.state.title, "Reconciled title");
        assert_eq!(retained.state.event_count, 3);
        assert_eq!(retained.state.active_event_count, 0);
        assert_eq!(retained.state.snapshot_count, 1);

        let concurrent = title_event("Concurrent child", "dana", 13, vec![merged_revision]);
        let with_concurrent = project_title_history(
            &manifest,
            &[title_event_file(&concurrent)],
            &[(snapshot_file, snapshot)],
        )
        .expect("snapshot plus concurrent child");
        assert_eq!(with_concurrent.state.title, "Concurrent child");
        assert_eq!(with_concurrent.state.event_count, 4);
        assert_eq!(with_concurrent.state.active_event_count, 1);
        assert_eq!(with_concurrent.state.snapshot_count, 1);
    }

    #[test]
    fn shared_title_snapshot_rejects_noncanonical_or_incomplete_history() {
        let manifest = title_manifest();
        let root = title_event("Root", "alice", 10, vec![]);
        let child = title_event(
            "Child",
            "bob",
            11,
            vec![title_event_revision(&root).expect("root revision")],
        );
        let events = [root.clone(), child.clone()]
            .into_iter()
            .map(|event| (title_event_revision(&event).expect("event revision"), event))
            .collect::<HashMap<_, _>>();
        let mut snapshot = StoredProjectTitleSnapshot::new(&manifest, &events).expect("snapshot");
        snapshot.events.reverse();
        assert!(snapshot.validate_for(&manifest).is_err());

        let incomplete = StoredProjectTitleSnapshot {
            schema_version: 1,
            project_id: manifest.project_id.clone(),
            document_id: manifest.document_id.clone(),
            events: vec![child],
        };
        assert!(incomplete.validate_for(&manifest).is_err());
    }

    #[test]
    fn shared_title_graph_rejects_tampering_missing_parents_and_excess_history() {
        let manifest = title_manifest();
        let orphan = title_event("Orphan", "alice", 10, vec!["a".repeat(64)]);
        assert!(project_title_state(&manifest, &[title_event_file(&orphan)]).is_err());

        let event = title_event("Untampered", "alice", 11, vec![]);
        let mut tampered = title_event_file(&event);
        tampered.description = Some(
            serde_json::to_string(&title_event("Tampered", "alice", 11, vec![]))
                .expect("tampered JSON"),
        );
        assert!(project_title_state(&manifest, &[tampered]).is_err());

        let mut oversized_author = title_event("Valid title", "alice", 12, vec![]);
        oversized_author.display_name = "a".repeat(201);
        assert!(project_title_state(&manifest, &[title_event_file(&oversized_author)]).is_err());

        let mut chain = Vec::new();
        let mut parents = Vec::new();
        for index in 0..=MAX_TITLE_EVENTS {
            let event = title_event(
                &format!("Chain title {index}"),
                "alice",
                index as u64 + 20,
                parents,
            );
            parents = vec![title_event_revision(&event).expect("chain revision")];
            chain.push(title_event_file(&event));
        }
        let bounded_overflow = project_title_state(&manifest, &chain)
            .expect("bounded concurrent overflow remains readable for retention");
        assert_eq!(bounded_overflow.active_event_count, MAX_TITLE_EVENTS + 1);
        assert_eq!(bounded_overflow.revision_guards.len(), 1);

        let too_many_tips = (0..=MAX_TITLE_PARENTS)
            .map(|index| {
                title_event_file(&title_event(
                    &format!("Sibling {index}"),
                    "alice",
                    index as u64 + 1,
                    vec![],
                ))
            })
            .collect::<Vec<_>>();
        assert!(project_title_state(&manifest, &too_many_tips).is_err());

        let too_many = (0..=MAX_TITLE_EVENT_READS)
            .map(|index| {
                title_event_file(&title_event(
                    &format!("Title {index}"),
                    "alice",
                    index as u64 + 1,
                    vec![],
                ))
            })
            .collect::<Vec<_>>();
        assert!(project_title_state(&manifest, &too_many).is_err());
    }

    #[test]
    fn cross_workspace_discovery_rejects_ambiguous_or_orphan_roots() {
        let (roots, skipped) = unique_roots_by_workspace(vec![
            ProjectRoot {
                id: "root-a".into(),
                parent_ids: vec!["workspace-a".into()],
            },
            ProjectRoot {
                id: "root-b1".into(),
                parent_ids: vec!["workspace-b".into()],
            },
            ProjectRoot {
                id: "root-b2".into(),
                parent_ids: vec!["workspace-b".into()],
            },
            ProjectRoot {
                id: "orphan".into(),
                parent_ids: vec![],
            },
        ]);
        assert_eq!(roots, vec![("workspace-a".into(), "root-a".into())]);
        assert_eq!(skipped, 3);
    }

    #[test]
    fn compaction_archives_only_applied_records_and_bounds_each_batch() {
        let mut listed = (0..205)
            .map(|index| ListedFile {
                id: format!("known-{index:03}"),
                name: format!("update-known-{index:03}.json"),
                size: 100,
                description: None,
            })
            .collect::<Vec<_>>();
        listed.push(ListedFile {
            id: "snapshot".into(),
            name: "update-snapshot.json".into(),
            size: 100,
            description: None,
        });
        listed.push(ListedFile {
            id: "concurrent".into(),
            name: "update-concurrent.json".into(),
            size: 100,
            description: None,
        });
        listed.push(ListedFile {
            id: "manifest-like".into(),
            name: "notes.txt".into(),
            size: 100,
            description: None,
        });
        let mut included = (0..205)
            .map(|index| format!("known-{index:03}"))
            .collect::<HashSet<_>>();
        included.insert("snapshot".into());
        included.insert("already-archived".into());

        let plan = plan_compaction(&listed, &included, "snapshot");
        assert_eq!(plan.archive_ids.len(), MAX_COMPACTION_BATCH);
        assert_eq!(
            plan.archive_ids.first().map(String::as_str),
            Some("known-000")
        );
        assert_eq!(
            plan.archive_ids.last().map(String::as_str),
            Some("known-199")
        );
        assert_eq!(plan.remaining_included_count, 5);
        assert_eq!(plan.retained_concurrent_count, 1);
        assert!(!plan.archive_ids.contains(&"snapshot".to_string()));
        assert!(!plan.archive_ids.contains(&"concurrent".to_string()));
    }

    #[test]
    fn compaction_retry_with_only_its_snapshot_is_a_zero_move_plan() {
        let listed = vec![ListedFile {
            id: "snapshot".into(),
            name: "update-snapshot.json".into(),
            size: 100,
            description: None,
        }];
        let included = HashSet::from(["snapshot".to_string(), "already-archived".to_string()]);
        assert_eq!(
            plan_compaction(&listed, &included, "snapshot"),
            CompactionPlan {
                archive_ids: Vec::new(),
                remaining_included_count: 0,
                retained_concurrent_count: 0,
            }
        );
    }
}

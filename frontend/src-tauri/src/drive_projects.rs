//! Append-only Google Drive transport for collaborative Yjs project updates.
//! Each coalesced update is an immutable file. Concurrent writers therefore never replace one
//! another; Yjs is the merge authority and local IndexedDB remains the offline durability layer.

use crate::google_drive::{selected_workspace_access, DriveWorkspace};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const FILES_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_ENDPOINT: &str = "https://www.googleapis.com/upload/drive/v3/files";
const PROJECTS_FOLDER: &str = ".syzygy-projects";
const MANIFEST_FILE: &str = "manifest.json";
const UPDATES_FOLDER: &str = "updates";
const MAX_UPDATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PULL_BYTES: usize = 32 * 1024 * 1024;
const MAX_UPDATE_FILES: usize = 5_000;
const MAX_KNOWN_IDS: usize = 10_000;

fn esc(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
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
    let response = reqwest::Client::new()
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
    let response = reqwest::Client::new()
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
    let response = reqwest::Client::new()
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

async fn read_text_file(token: &str, file_id: &str) -> Result<String, String> {
    let response = reqwest::Client::new()
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

#[derive(Debug)]
struct ListedFile {
    id: String,
    name: String,
    size: usize,
}

async fn list_children(token: &str, parent_id: &str) -> Result<Vec<ListedFile>, String> {
    let query = format!("'{}' in parents and trashed = false", esc(parent_id));
    let mut page_token: Option<String> = None;
    let mut files = Vec::new();
    loop {
        let mut request = reqwest::Client::new()
            .get(FILES_ENDPOINT)
            .bearer_auth(token)
            .query(&[
                ("q", query.as_str()),
                ("fields", "nextPageToken,files(id,name,size)"),
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
                });
                if files.len() > MAX_UPDATE_FILES {
                    return Err("Drive project contains too many update records; compact it before continuing.".into());
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveProjectDescriptor {
    schema_version: u8,
    project_id: String,
    document_id: String,
    title: String,
    created_at: u64,
    workspace_id: String,
}

impl DriveProjectDescriptor {
    fn from_manifest(manifest: StoredProjectManifest, workspace: &DriveWorkspace) -> Self {
        Self {
            schema_version: manifest.schema_version,
            project_id: manifest.project_id,
            document_id: manifest.document_id,
            title: manifest.title,
            created_at: manifest.created_at,
            workspace_id: workspace.id.clone(),
        }
    }
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
    let (token, workspace) = selected_workspace_access(&app).await?;
    let Some(root) = project_root(&token, &workspace.id, false).await? else {
        return Ok(Vec::new());
    };
    let folders = list_children(&token, &root).await?;
    let mut projects = Vec::new();
    for folder in folders
        .into_iter()
        .filter(|file| file.name.starts_with("project-"))
    {
        let Some(manifest_id) = find_child(&token, &folder.id, MANIFEST_FILE, None).await? else {
            continue;
        };
        let manifest: StoredProjectManifest =
            serde_json::from_str(&read_text_file(&token, &manifest_id).await?)
                .map_err(|_| "A Drive project manifest is malformed.".to_string())?;
        manifest.validate()?;
        projects.push(DriveProjectDescriptor::from_manifest(manifest, &workspace));
    }
    projects.sort_by(|left, right| {
        left.title
            .cmp(&right.title)
            .then(left.project_id.cmp(&right.project_id))
    });
    Ok(projects)
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
}

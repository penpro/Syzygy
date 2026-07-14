//! Google Drive file operations — the primitives the shared-folder collaboration builds on.
//! Everything runs through the Rust core with a fresh access token from google_auth; the
//! webview only ever sees file names/contents it asked for. Scope is `drive.file`, so all of
//! this can only touch files/folders this app created (or the user explicitly picked).

use crate::google_auth::access_token;
use serde::Serialize;

const FILES_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_ENDPOINT: &str = "https://www.googleapis.com/upload/drive/v3/files";

fn esc(q: &str) -> String {
    q.replace('\\', "\\\\").replace('\'', "\\'")
}

async fn drive_get_json(token: &str, url: &str, query: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .query(query)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(msg) = v["error"]["message"].as_str() {
        return Err(format!("Drive: {msg}"));
    }
    Ok(v)
}

/// Find a folder by name (non-trashed), or create it. Returns the folder id.
pub(crate) async fn find_or_create_folder(token: &str, name: &str) -> Result<String, String> {
    let q = format!(
        "name = '{}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        esc(name)
    );
    let found = drive_get_json(token, FILES_ENDPOINT, &[("q", q.as_str()), ("fields", "files(id)")]).await?;
    if let Some(id) = found["files"].get(0).and_then(|f| f["id"].as_str()) {
        return Ok(id.to_string());
    }
    let created: serde_json::Value = reqwest::Client::new()
        .post(FILES_ENDPOINT)
        .bearer_auth(token)
        .json(&serde_json::json!({ "name": name, "mimeType": "application/vnd.google-apps.folder" }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    created["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("Drive: no folder id in response: {created}"))
}

/// Find a file by name inside a folder. Returns Some(id) when present.
async fn find_file(token: &str, folder_id: &str, name: &str) -> Result<Option<String>, String> {
    let q = format!("name = '{}' and '{}' in parents and trashed = false", esc(name), esc(folder_id));
    let found = drive_get_json(token, FILES_ENDPOINT, &[("q", q.as_str()), ("fields", "files(id)")]).await?;
    Ok(found["files"].get(0).and_then(|f| f["id"].as_str()).map(str::to_string))
}

async fn read_file_content(token: &str, file_id: &str) -> Result<String, String> {
    let resp = reqwest::Client::new()
        .get(format!("{FILES_ENDPOINT}/{file_id}"))
        .bearer_auth(token)
        .query(&[("alt", "media")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Drive read failed: HTTP {}", resp.status()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

/// Create a text file in a folder (multipart: metadata + content in one request).
async fn create_text_file(token: &str, folder_id: &str, name: &str, content: &str) -> Result<String, String> {
    let meta = serde_json::json!({ "name": name, "parents": [folder_id] }).to_string();
    let form = reqwest::multipart::Form::new()
        .part(
            "metadata",
            reqwest::multipart::Part::text(meta).mime_str("application/json").map_err(|e| e.to_string())?,
        )
        .part(
            "media",
            reqwest::multipart::Part::text(content.to_string())
                .mime_str("text/plain")
                .map_err(|e| e.to_string())?,
        );
    let v: serde_json::Value = reqwest::Client::new()
        .post(UPLOAD_ENDPOINT)
        .bearer_auth(token)
        .query(&[("uploadType", "multipart"), ("fields", "id")])
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    v["id"].as_str().map(str::to_string).ok_or_else(|| format!("Drive: no file id in response: {v}"))
}

/// Overwrite an existing file's content (media upload PATCH).
async fn update_text_file(token: &str, file_id: &str, content: &str) -> Result<(), String> {
    let resp = reqwest::Client::new()
        .patch(format!("{UPLOAD_ENDPOINT}/{file_id}"))
        .bearer_auth(token)
        .query(&[("uploadType", "media")])
        .header("Content-Type", "text/plain")
        .body(content.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Drive update failed: HTTP {}", resp.status()));
    }
    Ok(())
}

// ---------------- commands ----------------

/// Append text to `<file_name>` inside `<folder_name>` (both created on demand).
/// The write primitive of the shared-folder test: read-modify-write of a text file.
#[tauri::command]
pub async fn google_drive_append_text(
    app: tauri::AppHandle,
    folder_name: String,
    file_name: String,
    content: String,
) -> Result<String, String> {
    let token = access_token(&app).await?;
    let folder_id = find_or_create_folder(&token, &folder_name).await?;
    match find_file(&token, &folder_id, &file_name).await? {
        Some(file_id) => {
            let existing = read_file_content(&token, &file_id).await?;
            let merged = if existing.is_empty() { content } else { format!("{existing}\n{content}") };
            update_text_file(&token, &file_id, &merged).await?;
            Ok(file_id)
        }
        None => create_text_file(&token, &folder_id, &file_name, &content).await,
    }
}

#[derive(Serialize)]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub modified: String,
    pub size: Option<String>,
}

/// List files inside `<folder_name>` (created on demand), newest first.
/// The read primitive of the shared-folder test.
#[tauri::command]
pub async fn google_drive_list_folder(app: tauri::AppHandle, folder_name: String) -> Result<Vec<DriveFile>, String> {
    let token = access_token(&app).await?;
    let folder_id = find_or_create_folder(&token, &folder_name).await?;
    let q = format!("'{}' in parents and trashed = false", esc(&folder_id));
    let v = drive_get_json(
        &token,
        FILES_ENDPOINT,
        &[
            ("q", q.as_str()),
            ("orderBy", "modifiedTime desc"),
            ("fields", "files(id,name,modifiedTime,size)"),
            ("pageSize", "50"),
        ],
    )
    .await?;
    let files = v["files"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|f| {
                    Some(DriveFile {
                        id: f["id"].as_str()?.to_string(),
                        name: f["name"].as_str()?.to_string(),
                        modified: f["modifiedTime"].as_str().unwrap_or("").to_string(),
                        size: f["size"].as_str().map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(files)
}

/// Read a text file's content by id.
#[tauri::command]
pub async fn google_drive_read_file(app: tauri::AppHandle, file_id: String) -> Result<String, String> {
    let token = access_token(&app).await?;
    read_file_content(&token, &file_id).await
}

// ---------------- folder mirror sync ----------------
// The bridge that makes Drive a first-class destination: a local folder (Documents/Syzygy)
// kept in sync with the Drive folder. Everything that already understands local folders —
// knowledge retrieval, document generation — gets Drive for free by pointing at the mirror.

use std::path::PathBuf;
use tauri::Manager;

fn rfc3339_to_epoch(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|t| t.timestamp())
}

fn file_mtime_epoch(p: &std::path::Path) -> Option<i64> {
    let meta = std::fs::metadata(p).ok()?;
    let m = meta.modified().ok()?;
    m.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs() as i64)
}

fn mime_for(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "md" | "markdown" => "text/markdown",
        "txt" | "log" => "text/plain",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

/// The local mirror of the shared Drive folder: `<Documents>/Syzygy`, created on demand and
/// granted so the document/knowledge commands may read and write inside it.
#[tauri::command]
pub fn google_drive_mirror_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir: PathBuf = app.path().document_dir().map_err(|e| e.to_string())?.join("Syzygy");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Ok(canon) = std::fs::canonicalize(&dir) {
        app.state::<crate::state::Granted>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(canon);
    }
    Ok(dir.to_string_lossy().to_string())
}

#[derive(Serialize)]
pub struct SyncReport {
    pub pulled: u32,
    pub pushed: u32,
    pub mirror: String,
}

/// Two-way sync between the Drive folder and the local mirror. Last-write-wins by modified
/// time (±2s slack for clock skew); after each transfer the local mtime is pinned to Drive's
/// modifiedTime so a completed sync is a stable fixpoint, not a ping-pong.
#[tauri::command]
pub async fn google_drive_sync_folder(app: tauri::AppHandle, folder_name: String) -> Result<SyncReport, String> {
    const SLACK: i64 = 2;
    let token = access_token(&app).await?;
    let folder_id = find_or_create_folder(&token, &folder_name).await?;
    let mirror = google_drive_mirror_dir(app.clone())?;
    let mirror_path = PathBuf::from(&mirror);
    let client = reqwest::Client::new();

    // Remote inventory (plain files only — native Google Docs types can't download as media).
    let q = format!("'{}' in parents and trashed = false", esc(&folder_id));
    let v = drive_get_json(
        &token,
        FILES_ENDPOINT,
        &[("q", q.as_str()), ("fields", "files(id,name,mimeType,modifiedTime)"), ("pageSize", "200")],
    )
    .await?;
    let mut remote: std::collections::HashMap<String, (String, i64)> = std::collections::HashMap::new();
    for f in v["files"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let (Some(id), Some(name), Some(mt)) = (f["id"].as_str(), f["name"].as_str(), f["modifiedTime"].as_str())
        else {
            continue;
        };
        if f["mimeType"].as_str().unwrap_or("").starts_with("application/vnd.google-apps") {
            continue;
        }
        remote.insert(name.to_string(), (id.to_string(), rfc3339_to_epoch(mt).unwrap_or(0)));
    }

    let mut pulled = 0u32;
    let mut pushed = 0u32;

    // Pull: remote file missing locally, or newer than the local copy.
    for (name, (id, rtime)) in &remote {
        let local = mirror_path.join(name);
        let ltime = file_mtime_epoch(&local);
        if ltime.map_or(true, |lt| *rtime > lt + SLACK) {
            let resp = client
                .get(format!("{FILES_ENDPOINT}/{id}"))
                .bearer_auth(&token)
                .query(&[("alt", "media")])
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("Drive pull of {name} failed: HTTP {}", resp.status()));
            }
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            std::fs::write(&local, &bytes).map_err(|e| e.to_string())?;
            let _ = filetime::set_file_mtime(&local, filetime::FileTime::from_unix_time(*rtime, 0));
            pulled += 1;
        }
    }

    // Push: local file missing remotely, or newer than the Drive copy.
    let entries = std::fs::read_dir(&mirror_path).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
        let ltime = file_mtime_epoch(&path).unwrap_or(0);
        let needs_push = match remote.get(&name) {
            None => true,
            Some((_, rtime)) => ltime > rtime + SLACK,
        };
        if !needs_push {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let mime = mime_for(&name);
        let new_rtime: Option<String> = match remote.get(&name) {
            Some((id, _)) => {
                // overwrite existing content
                let resp = client
                    .patch(format!("{UPLOAD_ENDPOINT}/{id}"))
                    .bearer_auth(&token)
                    .query(&[("uploadType", "media"), ("fields", "modifiedTime")])
                    .header("Content-Type", mime)
                    .body(bytes)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                v["modifiedTime"].as_str().map(str::to_string)
            }
            None => {
                let meta = serde_json::json!({ "name": name, "parents": [folder_id] }).to_string();
                let form = reqwest::multipart::Form::new()
                    .part(
                        "metadata",
                        reqwest::multipart::Part::text(meta)
                            .mime_str("application/json")
                            .map_err(|e| e.to_string())?,
                    )
                    .part(
                        "media",
                        reqwest::multipart::Part::bytes(bytes).mime_str(mime).map_err(|e| e.to_string())?,
                    );
                let v: serde_json::Value = client
                    .post(UPLOAD_ENDPOINT)
                    .bearer_auth(&token)
                    .query(&[("uploadType", "multipart"), ("fields", "id,modifiedTime")])
                    .multipart(form)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?
                    .json()
                    .await
                    .map_err(|e| e.to_string())?;
                v["modifiedTime"].as_str().map(str::to_string)
            }
        };
        // Pin the local mtime to Drive's authoritative time so the next sync is a no-op.
        if let Some(rt) = new_rtime.and_then(|s| rfc3339_to_epoch(&s)) {
            let _ = filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(rt, 0));
        }
        pushed += 1;
    }

    Ok(SyncReport { pulled, pushed, mirror })
}

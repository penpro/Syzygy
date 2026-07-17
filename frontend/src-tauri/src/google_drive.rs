//! Google Drive file operations — the primitives the shared-folder collaboration builds on.
//! Everything runs through the Rust core with a fresh access token from google_auth; the
//! webview only ever sees the folder names needed for selection and the file text it requested.
//! Google grants broad collaboration scope; this module enforces one persisted workspace folder
//! boundary and descendant checks for product reads/writes.

use crate::google_auth::{access_token, require_collaboration_access};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use tauri::Manager;

const FILES_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_ENDPOINT: &str = "https://www.googleapis.com/upload/drive/v3/files";
const SHEETS_ENDPOINT: &str = "https://sheets.googleapis.com/v4/spreadsheets";

fn esc(q: &str) -> String {
    q.replace('\\', "\\\\").replace('\'', "\\'")
}

fn shared_drive_query<'a>(
    query: &[(&'a str, &'a str)],
    include_items: bool,
) -> Vec<(&'a str, &'a str)> {
    let mut params = query.to_vec();
    if !params.iter().any(|(key, _)| *key == "supportsAllDrives") {
        params.push(("supportsAllDrives", "true"));
    }
    if include_items
        && !params
            .iter()
            .any(|(key, _)| *key == "includeItemsFromAllDrives")
    {
        params.push(("includeItemsFromAllDrives", "true"));
    }
    params
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveWorkspace {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveWorkspaceOption {
    pub id: String,
    pub name: String,
    pub modified: String,
}

fn workspace_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("drive_workspace.json"))
}

fn read_workspace(app: &tauri::AppHandle) -> Option<DriveWorkspace> {
    let text = std::fs::read_to_string(workspace_file(app).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_workspace(app: &tauri::AppHandle, workspace: &DriveWorkspace) -> Result<(), String> {
    let path = workspace_file(app)?;
    std::fs::write(
        path,
        serde_json::to_string_pretty(workspace).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

async fn drive_get_json(
    token: &str,
    url: &str,
    query: &[(&str, &str)],
    operation: &str,
) -> Result<serde_json::Value, String> {
    let query = shared_drive_query(query, url == FILES_ENDPOINT);
    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .query(&query)
        .send()
        .await
        .map_err(|e| format!("Drive {operation} failed before Google responded: {e}"))?;
    drive_json_response(resp, operation).await
}

async fn require_drive_success(
    resp: reqwest::Response,
    operation: &str,
) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("Google returned HTTP {status}"));
    Err(format!(
        "Drive {operation} failed: {message} (HTTP {status})"
    ))
}

async fn drive_json_response(
    resp: reqwest::Response,
    operation: &str,
) -> Result<serde_json::Value, String> {
    require_drive_success(resp, operation)
        .await?
        .json()
        .await
        .map_err(|e| format!("Drive {operation} returned unreadable JSON: {e}"))
}

/// Find a folder by name (non-trashed), or create it. Returns the folder id.
pub(crate) async fn find_or_create_folder(token: &str, name: &str) -> Result<String, String> {
    let q = format!(
        "name = '{}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        esc(name)
    );
    let found = drive_get_json(
        token,
        FILES_ENDPOINT,
        &[
            ("q", q.as_str()),
            ("fields", "files(id)"),
            ("pageSize", "3"),
            ("supportsAllDrives", "true"),
            ("includeItemsFromAllDrives", "true"),
        ],
        "folder lookup",
    )
    .await?;
    if found["files"].as_array().map_or(0, Vec::len) > 1 {
        return Err(format!(
            "More than one Drive folder is named {name:?}. Choose the workspace folder explicitly."
        ));
    }
    if let Some(id) = found["files"].get(0).and_then(|f| f["id"].as_str()) {
        return Ok(id.to_string());
    }
    let created = reqwest::Client::new()
        .post(FILES_ENDPOINT)
        .bearer_auth(token)
        .query(&[("supportsAllDrives", "true"), ("fields", "id")])
        .json(
            &serde_json::json!({ "name": name, "mimeType": "application/vnd.google-apps.folder" }),
        )
        .send()
        .await
        .map_err(|e| format!("Drive folder creation failed before Google responded: {e}"))?;
    let created = drive_json_response(created, "folder creation").await?;
    created["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("Drive: no folder id in response: {created}"))
}

/// Read-only folder lookup for the headless harness. The shipping app persists an explicit
/// folder id and does not repeatedly rely on a potentially ambiguous name.
pub async fn find_folder_by_name(
    token: &str,
    name: &str,
) -> Result<Option<DriveWorkspace>, String> {
    let q = format!(
        "name = '{}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        esc(name)
    );
    let value = drive_get_json(
        token,
        FILES_ENDPOINT,
        &[
            ("q", q.as_str()),
            ("fields", "files(id,name)"),
            ("pageSize", "10"),
            ("supportsAllDrives", "true"),
            ("includeItemsFromAllDrives", "true"),
        ],
        "folder lookup",
    )
    .await?;
    Ok(value["files"].get(0).and_then(|file| {
        Some(DriveWorkspace {
            id: file["id"].as_str()?.to_string(),
            name: file["name"].as_str()?.to_string(),
        })
    }))
}

pub(crate) async fn folder_metadata(token: &str, id: &str) -> Result<DriveWorkspace, String> {
    let url = format!("{FILES_ENDPOINT}/{id}");
    let value = drive_get_json(
        token,
        &url,
        &[
            ("fields", "id,name,mimeType,trashed"),
            ("supportsAllDrives", "true"),
        ],
        "workspace validation",
    )
    .await?;
    if value["trashed"].as_bool() == Some(true)
        || value["mimeType"].as_str() != Some("application/vnd.google-apps.folder")
    {
        return Err("The selected Drive workspace is missing, trashed, or is not a folder.".into());
    }
    Ok(DriveWorkspace {
        id: value["id"]
            .as_str()
            .ok_or("Drive folder has no id.")?
            .to_string(),
        name: value["name"]
            .as_str()
            .unwrap_or("Drive workspace")
            .to_string(),
    })
}

async fn resolve_workspace(
    app: &tauri::AppHandle,
    token: &str,
    fallback_name: &str,
) -> Result<DriveWorkspace, String> {
    if let Some(saved) = read_workspace(app) {
        let current = folder_metadata(token, &saved.id).await?;
        if current.name != saved.name {
            write_workspace(app, &current)?;
        }
        return Ok(current);
    }
    let id = find_or_create_folder(token, fallback_name).await?;
    let workspace = folder_metadata(token, &id).await?;
    write_workspace(app, &workspace)?;
    Ok(workspace)
}

/// Return the selected workspace, if one has been persisted locally.
#[tauri::command]
pub fn google_drive_workspace(app: tauri::AppHandle) -> Option<DriveWorkspace> {
    read_workspace(&app)
}

/// Return a fresh collaboration token and the exact persisted workspace after revalidating its
/// folder identity. Drive-backed project transport never accepts an arbitrary folder id from the
/// webview.
pub(crate) async fn selected_workspace_access(
    app: &tauri::AppHandle,
) -> Result<(String, DriveWorkspace), String> {
    let token = collaboration_access(app).await?;
    let saved = read_workspace(app).ok_or("Choose a Drive workspace before sharing projects.")?;
    let workspace = folder_metadata(&token, &saved.id).await?;
    Ok((token, workspace))
}

/// Return a fresh collaboration token without widening any product read/write boundary. This is
/// used by explicit workspace discovery surfaces that enumerate only Syzygy-owned project roots;
/// normal research operations continue to require `selected_workspace_access`.
pub(crate) async fn collaboration_access(app: &tauri::AppHandle) -> Result<String, String> {
    require_collaboration_access(app)?;
    access_token(app).await
}

/// List folders the connected account can choose as the collaboration workspace. This command
/// is intentionally unavailable to legacy app-file-only grants.
#[tauri::command]
pub async fn google_drive_list_workspaces(
    app: tauri::AppHandle,
) -> Result<Vec<DriveWorkspaceOption>, String> {
    require_collaboration_access(&app)?;
    let token = access_token(&app).await?;
    let q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    let value = drive_get_json(
        &token,
        FILES_ENDPOINT,
        &[
            ("q", q),
            ("orderBy", "name"),
            ("fields", "files(id,name,modifiedTime)"),
            ("pageSize", "1000"),
            ("spaces", "drive"),
            ("supportsAllDrives", "true"),
            ("includeItemsFromAllDrives", "true"),
        ],
        "workspace listing",
    )
    .await?;
    Ok(value["files"]
        .as_array()
        .map(|files| {
            files
                .iter()
                .filter_map(|file| {
                    Some(DriveWorkspaceOption {
                        id: file["id"].as_str()?.to_string(),
                        name: file["name"].as_str()?.to_string(),
                        modified: file["modifiedTime"].as_str().unwrap_or("").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Persist an explicit Drive folder boundary after validating it with the current account.
#[tauri::command]
pub async fn google_drive_select_workspace(
    app: tauri::AppHandle,
    folder_id: String,
) -> Result<DriveWorkspace, String> {
    require_collaboration_access(&app)?;
    let token = access_token(&app).await?;
    let workspace = folder_metadata(&token, folder_id.trim()).await?;
    write_workspace(&app, &workspace)?;
    Ok(workspace)
}

/// Find a file by name inside a folder. Returns Some(id) when present.
async fn find_file(token: &str, folder_id: &str, name: &str) -> Result<Option<String>, String> {
    let q = format!(
        "name = '{}' and '{}' in parents and trashed = false",
        esc(name),
        esc(folder_id)
    );
    let found = drive_get_json(
        token,
        FILES_ENDPOINT,
        &[
            ("q", q.as_str()),
            ("fields", "files(id)"),
            ("supportsAllDrives", "true"),
            ("includeItemsFromAllDrives", "true"),
        ],
        "transcript lookup",
    )
    .await?;
    Ok(found["files"]
        .get(0)
        .and_then(|f| f["id"].as_str())
        .map(str::to_string))
}

async fn read_file_content(token: &str, file_id: &str) -> Result<String, String> {
    let resp = reqwest::Client::new()
        .get(format!("{FILES_ENDPOINT}/{file_id}"))
        .bearer_auth(token)
        .query(&[("alt", "media"), ("supportsAllDrives", "true")])
        .send()
        .await
        .map_err(|e| format!("Drive transcript read failed before Google responded: {e}"))?;
    require_drive_success(resp, "transcript read")
        .await?
        .text()
        .await
        .map_err(|e| format!("Drive transcript read failed: {e}"))
}

/// Create a text file in a folder (multipart: metadata + content in one request).
async fn create_text_file(
    token: &str,
    folder_id: &str,
    name: &str,
    content: &str,
) -> Result<String, String> {
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
            reqwest::multipart::Part::text(content.to_string())
                .mime_str("text/plain")
                .map_err(|e| e.to_string())?,
        );
    let v = reqwest::Client::new()
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
        .map_err(|e| format!("Drive transcript creation failed before Google responded: {e}"))?;
    let v = drive_json_response(v, "transcript creation").await?;
    v["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("Drive: no file id in response: {v}"))
}

/// Overwrite an existing file's content (media upload PATCH).
async fn update_text_file(token: &str, file_id: &str, content: &str) -> Result<(), String> {
    let resp = reqwest::Client::new()
        .patch(format!("{UPLOAD_ENDPOINT}/{file_id}"))
        .bearer_auth(token)
        .query(&[("uploadType", "media"), ("supportsAllDrives", "true")])
        .header("Content-Type", "text/plain")
        .body(content.to_string())
        .send()
        .await
        .map_err(|e| format!("Drive transcript update failed before Google responded: {e}"))?;
    require_drive_success(resp, "transcript update").await?;
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
    require_collaboration_access(&app)?;
    let token = access_token(&app).await?;
    let workspace = resolve_workspace(&app, &token, &folder_name).await?;
    match find_file(&token, &workspace.id, &file_name).await? {
        Some(file_id) => {
            let existing = read_file_content(&token, &file_id).await?;
            let merged = if existing.is_empty() {
                content
            } else {
                format!("{existing}\n{content}")
            };
            update_text_file(&token, &file_id, &merged).await?;
            Ok(file_id)
        }
        None => create_text_file(&token, &workspace.id, &file_name, &content).await,
    }
}

#[derive(Serialize)]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub modified: String,
    pub size: Option<String>,
}

fn export_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "application/vnd.google-apps.document" => Some("text/plain"),
        "application/vnd.google-apps.spreadsheet" => Some("text/csv"),
        "application/vnd.google-apps.presentation" => Some("text/plain"),
        _ => None,
    }
}

async fn drive_file_bytes(
    client: &reqwest::Client,
    token: &str,
    id: &str,
    mime: &str,
) -> Result<Option<Vec<u8>>, String> {
    let request = if let Some(export_as) = export_mime(mime) {
        client
            .get(format!("{FILES_ENDPOINT}/{id}/export"))
            .bearer_auth(token)
            .query(&[("mimeType", export_as)])
    } else if mime.starts_with("application/vnd.google-apps") {
        return Ok(None);
    } else {
        client
            .get(format!("{FILES_ENDPOINT}/{id}"))
            .bearer_auth(token)
            .query(&[("alt", "media"), ("supportsAllDrives", "true")])
    };
    let resp = request
        .send()
        .await
        .map_err(|e| format!("Drive source read failed before Google responded: {e}"))?;
    let resp = require_drive_success(resp, "source read").await?;
    Ok(Some(
        resp.bytes().await.map_err(|e| e.to_string())?.to_vec(),
    ))
}

fn supported_text(mime: &str, bytes: &[u8]) -> Option<String> {
    if mime == "application/pdf" {
        crate::knowledge::extract_pdf_bytes(bytes).ok()
    } else if mime.starts_with("text/") || mime == "application/json" || export_mime(mime).is_some()
    {
        Some(
            String::from_utf8_lossy(bytes)
                .trim_start_matches('\u{feff}')
                .to_string(),
        )
    } else {
        None
    }
}

#[derive(Clone, Debug)]
struct RemoteFile {
    id: String,
    path: String,
    mime: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveContextReport {
    pub context: String,
    /// Native Google-file evidence used by the headless canary proof. The webview receives the
    /// normal relevance-ranked context only; this duplicate diagnostic view stays in Rust.
    #[serde(skip_serializing)]
    pub native_context: String,
    pub workspace: DriveWorkspace,
    pub visible_files: usize,
    pub supported_files: usize,
    pub native_files: usize,
    pub sources: Vec<String>,
    pub editable_files: Vec<DriveEditableFile>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveEditableFile {
    pub id: String,
    pub path: String,
    pub kind: String,
}

/// Recursively enumerate the selected workspace with pagination and a hard cap. The cap keeps
/// an unexpectedly huge folder from turning one Ask request into an unbounded Drive crawl.
async fn list_folder_tree(
    token: &str,
    root_id: &str,
    max_files: usize,
) -> Result<Vec<RemoteFile>, String> {
    let mut queue = VecDeque::from([(root_id.to_string(), String::new(), 0usize)]);
    let mut files = Vec::new();
    while let Some((folder_id, prefix, depth)) = queue.pop_front() {
        if depth > 12 {
            return Err(
                "Drive workspace nesting exceeds the supported depth of 12 folders.".into(),
            );
        }
        let q = format!("'{}' in parents and trashed = false", esc(&folder_id));
        let mut page_token: Option<String> = None;
        loop {
            let mut params = vec![
                ("q", q.as_str()),
                ("fields", "nextPageToken,files(id,name,mimeType)"),
                ("pageSize", "1000"),
                ("supportsAllDrives", "true"),
                ("includeItemsFromAllDrives", "true"),
            ];
            if let Some(page) = page_token.as_deref() {
                params.push(("pageToken", page));
            }
            let value =
                drive_get_json(token, FILES_ENDPOINT, &params, "workspace traversal").await?;
            for file in value["files"]
                .as_array()
                .map(|a| a.as_slice())
                .unwrap_or(&[])
            {
                let (Some(id), Some(name), Some(mime)) = (
                    file["id"].as_str(),
                    file["name"].as_str(),
                    file["mimeType"].as_str(),
                ) else {
                    continue;
                };
                let path = if prefix.is_empty() {
                    name.to_string()
                } else {
                    format!("{prefix}/{name}")
                };
                if mime == "application/vnd.google-apps.folder" {
                    queue.push_back((id.to_string(), path, depth + 1));
                } else {
                    files.push(RemoteFile {
                        id: id.to_string(),
                        path,
                        mime: mime.to_string(),
                    });
                    if files.len() > max_files {
                        return Err(format!(
                            "Drive workspace contains more than {max_files} files. Choose a narrower workspace or use explicit Sync."
                        ));
                    }
                }
            }
            page_token = value["nextPageToken"].as_str().map(str::to_string);
            if page_token.is_none() {
                break;
            }
        }
    }
    Ok(files)
}

pub async fn retrieve_context_report(
    token: &str,
    workspace: DriveWorkspace,
    query: &str,
    max_chars: usize,
) -> Result<DriveContextReport, String> {
    let files = list_folder_tree(token, &workspace.id, 2_000).await?;
    let client = reqwest::Client::new();
    let mut chunks = Vec::new();
    let mut native_chunks = Vec::new();
    let mut sources = Vec::new();
    let mut native_files = 0usize;
    let mut supported_files = 0usize;
    let mut editable_files = Vec::new();
    for file in &files {
        let is_native = export_mime(&file.mime).is_some();
        if is_native {
            native_files += 1;
        }
        if file.mime == "application/vnd.google-apps.spreadsheet" {
            editable_files.push(DriveEditableFile {
                id: file.id.clone(),
                path: file.path.clone(),
                kind: "spreadsheet".into(),
            });
        }
        let Some(bytes) = drive_file_bytes(&client, token, &file.id, &file.mime).await? else {
            continue;
        };
        let text = supported_text(&file.mime, &bytes);
        if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
            supported_files += 1;
            sources.push(file.path.clone());
            for chunk in crate::knowledge::chunk_text(&text) {
                if is_native {
                    native_chunks.push((file.path.clone(), chunk.clone()));
                }
                chunks.push((file.path.clone(), chunk));
            }
        }
    }
    let context = crate::knowledge::retrieve_chunks(&chunks, query, max_chars);
    let native_context = crate::knowledge::retrieve_chunks(&native_chunks, query, max_chars);
    Ok(DriveContextReport {
        context,
        native_context,
        workspace,
        visible_files: files.len(),
        supported_files,
        native_files,
        sources,
        editable_files,
    })
}

fn valid_sheet_start_cell(value: &str) -> bool {
    let value = value.trim();
    let letter_count = value
        .chars()
        .take_while(|ch| ch.is_ascii_alphabetic())
        .count();
    if !(1..=3).contains(&letter_count) {
        return false;
    }
    let row = &value[letter_count..];
    !row.is_empty()
        && row.len() <= 7
        && !row.starts_with('0')
        && row.chars().all(|ch| ch.is_ascii_digit())
}

fn validate_sheet_values(values: &[Vec<String>]) -> Result<(usize, usize), String> {
    let rows = values.len();
    let columns = values.first().map(Vec::len).unwrap_or(0);
    if rows == 0 || columns == 0 {
        return Err("A spreadsheet edit needs at least one row and one column.".into());
    }
    if rows > 200 || columns > 50 || rows.saturating_mul(columns) > 10_000 {
        return Err(
            "A single spreadsheet edit is limited to 200 rows, 50 columns, and 10,000 cells."
                .into(),
        );
    }
    if values.iter().any(|row| row.len() != columns) {
        return Err("Spreadsheet rows must all contain the same number of cells.".into());
    }
    let characters: usize = values.iter().flatten().map(String::len).sum();
    if characters > 100_000 {
        return Err("A single spreadsheet edit is limited to 100,000 characters.".into());
    }
    Ok((rows, columns))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetWriteResult {
    pub updated_range: String,
    pub updated_rows: usize,
    pub updated_columns: usize,
    pub updated_cells: usize,
}

pub async fn write_sheet_range(
    token: &str,
    file_id: &str,
    start_cell: &str,
    values: Vec<Vec<String>>,
) -> Result<SheetWriteResult, String> {
    let (rows, columns) = validate_sheet_values(&values)?;
    let start_cell = start_cell.trim().to_ascii_uppercase();
    if !valid_sheet_start_cell(&start_cell) {
        return Err(
            "Spreadsheet writes currently require a starting cell such as A1 or C4.".into(),
        );
    }
    let mut url = reqwest::Url::parse(SHEETS_ENDPOINT).map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "Could not construct the Google Sheets request URL.".to_string())?
        .push(file_id)
        .push("values")
        .push(&start_cell);
    let response = reqwest::Client::new()
        .put(url)
        .bearer_auth(token)
        .query(&[("valueInputOption", "RAW")])
        .json(&serde_json::json!({
            "range": start_cell,
            "majorDimension": "ROWS",
            "values": values,
        }))
        .send()
        .await
        .map_err(|e| format!("Google Sheets update failed before Google responded: {e}"))?;
    let status = response.status();
    let response_value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Google Sheets update returned unreadable JSON: {e}"))?;
    if !status.is_success() {
        let message = response_value["error"]["message"]
            .as_str()
            .unwrap_or("Google rejected the spreadsheet update.");
        return Err(format!(
            "Google Sheets update failed: {message} (HTTP {status})"
        ));
    }
    Ok(SheetWriteResult {
        updated_range: response_value["updatedRange"]
            .as_str()
            .unwrap_or(&start_cell)
            .to_string(),
        updated_rows: response_value["updatedRows"]
            .as_u64()
            .unwrap_or(rows as u64) as usize,
        updated_columns: response_value["updatedColumns"]
            .as_u64()
            .unwrap_or(columns as u64) as usize,
        updated_cells: response_value["updatedCells"]
            .as_u64()
            .unwrap_or((rows * columns) as u64) as usize,
    })
}

pub async fn read_sheet_range(
    token: &str,
    file_id: &str,
    range: &str,
) -> Result<Vec<Vec<String>>, String> {
    let mut url = reqwest::Url::parse(SHEETS_ENDPOINT).map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "Could not construct the Google Sheets read URL.".to_string())?
        .push(file_id)
        .push("values")
        .push(range);
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .query(&[("valueRenderOption", "UNFORMATTED_VALUE")])
        .send()
        .await
        .map_err(|e| format!("Google Sheets readback failed before Google responded: {e}"))?;
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Google Sheets readback returned unreadable JSON: {e}"))?;
    if !status.is_success() {
        let message = value["error"]["message"]
            .as_str()
            .unwrap_or("Google rejected the spreadsheet readback.");
        return Err(format!(
            "Google Sheets readback failed: {message} (HTTP {status})"
        ));
    }
    Ok(value["values"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    row.as_array()
                        .map(|cells| {
                            cells
                                .iter()
                                .map(|cell| match cell {
                                    serde_json::Value::String(value) => value.clone(),
                                    other => other.to_string(),
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default())
}

pub async fn create_native_spreadsheet(
    token: &str,
    parent_id: &str,
    name: &str,
) -> Result<String, String> {
    let response = reqwest::Client::new()
        .post(FILES_ENDPOINT)
        .bearer_auth(token)
        .query(&[("supportsAllDrives", "true"), ("fields", "id")])
        .json(&serde_json::json!({
            "name": name,
            "mimeType": "application/vnd.google-apps.spreadsheet",
            "parents": [parent_id],
        }))
        .send()
        .await
        .map_err(|e| format!("Drive write-probe creation failed before Google responded: {e}"))?;
    let value = drive_json_response(response, "write-probe creation").await?;
    value["id"]
        .as_str()
        .map(str::to_string)
        .ok_or("Google did not return the write-probe file id.".into())
}

pub async fn trash_file(token: &str, file_id: &str) -> Result<(), String> {
    let response = reqwest::Client::new()
        .patch(format!("{FILES_ENDPOINT}/{file_id}"))
        .bearer_auth(token)
        .query(&[("supportsAllDrives", "true"), ("fields", "id,trashed")])
        .json(&serde_json::json!({ "trashed": true }))
        .send()
        .await
        .map_err(|e| format!("Drive write-probe cleanup failed before Google responded: {e}"))?;
    drive_json_response(response, "write-probe cleanup").await?;
    Ok(())
}

/// Write a rectangular block to an existing native Google Sheet. The file id is accepted only
/// after it is re-proven to be a spreadsheet beneath the selected workspace.
#[tauri::command]
pub async fn google_drive_write_sheet_range(
    app: tauri::AppHandle,
    file_id: String,
    start_cell: String,
    values: Vec<Vec<String>>,
) -> Result<SheetWriteResult, String> {
    require_collaboration_access(&app)?;
    let token = access_token(&app).await?;
    let workspace = read_workspace(&app).ok_or("Choose a Drive workspace before editing files.")?;
    let files = list_folder_tree(&token, &workspace.id, 2_000).await?;
    let file = files
        .into_iter()
        .find(|file| file.id == file_id)
        .ok_or("That file is outside the selected Drive workspace.")?;
    if file.mime != "application/vnd.google-apps.spreadsheet" {
        return Err("That Drive file is not a native Google Sheet.".into());
    }
    write_sheet_range(&token, &file.id, &start_cell, values).await
}

/// Retrieve relevant passages directly from the selected Drive workspace. Google Docs, Sheets,
/// and Slides are exported in memory; a local mirror is not required.
#[tauri::command]
pub async fn google_drive_retrieve_context(
    app: tauri::AppHandle,
    folder_name: String,
    query: String,
    max_chars: usize,
) -> Result<DriveContextReport, String> {
    require_collaboration_access(&app)?;
    let token = access_token(&app).await?;
    let workspace = resolve_workspace(&app, &token, &folder_name).await?;
    retrieve_context_report(&token, workspace, &query, max_chars).await
}

/// List files inside `<folder_name>` (created on demand), newest first.
/// The read primitive of the shared-folder test.
#[tauri::command]
pub async fn google_drive_list_folder(
    app: tauri::AppHandle,
    folder_name: String,
) -> Result<Vec<DriveFile>, String> {
    require_collaboration_access(&app)?;
    let token = access_token(&app).await?;
    let workspace = resolve_workspace(&app, &token, &folder_name).await?;
    let q = format!("'{}' in parents and trashed = false", esc(&workspace.id));
    let v = drive_get_json(
        &token,
        FILES_ENDPOINT,
        &[
            ("q", q.as_str()),
            ("orderBy", "modifiedTime desc"),
            ("fields", "files(id,name,modifiedTime,size)"),
            ("pageSize", "50"),
            ("supportsAllDrives", "true"),
            ("includeItemsFromAllDrives", "true"),
        ],
        "workspace file listing",
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
pub async fn google_drive_read_file(
    app: tauri::AppHandle,
    file_id: String,
) -> Result<String, String> {
    require_collaboration_access(&app)?;
    let token = access_token(&app).await?;
    let workspace = read_workspace(&app).ok_or("Choose a Drive workspace before reading files.")?;
    let files = list_folder_tree(&token, &workspace.id, 2_000).await?;
    let file = files
        .into_iter()
        .find(|file| file.id == file_id)
        .ok_or("That file is outside the selected Drive workspace.")?;
    let bytes = drive_file_bytes(&reqwest::Client::new(), &token, &file.id, &file.mime)
        .await?
        .ok_or("That Drive file type cannot be read as text.")?;
    supported_text(&file.mime, &bytes).ok_or("That Drive file has no extractable text.".into())
}

// ---------------- folder mirror sync ----------------
// The bridge that makes Drive a first-class destination: a local folder (Documents/Syzygy)
// kept in sync with the Drive folder. Everything that already understands local folders —
// knowledge retrieval, document generation — gets Drive for free by pointing at the mirror.

fn rfc3339_to_epoch(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.timestamp())
}

fn file_mtime_epoch(p: &std::path::Path) -> Option<i64> {
    let meta = std::fs::metadata(p).ok()?;
    let m = meta.modified().ok()?;
    m.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

fn mime_for(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
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

fn safe_mirror_name(name: &str) -> Result<&str, String> {
    let invalid = name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with([' ', '.'])
        || name
            .chars()
            .any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch))
        || Path::new(name).file_name().and_then(|part| part.to_str()) != Some(name);
    if invalid {
        Err(format!(
            "Drive file {name:?} cannot be mirrored safely on Windows. Rename it in Drive or use direct Shared mode."
        ))
    } else {
        Ok(name)
    }
}

/// The local mirror of the shared Drive folder: `<Documents>/Syzygy`, created on demand and
/// granted so the document/knowledge commands may read and write inside it.
#[tauri::command]
pub fn google_drive_mirror_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir: PathBuf = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("Syzygy");
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

/// Rotation cap for transcript logs: past this, the next exchange starts `_NNN+1`.
const LOG_ROTATE_BYTES: u64 = 256 * 1024;

/// Append an exchange to the thread's rotating transcript in the LOCAL mirror —
/// `ask_<base>_001.md`, `_002`, … The mirror is the single write path; a Drive sync
/// (caller-triggered) carries it up. Local-only, so it works offline and never blocks.
#[tauri::command]
pub fn google_drive_mirror_append_log(
    app: tauri::AppHandle,
    base: String,
    content: String,
) -> Result<String, String> {
    let mirror = PathBuf::from(google_drive_mirror_dir(app)?);
    // Sanitize the base defensively (the frontend already does) — filesystem-hostile chars out.
    let base: String = base
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let base = if base.is_empty() {
        "ask_untitled".to_string()
    } else {
        base
    };
    let mut n: u32 = 1;
    let path = loop {
        let p = mirror.join(format!("{base}_{n:03}.md"));
        match std::fs::metadata(&p) {
            Err(_) => break p, // doesn't exist yet — use it
            Ok(m) if m.len() < LOG_ROTATE_BYTES => break p,
            Ok(_) => n += 1, // full — roll to the next
        }
        if n > 999 {
            return Err("Transcript log rotation exceeded 999 files.".into());
        }
    };
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default())
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
pub async fn google_drive_sync_folder(
    app: tauri::AppHandle,
    folder_name: String,
) -> Result<SyncReport, String> {
    const SLACK: i64 = 2;
    require_collaboration_access(&app)?;
    let token = access_token(&app).await?;
    let workspace = resolve_workspace(&app, &token, &folder_name).await?;
    let mirror = google_drive_mirror_dir(app.clone())?;
    let mirror_path = PathBuf::from(&mirror);
    let client = reqwest::Client::new();

    // Remote inventory (plain files only — native Google Docs types can't download as media).
    let q = format!("'{}' in parents and trashed = false", esc(&workspace.id));
    let v = drive_get_json(
        &token,
        FILES_ENDPOINT,
        &[
            ("q", q.as_str()),
            ("fields", "files(id,name,mimeType,modifiedTime)"),
            ("pageSize", "200"),
            ("supportsAllDrives", "true"),
            ("includeItemsFromAllDrives", "true"),
        ],
        "sync inventory",
    )
    .await?;
    let mut remote: std::collections::HashMap<String, (String, i64)> =
        std::collections::HashMap::new();
    let mut exported_names = std::collections::HashSet::new();
    let mut pulled = 0u32;
    let mut pushed = 0u32;
    for f in v["files"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let (Some(id), Some(name), Some(mt)) = (
            f["id"].as_str(),
            f["name"].as_str(),
            f["modifiedTime"].as_str(),
        ) else {
            continue;
        };
        let name = safe_mirror_name(name)?;
        let mime = f["mimeType"].as_str().unwrap_or("");
        if let Some(export_as) = export_mime(mime) {
            let suffix = if export_as == "text/csv" {
                ".csv"
            } else {
                ".txt"
            };
            let local_name = format!("{name}{suffix}");
            exported_names.insert(local_name.clone());
            let local = mirror_path.join(&local_name);
            let rtime = rfc3339_to_epoch(mt).unwrap_or(0);
            if file_mtime_epoch(&local).map_or(true, |lt| rtime > lt + SLACK) {
                let bytes = drive_file_bytes(&client, &token, id, mime)
                    .await?
                    .ok_or_else(|| format!("Drive file {name} cannot be exported."))?;
                std::fs::write(&local, bytes).map_err(|e| e.to_string())?;
                let _ =
                    filetime::set_file_mtime(&local, filetime::FileTime::from_unix_time(rtime, 0));
                pulled += 1;
            }
            continue;
        }
        if mime.starts_with("application/vnd.google-apps") {
            continue;
        }
        remote.insert(
            name.to_string(),
            (id.to_string(), rfc3339_to_epoch(mt).unwrap_or(0)),
        );
    }

    // Pull: remote file missing locally, or newer than the local copy.
    for (name, (id, rtime)) in &remote {
        let local = mirror_path.join(name);
        let ltime = file_mtime_epoch(&local);
        if ltime.map_or(true, |lt| *rtime > lt + SLACK) {
            let resp = client
                .get(format!("{FILES_ENDPOINT}/{id}"))
                .bearer_auth(&token)
                .query(&[("alt", "media"), ("supportsAllDrives", "true")])
                .send()
                .await
                .map_err(|e| format!("Drive sync pull failed before Google responded: {e}"))?;
            let resp = require_drive_success(resp, "sync pull").await?;
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
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        if exported_names.contains(&name) {
            continue;
        }
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
                    .query(&[
                        ("uploadType", "media"),
                        ("fields", "modifiedTime"),
                        ("supportsAllDrives", "true"),
                    ])
                    .header("Content-Type", mime)
                    .body(bytes)
                    .send()
                    .await
                    .map_err(|e| {
                        format!("Drive sync update failed before Google responded: {e}")
                    })?;
                let v = drive_json_response(resp, "sync update").await?;
                v["modifiedTime"].as_str().map(str::to_string)
            }
            None => {
                let meta = serde_json::json!({ "name": name, "parents": [workspace.id.clone()] })
                    .to_string();
                let form = reqwest::multipart::Form::new()
                    .part(
                        "metadata",
                        reqwest::multipart::Part::text(meta)
                            .mime_str("application/json")
                            .map_err(|e| e.to_string())?,
                    )
                    .part(
                        "media",
                        reqwest::multipart::Part::bytes(bytes)
                            .mime_str(mime)
                            .map_err(|e| e.to_string())?,
                    );
                let v = client
                    .post(UPLOAD_ENDPOINT)
                    .bearer_auth(&token)
                    .query(&[
                        ("uploadType", "multipart"),
                        ("fields", "id,modifiedTime"),
                        ("supportsAllDrives", "true"),
                    ])
                    .multipart(form)
                    .send()
                    .await
                    .map_err(|e| {
                        format!("Drive sync creation failed before Google responded: {e}")
                    })?;
                let v = drive_json_response(v, "sync creation").await?;
                v["modifiedTime"].as_str().map(str::to_string)
            }
        };
        // Pin the local mtime to Drive's authoritative time so the next sync is a no-op.
        if let Some(rt) = new_rtime.and_then(|s| rfc3339_to_epoch(&s)) {
            let _ = filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(rt, 0));
        }
        pushed += 1;
    }

    Ok(SyncReport {
        pulled,
        pushed,
        mirror,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_drive_queries_always_set_required_flags_once() {
        let list = shared_drive_query(&[("q", "trashed = false")], true);
        assert!(list.contains(&("supportsAllDrives", "true")));
        assert!(list.contains(&("includeItemsFromAllDrives", "true")));

        let already_flagged = shared_drive_query(
            &[
                ("supportsAllDrives", "true"),
                ("includeItemsFromAllDrives", "true"),
            ],
            true,
        );
        assert_eq!(
            already_flagged
                .iter()
                .filter(|(key, _)| *key == "supportsAllDrives")
                .count(),
            1
        );
        assert_eq!(
            already_flagged
                .iter()
                .filter(|(key, _)| *key == "includeItemsFromAllDrives")
                .count(),
            1
        );
    }

    #[test]
    fn native_google_types_have_explicit_text_exports() {
        assert_eq!(
            export_mime("application/vnd.google-apps.document"),
            Some("text/plain")
        );
        assert_eq!(
            export_mime("application/vnd.google-apps.spreadsheet"),
            Some("text/csv")
        );
        assert_eq!(
            export_mime("application/vnd.google-apps.presentation"),
            Some("text/plain")
        );
        assert_eq!(export_mime("application/vnd.google-apps.form"), None);
    }

    #[test]
    fn sheet_write_bounds_fail_closed_before_network_access() {
        assert!(valid_sheet_start_cell("A1"));
        assert!(valid_sheet_start_cell("zzz9999999"));
        assert!(!valid_sheet_start_cell("Sheet1!A1"));
        assert!(!valid_sheet_start_cell("A0"));
        assert!(!valid_sheet_start_cell("A1:J20"));

        assert_eq!(
            validate_sheet_values(&[vec!["1".into(), "2".into()]]),
            Ok((1, 2))
        );
        assert!(validate_sheet_values(&[]).is_err());
        assert!(validate_sheet_values(&[vec!["1".into()], vec!["2".into(), "3".into()]]).is_err());
        assert!(validate_sheet_values(&vec![vec!["x".into(); 51]]).is_err());
    }

    #[test]
    fn google_doc_export_becomes_retrievable_context() {
        let text = supported_text(
            "application/vnd.google-apps.document",
            "\u{feff}The secret word is hippo".as_bytes(),
        )
        .expect("Google Doc export should decode");
        let chunks = crate::knowledge::chunk_text(&text)
            .into_iter()
            .map(|chunk| ("research/test file for syzygy".to_string(), chunk))
            .collect::<Vec<_>>();
        let context = crate::knowledge::retrieve_chunks(&chunks, "What is the secret word?", 2_000);
        assert!(context.contains("The secret word is hippo"));
        assert!(context.contains("[research/test file for syzygy]"));
    }

    #[test]
    fn unsupported_binary_is_not_sent_to_the_model() {
        assert!(supported_text("image/png", b"not really a png").is_none());
    }

    #[test]
    fn mirror_rejects_traversal_and_windows_hostile_names() {
        assert!(safe_mirror_name("../outside.txt").is_err());
        assert!(safe_mirror_name("folder\\outside.txt").is_err());
        assert!(safe_mirror_name("policy:final.md").is_err());
        assert_eq!(
            safe_mirror_name("policy-final.md").unwrap(),
            "policy-final.md"
        );
    }
}

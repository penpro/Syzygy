// The single typed boundary to the Rust backend. UI code imports these functions instead of
// calling `invoke('cmd', {...})` directly, so every command name, argument shape, and return type
// lives in ONE place instead of being duplicated across ~40 call sites. Add a wrapper here for
// every new `#[tauri::command]`; components should never import `invoke` themselves.
import { invoke as rawInvoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { download as downloadBlob } from './util'
import { logError } from './log'

/** Every backend call goes through here, so every backend FAILURE lands in the diagnostic log
 * automatically (command name + error text only — never arguments or file contents). */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await rawInvoke<T>(cmd, args)
  } catch (e) {
    logError('backend', `${cmd}: ${(e as { message?: string })?.message ?? String(e)}`)
    throw e
  }
}

// ---------- shared shapes ----------

/** A model file on disk: `[filename, sizeBytes, isTheLoadedMainModel]`. */
export type ModelFile = [name: string, sizeBytes: number, isMain: boolean]

/** One download's live progress, as reported by the backend. */
export interface DownloadInfo {
  filename: string
  received: number
  total: number
  status: string
}

export interface McpConnectionInfo {
  appVersion: string
  protocolVersion: string
  serverName: string
  transport: 'stdio'
  executablePath: string
  installFolder: string
  arguments: string[]
  genericJson: string
  codexToml: string
  connectionPrompt: string
  starterPrompt: string
}

// ---------- engine & models ----------

/** GPU VRAM usage in MiB (via `nvidia-smi`). null off-Tauri / on non-NVIDIA. */
export async function gpuVram(): Promise<{ used: number; total: number } | null> {
  try {
    const r = (await invoke('gpu_vram')) as [number, number] | null
    return r ? { used: r[0], total: r[1] } : null
  } catch {
    return null
  }
}

/** Total VRAM (MiB) for model-fit recommendation (DXGI / Metal / nvidia-smi). null if unknown. */
export const vramTotalMb = (): Promise<number | null> => invoke('vram_total_mb')

/** Downloaded text-model filenames (vision projectors excluded). */
export const listModels = (): Promise<string[]> => invoke('list_models')

/** Absolute path of the model directory, or null. */
export const modelDirPath = (): Promise<string | null> => invoke('model_dir_path')

/** Start (or restart) the engine on a downloaded model file. Rejects with a user-facing message. */
export const startEngine = (filename: string): Promise<void> => invoke('start_engine', { filename })

/** Stop the running engine(s) — e.g. before an in-app update overwrites the binaries. */
export const shutdownEngine = (): Promise<void> => invoke('shutdown_engine')

/** All model files as `[name, sizeBytes, isMain]`. */
export const modelFiles = (): Promise<ModelFile[]> => invoke('model_files')

/** Delete a model file (refuses the active main model — switch first). */
export const deleteModel = (filename: string): Promise<void> => invoke('delete_model', { filename })

// ---------- downloads ----------

/** Start (or resume) a background model download. */
export const startDownload = (url: string, filename: string): Promise<void> =>
  invoke('start_download', { url, filename })

/** Pause a running download (keeps the partial file). */
export const pauseDownload = (filename: string): Promise<void> => invoke('pause_download', { filename })

/** Snapshot of all downloads' progress. */
export const downloadStatus = (): Promise<DownloadInfo[]> => invoke('download_status')

// ---------- knowledge folders ----------

/** Ingest (cached) a knowledge folder → `[fileCount, chunkCount, fileNames]`. */
export const folderInfo = (path: string): Promise<[number, number, string[]]> => invoke('folder_info', { path })

/** Retrieve the chunks most relevant to `query` from a knowledge folder, up to `maxChars`. */
export const retrieveContext = (path: string, query: string, maxChars: number): Promise<string> =>
  invoke('retrieve_context', { path, query, maxChars })

/** Extract text from dropped PDF bytes (scanned / image-only PDFs reject). */
export const extractPdf = (data: number[]): Promise<string> => invoke('extract_pdf', { data })

// ---------- documents & files (writes go only to user-granted folders) ----------

/** Record a user-picked folder/file's directory as granted, scoping the file commands to it. */
export const grantPath = (path: string): Promise<void> => invoke('grant_path', { path })

/** Compile Typst `source` → PDF (temp preview when `outPath` is null). Returns the PDF path. */
export const compileTypst = (source: string, outPath: string | null): Promise<string> =>
  invoke('compile_typst', { source, outPath })

/** Open a file with the OS default application. */
export const openPath = (path: string): Promise<void> => invoke('open_path', { path })

/** Write `<title>.typ` + compile `<title>.pdf` into a granted folder. Returns the PDF path. */
export const saveDocument = (folder: string, title: string, source: string): Promise<string> =>
  invoke('save_document', { folder, title, source })

/** Save a plain-text / code document as `<title>.<ext>` in a granted folder. Returns the path. */
export const saveTextDocument = (folder: string, title: string, ext: string, content: string): Promise<string> =>
  invoke('save_text_document', { folder, title, ext, content })

/** Saved-document / editable filenames in a folder, newest first. */
export const listDocuments = (folder: string): Promise<string[]> => invoke('list_documents', { folder })

/** Read a saved document's source back from a folder. */
export const readDocument = (folder: string, name: string): Promise<string> =>
  invoke('read_document', { folder, name })

/** Read a text file by absolute path (must be inside a granted folder). */
export const readTextFile = (path: string): Promise<string> => invoke('read_text_file', { path })

/** Overwrite a text/code file at a granted absolute path. */
export const writeToPath = (path: string, content: string): Promise<void> =>
  invoke('write_to_path', { path, content })

/** Write Typst to `typPath` + compile a PDF beside it (granted path). Returns the PDF path. */
export const saveTypstAt = (typPath: string, source: string): Promise<string> =>
  invoke('save_typst_at', { typPath, source })

/** Write content to a temp file (to preview a generated file in its default app). Returns the path. */
export const writeTempFile = (name: string, content: string): Promise<string> =>
  invoke('write_temp_file', { name, content })

// ---------- vision ----------

/** Whether both files of a vision model are present on disk. */
export const visionPresent = (textFile: string, mmprojFile: string): Promise<boolean> =>
  invoke('vision_present', { textFile, mmprojFile })

/** Swap the engine between text and image mode on the main port. */
export const setVisionMode = (on: boolean, textFile: string, mmprojFile: string): Promise<void> =>
  invoke('set_vision_mode', { on, textFile, mmprojFile })

/** Image filenames in a folder (non-recursive), sorted. */
export const listImages = (folder: string): Promise<string[]> => invoke('list_images', { folder })

/** Read a folder image as a base64 data URL (to send to the vision model). */
export const readImageData = (folder: string, name: string): Promise<string> =>
  invoke('read_image_data', { folder, name })

// ---------- Google Drive auth (the tokens live in the Rust core, never here) ----------

/** Run the browser consent flow; resolves to the connected account's email. */
export const googleOauthStart = (clientId: string, clientSecret: string): Promise<string> =>
  invoke('google_oauth_start', { clientId, clientSecret })

/** The connected account's email, or null when not connected. */
export const googleOauthStatus = (): Promise<string | null> => invoke('google_oauth_status')

export interface GoogleConnection {
  email: string
  collaborationAccess: boolean
}

export const googleOauthConnection = (): Promise<GoogleConnection | null> => invoke('google_oauth_connection')

/** Abort a sign-in that's still waiting on the browser (no-op when none is pending). */
export const googleOauthCancel = (): Promise<void> => invoke('google_oauth_cancel')

/** Revoke (best-effort) and forget the stored Google credentials. */
export const googleOauthDisconnect = (): Promise<void> => invoke('google_oauth_disconnect')

/** Create (or find) a Drive folder by name; resolves to "created:<id>" | "exists:<id>". */
export const googleDriveCreateFolder = (name: string): Promise<string> =>
  invoke('google_drive_create_folder', { name })

/** A file listed from a Drive folder. */
export interface DriveFileInfo {
  id: string
  name: string
  modified: string
  size?: string
}

/** Append text to a file in a Drive folder (folder + file created on demand); resolves to the file id. */
export const googleDriveAppendText = (folderName: string, fileName: string, content: string): Promise<string> =>
  invoke('google_drive_append_text', { folderName, fileName, content })

/** List files in a Drive folder (created on demand), newest first. */
export const googleDriveListFolder = (folderName: string): Promise<DriveFileInfo[]> =>
  invoke('google_drive_list_folder', { folderName })

/** Read a Drive text file's content by id. */
export const googleDriveReadFile = (fileId: string): Promise<string> =>
  invoke('google_drive_read_file', { fileId })

export interface DriveWorkspace {
  id: string
  name: string
}

export interface DriveWorkspaceOption extends DriveWorkspace {
  modified: string
}

export interface DriveContextReport {
  context: string
  workspace: DriveWorkspace
  visibleFiles: number
  supportedFiles: number
  nativeFiles: number
  sources: string[]
  editableFiles: DriveEditableFile[]
}

export interface DriveEditableFile {
  id: string
  path: string
  kind: 'spreadsheet'
}

export interface SheetWriteResult {
  updatedRange: string
  updatedRows: number
  updatedColumns: number
  updatedCells: number
}

export const googleDriveRetrieveContext = (
  folderName: string,
  query: string,
  maxChars: number,
): Promise<DriveContextReport> =>
  invoke('google_drive_retrieve_context', { folderName, query, maxChars })

/** Write a confirmed rectangular block into an existing native Sheet in the selected workspace. */
export const googleDriveWriteSheetRange = (
  fileId: string,
  startCell: string,
  values: string[][],
): Promise<SheetWriteResult> =>
  invoke('google_drive_write_sheet_range', { fileId, startCell, values })

export const googleDriveWorkspace = (): Promise<DriveWorkspace | null> => invoke('google_drive_workspace')

export const googleDriveListWorkspaces = (): Promise<DriveWorkspaceOption[]> => invoke('google_drive_list_workspaces')

export const googleDriveSelectWorkspace = (folderId: string): Promise<DriveWorkspace> =>
  invoke('google_drive_select_workspace', { folderId })

/** The local mirror of the shared Drive folder (Documents/Syzygy), created + granted on demand. */
export const googleDriveMirrorDir = (): Promise<string> => invoke('google_drive_mirror_dir')

/** Result of a mirror sync pass. */
export interface DriveSyncReport {
  pulled: number
  pushed: number
  mirror: string
}

/** Two-way sync between the Drive folder and the local mirror (last-write-wins by mtime). */
export const googleDriveSyncFolder = (folderName: string): Promise<DriveSyncReport> =>
  invoke('google_drive_sync_folder', { folderName })

/** Append an exchange to a rotating transcript in the mirror (`<base>_001.md`, 256KB cap);
 * resolves to the file name written. Local-only — pair with a sync to push it to Drive. */
export const googleDriveMirrorAppendLog = (base: string, content: string): Promise<string> =>
  invoke('google_drive_mirror_append_log', { base, content })

// ---------- app ----------

/** The running app version (from Cargo). */
export const appVersion = (): Promise<string> => invoke('app_version')

// ---------- live semantic automation (MCP bridge) ----------

/** Mark the webview ready after its authenticated automation event listener is attached. */
export const automationReady = (): Promise<void> => invoke('automation_ready')

/** Exact, copy-ready connection details generated from the currently running executable. */
export const mcpConnectionInfo = (): Promise<McpConnectionInfo> => invoke('mcp_connection_info')

/** Complete one semantic automation request. Content is returned only to its authenticated caller. */
export const automationRespond = (
  id: string,
  reply: { ok: boolean; result?: unknown; error?: string },
): Promise<void> =>
  invoke('automation_respond', {
    id,
    ok: reply.ok,
    result: reply.result ?? null,
    error: reply.error ?? null,
  })

// ---------- high-level helpers ----------

/**
 * Save text to a user-chosen location via the native Save dialog, then grant + write it. Falls back
 * to a browser blob download in the dev build (no Tauri). Returns true if saved, false if cancelled.
 *
 * Why not just an <a download>: inside the packaged WebView2 a programmatic blob download silently
 * does nothing, which is why the in-app Export buttons appeared broken. The OS save dialog works.
 */
export async function saveTextFile(defaultName: string, content: string, mime = 'text/plain'): Promise<boolean> {
  try {
    const path = await save({ defaultPath: defaultName })
    if (!path) return false // user cancelled
    await grantPath(path) // grant the chosen file's folder so the write passes the path allowlist
    await writeToPath(path, content)
    return true
  } catch {
    downloadBlob(defaultName, content, mime) // dev browser / dialog unavailable
    return true
  }
}

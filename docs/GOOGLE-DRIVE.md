# Google Drive Integration

> Auth + file primitives + the folder mirror. Everything Google lives in two Rust
> modules; the webview never sees a credential.

## Why Drive at all

Syzygy's collaboration model is a **shared folder**: documents and (eventually) CRDT
state live in a folder both collaborators can reach. Drive is the first transport —
free, ubiquitous, no server for us to run. Self-hosted and P2P transports can slot in
later behind the same folder abstraction.

## Auth (`google_auth.rs`)

**Flow:** OAuth 2.0 for installed apps — loopback redirect + PKCE (RFC 8252 §7.3).
1. Bind a one-shot listener on `127.0.0.1:<random>`; single-flight guard (`PENDING_PORT`).
2. Open the consent URL in the system browser — via `rundll32 url.dll,FileProtocolHandler`
   (**never `cmd /C start`** — cmd splits URLs at `&`, truncating the query string).
3. Catch the redirect, verify `state`, exchange the code (+ PKCE verifier +
   **client_secret** — see quirks) at Google's token endpoint over TLS in Rust.
4. Persist `{client_id, client_secret, refresh_token, email, scope}` →
   `<app-data>/google_auth.json`. Access tokens are minted on demand from the refresh
   token (no caching yet).

**Cancel:** `google_oauth_cancel` pokes the listener with a `/cancel` request so the
blocking wait aborts instantly; the UI's "Waiting for browser…" button is the cancel
control. Hard timeout 300s. Every exit path clears the pending flag.

**Scopes:** `openid email` (display) + the restricted **`drive`** collaboration scope.
Google does not provide a folder-only OAuth scope that lets this loopback desktop flow enumerate
present and future collaborator-created children. Syzygy therefore stores one explicitly selected
workspace in `<app-data>/drive_workspace.json` and constrains product operations to its descendants
in Rust. This is an application boundary, not a narrower Google token; the re-link UI says so.
The evidence and alternatives are in `audits/DECISIONS/ADR-0001-DRIVE-WORKSPACE-AUTH.md`.

**Fail-fast:** the token response's `scope` field is checked for the exact collaboration scope.
Older auth files have no stored scope and remain visibly app-file-only until the user re-links.
Shared Ask and Sync reject those legacy grants before the model runs; an empty filtered listing is
never treated as evidence.

### Google quirks (hard-won; all bit us)

| Quirk | Consequence → handling |
|---|---|
| Desktop-type clients **require `client_secret` at the token endpoint even with PKCE** (Google's RFC-8252 deviation) | Exchange fails `client_secret is missing` without it. Google documents it as non-confidential for installed apps. Injected at build time — see DEVELOPMENT.md secrets. |
| Consent screen omits or denies the requested scope | Link fails immediately; the UI explains why collaborator-created files require re-linking. |
| Consent screen in **Testing** mode | Only listed test users may auth (`403 access_denied`), and refresh tokens expire in **7 days**. Public use of the restricted scope requires Google's verification process; do not describe it as instant. |
| **Drive API disabled** on the Cloud project | Every Drive call 403s (`Drive API has not been used in project…`). Enable at console.cloud.google.com → APIs & Services → Library. |
| **Google Sheets API disabled** on the Cloud project | Native Sheet reads still work through Drive export, but confirmed cell writes 403 (`Google Sheets API has not been used in project…`). Enable **Google Sheets API** in the same Cloud project; the existing `drive` grant is accepted by `spreadsheets.values.update`. |
| Selected folder is inside a shared drive | Every compatible `files.list/get/create/update` and upload request must send `supportsAllDrives=true`; listings also send `includeItemsFromAllDrives=true`. Missing the first flag returns Google's literal `supportsAllDrives parameter was not set to true` error. |
| `cmd /C start <url>` truncates at `&` | Google errors `Required parameter is missing: response_type`. Use rundll32 (above). |

## Selected workspace and direct research (`google_drive.rs`)

- `google_drive_list_workspaces()` lists folders only after collaboration access is present.
- `google_drive_select_workspace(id)` validates the item is a live folder and persists its ID/name.
- Legacy calls that still pass `folder_name` resolve through the selected ID; name lookup/create is
  only a first-use fallback.
- `google_drive_retrieve_context(...)` recursively enumerates up to 2,000 files / 12 folder levels,
  paginates Drive listings (including shared-drive items), exports Docs/Sheets/Slides in memory,
  extracts supported text/PDFs, retrieves relevant labeled chunks, and returns a structured evidence
  report.
- `google_drive_read_file(id)` first proves the ID is a descendant of the selected workspace.
- `google_drive_append_text(...)` creates/updates transcripts only inside the selected workspace.
- `google_drive_write_sheet_range(...)` accepts only a validated rectangular literal-value block,
  re-enumerates the selected tree, proves the file ID is a native Sheet descendant, then calls
  `spreadsheets.values.update` with `RAW` values. Ask shows the complete proposal and requires a
  separate confirmation before this command runs. The model sees numbered paths, never file IDs.
- Shared Ask logs counts for visible/readable/native files without logging names or content. A Drive
  error aborts the turn instead of silently falling back to the mirror.
- Connection diagnostics distinguish OAuth success from later workspace discovery/selection failure;
  sanitized milestones and backend errors persist across restarts in the diagnostic log.

The local model sees only the resulting text labels/passages. It never receives an OAuth token or
an ambient Drive tool.


## Shared research projects (`drive_projects.rs`)

The selected workspace now contains an app-owned `.syzygy-projects` folder. Each published project
has an immutable schema-v1 `manifest.json` and an `updates/` folder of content-addressed,
append-only update envelopes. A writer never replaces another writer's project state. The frontend
coalesces local Yjs updates, appends them, polls unseen Drive file IDs, validates base64/identity/
SHA-256/size bounds in Rust, and gives the decoded updates to Yjs as the merge authority. IndexedDB
remains the local offline cache.

**Browse shared projects** is always available from the project sidebar and opens discovery without archiving the current project. **Share to Drive** publishes the current full Yjs state before changing the persisted transport
binding. **Join** constructs the same project/document identity from the remote manifest and pulls
before registering the document for UI/MCP automation. The product reports connecting, synced,
error, and disconnected states; it does not claim presence or sub-second real-time delivery.

`npm run test:drive-project-live` creates a temporary project through the real Google endpoints,
appends two logical-writer records, lists/reads them back, and trashes the project folder. The
2026-07-16 run passed listing, round-trip, and cleanup. The deterministic frontend provider fixture
separately proves Yjs state-vector equality after offline edits and reconnect.

## The folder mirror (what makes Drive a first-class destination)

> **Current behavior:** Shared-folder Ask reads directly, logs transcripts through Drive, and can
> apply confirmed literal-value edits to existing native Google Sheets through the Sheets API.
> Plain text, Markdown, JSON, and PDFs are read directly; Google Docs, Sheets, and Slides
> are exported in memory as text or CSV. The mirror below is now an explicit sync option
> for offline/local workflows rather than a prerequisite for collaboration. Manual sync
> also exports native Google files as read-only `.txt`/`.csv` snapshots and never pushes
> those snapshots back as duplicate Drive files.

**Design decision:** direct research reads stay remote-first. The optional local folder
**`<Documents>/Syzygy`** is a user-triggered export/sync surface, not the source of truth and not a
collaboration prerequisite.

`google_drive_sync_folder(name)` (two-way, last-write-wins):
- Remote inventory via `files.list`; native Google files export as read-only `.txt`/`.csv`
  snapshots that are never pushed back as duplicates.
- **Pull** remote-newer/missing → write bytes → pin local mtime to Drive's
  `modifiedTime` (via `filetime`).
- **Push** local-newer/missing → media PATCH or multipart create → pin local mtime to
  the returned `modifiedTime`.
- ±2s slack for clock skew. Mtime pinning makes a completed sync a **fixpoint** — no
  echo ping-pong. Subfolders are not synced (v1 is flat).
- Remote filenames that contain traversal, separators, control characters, or Windows-hostile
  characters fail safely with a rename/direct-mode instruction.

**UI surface (Ask top bar):**
- **📁 Folder** — chooses the persisted Drive workspace; direct research uses it immediately.
- **☁ Shared folder** — the per-thread mode toggle. Each exchange retrieves directly from Drive
  before the model call and appends the completed prompt/response to the selected workspace.
- **Confirmed Sheet edits** — requests such as “write this grid to the spreadsheet” become typed
  proposals. The confirmation names the target, starting cell, dimensions, and every value; only
  **Write values** performs the remote mutation. Success copy comes from Google's response.
- **Transcripts**: `ask_<TabName>_001.md` in Drive (name sanitized from the Ask title).
- **☁ Sync** — manual two-way sync, flashes `✓ ⬇pulled ⬆pushed`.
- Closing the Document modal auto-syncs when the thread folder is the mirror.

## Headless validation

`npm run test:drive-live` uses the normal stored grant and selected workspace. It requires at least
one visible native Google file, extracts the canary value specifically from native Google-file
evidence rather than transcripts or a hard-coded value, sends the normal retrieved context to the
loaded loopback model, and exits nonzero unless the answer contains the canary. Rust tests cover
native export decoding and mirror traversal names;
Vitest covers the final evidence-to-system-prompt boundary.

`npm run test:drive-write-live` creates a temporary native Sheet in the selected workspace, writes
a deterministic 20×10 literal grid through the same Sheets primitive, reads `A1:J20` back through
the Sheets API, compares all 200 values, and trashes the probe. It exits nonzero on write, readback,
comparison, or cleanup failure. Parser tests independently prove malformed, ragged, formula-bearing,
oversized, and out-of-workspace proposals cannot reach the command.
The passing 2026-07-14 production-grant run is recorded in
`audits/runs/DRIVE-WRITE-LIVE-2026-07-14.json`; it confirms all 200 values matched and cleanup
succeeded without committing cell content, file names, file IDs, OAuth data, or the Cloud project
identifier. The same Cloud project now has Drive, Sheets, Docs, and Slides APIs enabled; only the
typed Sheet action is exposed by v0.1.7.

## Known limitations / next steps

- Sync is manual + event-triggered; no watcher/interval yet.
- The optional human-readable mirror remains last-write-wins; shared research projects do not use
  it and instead merge append-only Yjs updates.
- Drive project delivery is polling-based (currently three seconds), not presence or sub-second
  real-time collaboration.
- One selected workspace at a time. Each project binding records that workspace ID and fails closed
  if code attempts to rebind it silently. Shared manifest rename and compaction are not yet exposed.
- Native Google Docs and Slides remain read-only research sources in Ask. Native Sheet support is
  currently literal rectangular value replacement from one starting cell; formatting, formulas,
  named-tab selection, structural edits, and conflict-aware revision controls are not yet exposed.
- The restricted Google scope requires consent-screen configuration and public verification.
- Existing v0.1.4 grants must be re-linked once. The reauthorized primary Windows test account
  passed the native-file Drive→local-model harness on 2026-07-14; S-01 remains
  `implemented_unverified` pending the planned second-account/second-install reproduction.
- Refresh-token revocation (user revokes in Google account) surfaces as errors on next
  call → the UI should offer re-link (currently: unlink + link manually).

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
- Shared Ask logs counts for visible/readable/native files without logging names or content. A Drive
  error aborts the turn instead of silently falling back to the mirror.

The local model sees only the resulting text labels/passages. It never receives an OAuth token or
an ambient Drive tool.

## The folder mirror (what makes Drive a first-class destination)

> **Current behavior:** Shared-folder Ask reads and writes directly through the Drive API.
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
- **Transcripts**: `ask_<TabName>_001.md` in Drive (name sanitized from the Ask title).
- **☁ Sync** — manual two-way sync, flashes `✓ ⬇pulled ⬆pushed`.
- Closing the Document modal auto-syncs when the thread folder is the mirror.

## Headless validation

`npm run test:drive-live` uses the normal stored grant and selected workspace. It requires at least
one visible native Google file, extracts the canary value from retrieved context rather than
hard-coding it, sends that exact context to the loaded loopback model, and exits nonzero unless the
answer contains the canary. Rust tests cover native export decoding and mirror traversal names;
Vitest covers the final evidence-to-system-prompt boundary.

## Known limitations / next steps

- Sync is manual + event-triggered; no watcher/interval yet.
- Last-write-wins whole files — fine for docs, not for concurrent editing. Real-time
  collab needs CRDT state (Yjs) in the folder with merge instead of LWW.
- Conflicting simultaneous writes to the same file lose the older write silently.
- One selected workspace at a time; per-project provider bindings are Phase 4 work.
- The restricted Google scope requires consent-screen configuration and public verification.
- Existing v0.1.4 grants must be re-linked once; until then the live harness intentionally fails
  `app-file-only` and S-01 stays `blocked_external`.
- Refresh-token revocation (user revokes in Google account) surfaces as errors on next
  call → the UI should offer re-link (currently: unlink + link manually).

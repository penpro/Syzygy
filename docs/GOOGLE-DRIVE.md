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
4. Persist `{client_id, client_secret, refresh_token, email}` →
   `<app-data>/google_auth.json`. Access tokens are minted on demand from the refresh
   token (no caching yet).

**Cancel:** `google_oauth_cancel` pokes the listener with a `/cancel` request so the
blocking wait aborts instantly; the UI's "Waiting for browser…" button is the cancel
control. Hard timeout 300s. Every exit path clears the pending flag.

**Scopes:** `openid email` (display) + **`drive.file`** — only files/folders this app
created or the user explicitly picked. Deliberately minimal; don't widen without a
real need.

**Fail-fast:** the token response's `scope` field is checked for `drive.file` at link
time; a missing scope (unticked consent checkbox) fails the link immediately and the UI
shows the helper modal.

### Google quirks (hard-won; all bit us)

| Quirk | Consequence → handling |
|---|---|
| Desktop-type clients **require `client_secret` at the token endpoint even with PKCE** (Google's RFC-8252 deviation) | Exchange fails `client_secret is missing` without it. Google documents it as non-confidential for installed apps. Injected at build time — see DEVELOPMENT.md secrets. |
| Consent screen shows **granular checkboxes**; Drive can be left unticked while sign-in "succeeds" | Token can't touch Drive → `insufficient authentication scopes`. Fail-fast at link + `SCOPE_PROBLEM` regex triggers the "tick the box" modal with one-click re-link. |
| Consent screen in **Testing** mode | Only listed test users may auth (`403 access_denied`), and refresh tokens expire in **7 days**. Publish the OAuth consent screen (non-sensitive scopes publish instantly). |
| **Drive API disabled** on the Cloud project | Every Drive call 403s (`Drive API has not been used in project…`). Enable at console.cloud.google.com → APIs & Services → Library. |
| `cmd /C start <url>` truncates at `&` | Google errors `Required parameter is missing: response_type`. Use rundll32 (above). |

## File primitives (`google_drive.rs`)

- `find_or_create_folder(name)` — by-name lookup, non-trashed, else create.
- `google_drive_append_text(folder, file, text)` — read-modify-write append.
- `google_drive_list_folder(folder)` — newest-first listing.
- `google_drive_read_file(id)` — `alt=media` download.
- Multipart create / media PATCH for uploads; MIME guessed from extension.

## The folder mirror (what makes Drive a first-class destination)

**Design decision:** instead of teaching every subsystem the Drive API, keep one local
folder — **`<Documents>/Syzygy`** — synced with the Drive folder **"Syzygy"**. All
existing local-folder machinery (knowledge retrieval, document generation, file
granting) then works with Drive for free. This is also the substrate the collab layer
will build on.

`google_drive_sync_folder(name)` (two-way, last-write-wins):
- Remote inventory via `files.list` (skips native Google-Docs types — no `alt=media`).
- **Pull** remote-newer/missing → write bytes → pin local mtime to Drive's
  `modifiedTime` (via `filetime`).
- **Push** local-newer/missing → media PATCH or multipart create → pin local mtime to
  the returned `modifiedTime`.
- ±2s slack for clock skew. Mtime pinning makes a completed sync a **fixpoint** — no
  echo ping-pong. Subfolders are not synced (v1 is flat).

**UI surface (Ask top bar):**
- **📂 Use Drive folder** — syncs, then sets the thread's knowledge/document folder to
  the mirror (also grants the path).
- **☁ Sync** — manual sync, flashes `✓ ⬇pulled ⬆pushed`.
- **✍ Mirror** — per-thread toggle appending each sent prompt to `ask-<title>.md` in the
  folder (fire-and-forget; the collab smoke test).
- Closing the Document modal auto-syncs when the thread folder is the mirror.

## Known limitations / next steps

- Sync is manual + event-triggered; no watcher/interval yet.
- Last-write-wins whole files — fine for docs, not for concurrent editing. Real-time
  collab needs CRDT state (Yjs) in the folder with merge instead of LWW.
- Conflicting simultaneous writes to the same file lose the older write silently.
- One fixed folder name ("Syzygy"); per-project folders are future work.
- Refresh-token revocation (user revokes in Google account) surfaces as errors on next
  call → the UI should offer re-link (currently: unlink + link manually).

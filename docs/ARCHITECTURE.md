# Syzygy Architecture

> The one-page mental model. If you read nothing else, read this.

## What Syzygy is

A **local-first AI document workspace**: a Tauri v2 desktop app pairing a fully-local LLM
(bundled llama.cpp engine on the user's GPU) with real file/folder access and optional
Google Drive collaboration. Forked from **Aphelion** (`penpro/Aphelion`), Penumbra's
local-AI studio; the roleplay surface was removed and the document/collaboration surface
is being built in its place. The long-term goal is a free, local-first collaborative
research workspace that democratizes policy design and evaluation, implemented independently
under Penumbra ownership and the repository's MIT license.

## The three sibling folders (on the dev machine)

| Folder | Role |
|---|---|
| `D:\PolicyPad\policypad` | Historical comparison only. **Never copy code, prompts, schemas, assets, fixtures, or UI.** |
| `D:\PolicyPad\syzygy-web` | Abandoned experiment; not an implementation source and never shipped. |
| `D:\PolicyPad\syzygy` | **This repo.** The shipping desktop app. |

## Current runtime model (no mandatory backend)

The current app has no backend server. It is a static **Vite React SPA** rendered in a Tauri
webview, plus a **Rust core**. Anything "backend" is one of two calls:

1. **AI** → direct `fetch` from the webview to the bundled llama.cpp server on
   `http://127.0.0.1:11435/v1` (OpenAI-compatible; hidden process; loopback only).
2. **OS / files / network** → `invoke('command')` into the Rust core.

Future collaboration providers may include an optional self-hosted real-time relay. Local use
and Drive-asynchronous collaboration must not depend on a Penumbra-hosted service.

The installed executable also has an MCP stdio mode (`Syzygy --mcp`). That process connects to a
random-token authenticated ephemeral loopback bridge owned by the GUI, which emits semantic
requests into the live webview. It never edits browser storage or a local mirror as a second
source of project truth.

```
 you ──▶ webview (React) ──▶ 127.0.0.1:11435 llama.cpp ──▶ GGUF on GPU
              │
              └─ invoke() ──▶ Rust core ── files, engine mgmt, Google APIs
```

## Rust core modules (`frontend/src-tauri/src/`)

| Module | Owns |
|---|---|
| `lib.rs` | Wiring: managed state, engine auto-start, command registration. |
| `engine.rs` | Spawning/stopping llama.cpp (Vulkan), model files, VRAM detection. |
| `documents.rs` | Typst compile, document save/read, path granting (`Granted` allowlist). |
| `knowledge.rs` | Folder knowledge: chunking granted folders, relevance retrieval. |
| `google_auth.rs` | OAuth loopback + PKCE, collaboration-scope gate, token storage/refresh, cancel. See `GOOGLE-DRIVE.md`. |
| `google_drive.rs` | Selected-workspace boundary, recursive direct retrieval/native export, confirmed native-Sheet value writes, and optional mirror sync. See `GOOGLE-DRIVE.md`. |
| `downloads.rs` | Resumable model downloads. |
| `updates.rs` | App version for the in-app updater. |
| `state.rs` | Shared state types (`Engine`, `Granted`, `KnowledgeCache`, …). |
| `vision.rs` | Optional vision-model engine swap (image describe/search). |
| `automation.rs` | Ephemeral authenticated loopback bridge into semantic live-webview actions. |
| `mcp.rs` | Embedded stdio MCP mode, tool schemas, and JSON-RPC protocol routing. |
| `mcp_setup.rs` | Running-executable discovery plus copy-ready JSON/TOML configuration and connection prompts shared by the UI and MCP. |
| `platform_contracts.rs` | Machine-readable provider, adversarial-review, and researcher-plugin schemas/status exposed to headless MCP clients. |
| `model_provider.rs` | Rust-owned remote-model HTTP/normalization boundary. The OpenAI Responses one-shot wire contract, bounded timeout, stalled-body deadline, and in-flight cancellation have fake-server evidence but are not product-wired pending credential integration and disclosure gates. |
| `provider_stream.rs` | Incremental provider SSE normalization. The OpenAI decoder handles byte-fragmented Unicode, multiline frames, usage/finish events, unknown future events, sanitized provider errors, and bounded malformed/truncated input. |
| `credential_vault.rs` | Provider-secret abstraction backed by Windows Credential Manager, macOS Keychain, or Linux Secret Service/keyutils. Unit tests use only a memory implementation; a separate live harness creates and deletes a random OS-store canary. |

**Security posture:** the model only ever sees selected text; the webview never sees OAuth
credentials/tokens (they live in Rust + app-data); local file access is allowlisted via
`Granted`. Google's collaboration token has Drive-wide technical authority, but every product
operation is constrained in Rust to a locally selected workspace folder ID and descendants.
That distinction is disclosed in the UI and audited in `docs/audits/DECISIONS/ADR-0001-*`.

## Frontend layout (`frontend/src/`)

- `App.tsx` — state-driven views (no router). **Ask** and the first **Workspace** vertical
  slice are sibling views.
- `store.ts` — one zustand store, persisted to localStorage under key **`syzygy`**
  (`storage.ts` wraps quota/corruption; `migrations.ts` is the only place save-shape
  changes are reconciled). Slices: `settings`, engine runtime, `experts`, `asks`.
- `tauri.ts` — **the single typed boundary** to the Rust core. Every command has a wrapper
  here; components never import `invoke` directly. The wrapper auto-logs every backend
  failure to the diagnostic log (`log.ts`).
- `api/ollama.ts` — streaming chat to the local engine; `api/classifiers.ts` — one-shot
  intent/vision classifiers.
- `components/` — Ask surface (`AskView`, `ExpertPicker/Editor`, `MessageInput`,
  `DocumentModal`, `FolderGrant`, `ImageFinderModal`), shell (`TitleBar`, `Sidebar`,
  `SettingsPanel`, `SetupWizard`, `SplashScreen`, `UpdateCheck`, `ModelsModal`,
  `LogModal`), Drive (`GoogleDriveButton`), brand (`SyzygyMark`).
- `workspace/` — schema-versioned project manifests, provider-neutral Yjs shared types,
  the local IndexedDB collaboration provider, an original Lexical policy editor, and the
  research workspace shell. Reserved Yjs collections hold scenarios, heuristics,
  discussions, and settings; the Lexical/Yjs editor owns the `root` shared type.
- `automationBridge.ts` — semantic live-app dispatcher for MCP status, walkthrough, project
  navigation, and revision-guarded editor reads/writes. It does not own persistence.
- `components/McpSetupModal.tsx` — Settings guide that asks Rust for the exact running executable
  and displays copy-ready MCP configuration and prompts; it never guesses an install path.

## Persistence map

The frontend `workspace/` folder also defines one collaboration-provider lifecycle. IndexedDB is
the current product persistence provider; a deterministic Memory provider exists only to prove
two active documents converge through live edits, partitions, and reconnects. Future Drive and
WebSocket implementations must pass the same contract before their capability status changes.
Its `nodes/PolicyBlockNode.ts` is the first original domain editor node: stable identity and
review state live with editable Lexical content and survive JSON/MCP serialization and two-editor
convergence. Pointer and keyboard interaction gates remain open.

The frontend `extensions/` folder owns provider-neutral model descriptors, deterministic
adversarial-run planning plus an evidence-gated run-record validator, strict researcher-plugin manifests/proposals, and their headless
contract tests. `scripts/plugin-certifier.mjs` uses the committed Draft 2020-12 schemas to certify
package containment, proposal fixtures, documentation/license presence, and declared-authority
probes without executing plugin code. These contracts do not imply that remote adapters or plugin
execution have shipped.

| What | Where |
|---|---|
| Settings, experts, ask threads | localStorage key `syzygy` (webview) |
| Project manifests / active project | localStorage key `syzygy` (webview, migration v2) |
| Collaborative project updates | IndexedDB database `syzygy-project-v1:<projectId>` |
| Sanitized diagnostic history (last 500 entries) | localStorage key `syzygy-diagnostic-log-v1` (webview) |
| Google refresh token + client info | `<app-data>/google_auth.json` (Rust-only) |
| Future remote-model API keys | OS credential store under service `org.penumbra.syzygy.model-provider`; no key is stored until remote-provider UI is enabled |
| Selected Drive workspace ID/name | `<app-data>/drive_workspace.json` |
| Models (GGUF) | `<app-data>/models/` |
| Optional Drive mirror folder | `<Documents>/Syzygy` (manual sync with Drive folder "Syzygy") |
| Ephemeral MCP bridge descriptor | OS temp `syzygy-automation-v1.json` (port/token/PID/version only; removed on shutdown) |

## Key invariants

- **The AI loop is 100% local.** Never write copy claiming the whole app is offline —
  see `DESIGN.md → Voice`. Internet is touched only by explicitly invoked features:
  model downloads, update checks, Google Drive.
- **`tauri.ts` is the only invoke boundary** (logging + typing chokepoint).
- **`migrations.ts` is the only save-migration site.**
- **Removed features come back from Aphelion** (`D:\LocalLLM`), not from git archaeology.
- **Shared-folder reads are remote-first.** Ask retrieves supported content directly from
  the selected Drive tree (including recursively exported native Google files); the local mirror
  is an explicit sync/offline option, not a collaboration prerequisite. Legacy `drive.file`
  grants fail closed instead of silently producing an empty context.
- **AI output never receives ambient write authority.** A local model may propose a bounded Sheet
  cell block against numbered workspace paths; Syzygy validates it, resolves the file ID outside
  the model, shows the exact values for human acceptance, and re-proves the target is a native
  Sheet beneath the selected workspace before calling Google Sheets.
- **Claims close through executable evidence.** `npm run audit` checks structural invariants;
  `npm run test:drive-live` exercises the real stored grant, Drive export, context retrieval, and
  local model without a webview; `npm run test:drive-write-live` creates a temporary native Sheet,
  writes and reads back 200 cells, then trashes it. See `docs/audits/`.
- **The collaborative workspace is Penumbra-original.** No Tiptap or PolicyPad code, packages,
  prompts, schemas, fixtures, assets, or UI enter the shipping tree. The baseline editor
  is exact-version MIT Lexical 0.47.0 with Yjs 13.6.31; all product nodes and UI are authored here.
- **Project metadata and collaborative content have different owners.** Zustand/localStorage holds
  manifest/navigation identity; Yjs/IndexedDB holds collaborative editor and domain state. No
  derived plain-text copy is a second mutable source of truth.
- **MCP automation is semantic and live.** Document mutations require a read revision and fail
  closed on concurrent change; the MCP receives no ambient Drive, filesystem, or model authority.
  Setup data is generated from `current_exe` in Rust and reused by the app and the
  `syzygy_installation` tool. See `MCP.md`.
- **Extensions request narrow authority.** Remote provider secrets and HTTPS stay in Rust. The
  OpenAI one-shot request boundary is fake-server certified but deliberately unwired until the OS
  credential-vault integration and typed disclosure gates pass; the request, deadline/cancellation,
  and stream-parser boundaries now pass headless conformance, and the vault abstraction and
  Windows live create/read/delete canary now pass but no Tauri command stores a user key. Other remote adapters remain
  contract-only. Plugins declare capabilities and submit revision-guarded proposals. No plugin
  code executes in the webview and no contract-only feature may report itself as available. See
  `PROVIDER-API.md`, `PLUGIN-API.md`, and ADR-0002/0003.

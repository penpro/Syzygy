# Syzygy Architecture

> The one-page mental model. If you read nothing else, read this.

## What Syzygy is

A **local-first AI document workspace**: a Tauri v2 desktop app pairing an optional fully-local LLM
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

1. **Local AI, when enabled** → direct `fetch` from the webview to the bundled llama.cpp server on
   `http://127.0.0.1:11435/v1` (OpenAI-compatible; hidden process; loopback only). The persisted
   `localAiEnabled` setting is read before startup; API-only and no-AI sessions spawn no engine.
2. **OS / files / network** → `invoke('command')` into the Rust core.

Future collaboration providers may include an optional self-hosted real-time relay. Local use
and Drive-asynchronous collaboration must not depend on a Penumbra-hosted service.

The installed executable also has an MCP stdio mode (`Syzygy --mcp`). That process connects to a
random-token authenticated ephemeral loopback bridge owned by the GUI, which emits semantic
requests into the live webview. It never edits browser storage or a local mirror as a second
source of project truth.

The optional development LAN control plane keeps that bridge loopback-only. Each installed
`Syzygy --lan-agent` process spawns its own local stdio MCP and makes an outbound, pairing-key-
authenticated encrypted connection to a repository-side coordinator. The coordinator is a stdio
MCP server for one test host and namespaces calls by installation. Protocol `syzygy-lan-v1` uses
fresh challenge nonces, HMAC-SHA-256 proof, HKDF-SHA-256 direction keys, AES-256-GCM frames, replay
counters, bounded requests, and heartbeat eviction. It controls installations; it is not a project
persistence provider. See `LAN-MCP.md`.

```
 you ──▶ webview (React) ──▶ 127.0.0.1:11435 llama.cpp ──▶ GGUF on GPU
              │
              └─ invoke() ──▶ Rust core ── files, engine mgmt, Google APIs
```

Development builds are supervised outside the shipped runtime by
`scripts/supervised-build.mjs`. A short launcher starts one detached worker; atomic state and an
ignored output log under `.syzygy-dev-runs/` let a terminal, Codex session, or another local tool
reconnect without owning the build process. Every child gate still runs through the shell-free
repository watchdog, and package builds must verify app/model shutdown, asset re-embedding, and the
packaged MCP surface before succeeding.

## Rust core modules (`frontend/src-tauri/src/`)

| Module | Owns |
|---|---|
| `lib.rs` | Wiring: managed state and command registration; it deliberately does not auto-start AI. |
| `engine.rs` | Spawning/stopping llama.cpp (Vulkan), bounded process reaping and loopback-release verification, model files, VRAM detection. |
| `documents.rs` | Typst compile, document save/read, path granting (`Granted` allowlist). |
| `knowledge.rs` | Folder knowledge: chunking granted folders, relevance retrieval. |
| `google_auth.rs` | OAuth loopback + PKCE, collaboration-scope gate, token storage/refresh, cancel. See `GOOGLE-DRIVE.md`. |
| `google_drive.rs` | Selected-workspace boundary, recursive direct retrieval/native export, confirmed native-Sheet value writes, and optional mirror sync. See `GOOGLE-DRIVE.md`. |
| `drive_projects.rs` | Append-only Drive project manifests and coalesced Yjs update records, strict identity/integrity bounds, and the live cleanup canary. |
| `downloads.rs` | Resumable model downloads. |
| `updates.rs` | App version for the in-app updater. |
| `state.rs` | Shared state types (`Engine`, `Granted`, `KnowledgeCache`, …). |
| `vision.rs` | Optional vision-model engine swap (image describe/search). |
| `automation.rs` | Ephemeral authenticated loopback bridge into semantic live-webview actions. |
| `mcp.rs` | Embedded stdio MCP mode, tool schemas, and JSON-RPC protocol routing. |
| `lan_agent.rs` | Packaged outbound encrypted agent that proxies the installed stdio MCP to an authenticated private-LAN coordinator without rebinding the GUI bridge. |
| `mcp_setup.rs` | Running-executable discovery plus copy-ready JSON/TOML configuration and connection prompts shared by the UI and MCP. |
| `platform_contracts.rs` | Machine-readable provider-run, adversarial-review, and researcher-plugin schemas/status exposed to headless MCP clients. |
| `model_provider.rs` | Rust-owned remote-model HTTP/normalization boundary. OpenAI Responses one-shot/SSE plus Anthropic Messages, Gemini Interactions, and xAI Responses one-shot wire contracts have fake-server evidence with bounded controls and sanitized normalization. |
| `provider_runtime.rs` | Built-in provider task/vault/provenance bridge. The public command accepts a structured question plus labeled source snapshots; Rust derives disclosure categories and provenance IDs from that exact payload. Every ordinary call uses a blocking native dialog to create one-use approval before any vault read or network access. The workspace's optional single-review panel is now a product caller and preserves cancellation/non-mutating output. A separate adversarial command can create/status/revoke an exact-route, bounded, expiring batch authorization. A private, non-executing reservation function atomically proves run/source-ID/route/call-ID checks and route+total decrements, but no command consumes it or calls a model. Fake-network one-shot execution and Rust→TypeScript record validation are proven; live-provider execution is not. |
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
  changes are reconciled). Slices: `settings` (including local-AI lifecycle and stable per-install
  researcher attribution), engine runtime, `experts`, `asks`.
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
  research workspace shell. Reserved Yjs collections hold scenarios, heuristics, immutable
  versions, discussions, and settings; `heuristicsModel.ts` owns nested collaborative records,
  `scenarioModel.ts` owns stable multi-turn scenario/branch records; `scenarioVoteModel.ts`,
  `scenarioAnnotationModel.ts`, and `scenarioLabelModel.ts` own namespaced participant vote,
  flag/note lifecycle, and context-label/assignment events;
  while `policyVersionModel.ts`
  stores canonical version envelopes as SHA-256-addressed strings whose hash is rechecked on every
  read. The Lexical/Yjs editor owns the `root` shared type.
  `PolicyVersionRail.tsx` subscribes to that same live document, saves the exact semantic editor
  revision against the exact version head, and presents verified immutable checkpoints plus
  deterministic parent diffs. `projectArchive.ts` exports a size-bounded, SHA-256-protected
  envelope containing only the project manifest and exact Yjs state. Import validates both project
  and document identity, refuses manifest/document collisions and different orphaned IndexedDB
  state, resets transport to local, persists before opening, and never carries settings, model
  configuration, OAuth state, or provider credentials. `ProjectArchiveControls.tsx` exposes the
  same engine-free import path with or without an existing project.
- `automationBridge.ts` — semantic live-app dispatcher for MCP status, walkthrough, project
  navigation, revision-guarded editor reads/writes, and bounded read-only research-state integrity
  inspection. `scenarioAutomation.ts` creates scenarios, adds/revises attributed turns, and casts
  immutable participant vote events, and manages parent-linked flag/note lifecycle only against
  the monotonic research revision returned by inspection or the prior mutation. Annotation edits,
  resolves, and reopens also require the exact current lifecycle event.
  `versionAutomation.ts` maps the exact active semantic editor snapshot into an
  immutable version only after both the document revision and version head pass inside the final
  Yjs transaction. The bridge does not own persistence.
  The MCP restore route reuses the same editor controller and restore transaction with exact
  target-version, document-revision, and current-head guards; it does not introduce a second
  persistence or history path.
- `components/McpSetupModal.tsx` — Settings guide that asks Rust for the exact running executable
  and displays copy-ready MCP configuration and prompts; it never guesses an install path.
- `components/RemoteProviderSettings.tsx` — collapsed advanced settings for OpenAI, Anthropic,
  Gemini, and xAI OS-vault credentials. It shows only presence, clears the password field after a
  write attempt, persists no frontend state, and has no generation authority.

## Persistence map

The frontend `workspace/` folder defines one collaboration-provider lifecycle. IndexedDB remains
the local durability layer. Local projects use it alone; Drive-bound projects add an append-only
remote provider that polls immutable coalesced Yjs updates in the selected workspace and merges
them through Yjs. A deterministic Memory provider remains the fast provider-contract fixture. The
Drive provider publishes to the UI/MCP automation registry only after local reopen plus its initial
remote pull, and a live canary proves the underlying Google create/list/readback/cleanup path.
The local provider publishes its document to the UI/MCP automation registry only after IndexedDB
synchronization and uses a connection generation guard so stale lifecycle continuations fail closed.
Its `nodes/PolicyBlockNode.ts` is the first original domain editor node: stable identity and
review state live with editable Lexical content and survive JSON/MCP serialization and two-editor
convergence. `editorStructure.ts` owns one semantic reorder command shared by toolbar buttons and
Alt+Shift+Arrow shortcuts, while `ResearchTableOfContents.tsx` derives navigation directly from
live heading nodes rather than storing a second outline. Reordering is enabled for the current
single IndexedDB document; the explicit partitioned move-versus-edit expected-failure fixture must
pass before any remote provider may claim structural-edit safety.

`heuristicsModel.ts` is the first non-editor shared research domain service. Each heuristic is a
nested Y.Map so concurrent edits to different fields merge instead of replacing an opaque object;
a nested edit map retains unique author/time/changed-field/value events. Reads validate and
project bounded records, duplicate/reused edit identity fails closed locally and after peer merge,
and top-level deletion wins
over a concurrent nested edit in the committed convergence fixture. No heuristics UI or evaluation
engine is claimed.

`scenarioModel.ts` stores each scenario, ordered turn collection, turn revision collection, and
scenario edit history as nested Yjs types. Public scenario, turn, and edit identities are stored
under peer-specific internal keys so disconnected collisions survive merge and make projection
fail closed. Independent scalar edits and turn insertions converge; turn revisions retain every
attributed alternative and select a deterministic current value. A graph inspector detects invalid
records, missing parents, and cycles. No visible gallery, generation, response evaluation, voting,
or portable scenario-pack export was previously claimed. `ScenarioWorkspace.tsx` now provides an
engine-free product gallery with create/select/edit/status controls, ordered turn addition, and
attributed vote/withdraw controls against the same live Y.Doc. It observes peer updates, refuses
stale detail saves when any scenario edit identity changed, and makes graph-integrity failures
read-only. Turn revision editing, generation, evaluation, annotations, labels, and scenario-pack
export remain outside this slice.

`scenarioVoteModel.ts` stores immutable vote events in peer-specific, version-prefixed buckets
inside the reserved discussions collection. This avoids namespace collisions with future notes and
flags while allowing disconnected first votes to merge without replacing one another. Projection
deduplicates exact replay, fails closed on conflicting event identity, retains re-vote/withdrawal
history, and chooses each participant's current event by timestamp then event identity. Caller-
supplied participant identity and time are not authentication or a trusted clock; the product vote
controls disclose that identity limitation.

`scenarioAnnotationModel.ts` uses a separate version-prefixed discussion namespace for immutable
flag/note lifecycle events. Create, edit, resolve, and reopen operations retain author/display-name-
at-the-time metadata. Every non-create event names its exact parent; product writes require the
current event, while concurrent children remain as auditable branches and one timestamp/event-ID
ordering supplies the deterministic projection. Missing scenario/turn targets and colliding public
annotation identities are integrity failures. No annotations UI or authenticated identity is claimed.

`scenarioLabelModel.ts` stores context-label and scenario-assignment event histories in separate
versioned namespaces inside the reserved settings collection. Label renames and add/remove
assignments name their exact parent; disconnected concurrent renames remain in history and one
timestamp/event-ID ordering produces a deterministic current name. Filtering projects only active
assignments. Colliding roots and orphan scenario/label targets fail closed or surface in inspection.
`scenarioAutomation.ts` exposes label create/rename/assignment operations to the live automation
bridge. Every call consumes the exact research-state revision; rename and follow-up assignment
also consume the projected current event, so stale requests add no event. Responses expose bounded
metadata rather than event bodies. No label UI, moderation, authenticated identity, or remote-
provider proof is claimed.

`policyVersionModel.ts` owns immutable policy checkpoints. A version contains a structured policy
snapshot, parent hash, sorted scenario references, participant ID, display-name snapshot,
timestamp, and optional note. The canonical envelope is stored under its SHA-256 identifier;
readback reparses, re-canonicalizes, and rehashes it, so direct or remote replacement fails closed.
Returned structures are detached copies. The product version rail now subscribes through the
lifecycle-safe live-document registry, commits the exact semantic editor revision under exact-head
guards, lists hashes/notes/author snapshots, and renders bounded parent diffs. Failed or pending
history verification clears stale rail state and disables checkpoint creation; the product never
offers a save action against an unverified immutable-history view. Per-install identity is persisted
through store migration v3; changing its display name does not rewrite old versions.

`policyVersionHistory.ts` adds exact-head commits and restore-as-new-version semantics. The mutable
head is one Yjs metadata pointer; a commit hashes its expected current head into the new immutable
parent link and rechecks the pointer inside the same Yjs transaction. Concurrent commits retain
both immutable branches even though Yjs deterministically selects one displayed head. The module
also produces a bounded structured block diff and deterministic count note without a model or
network call. `versionAutomation.ts` now restores exact semantic blocks and creates a new immutable
child of the current head inside one Yjs transaction after rechecking both the editor revision and
head. Its transaction mutation restores the prior draft/head if the editor step throws. The rail
requires a two-step confirmation and never rewrites history. A two-peer Memory-provider fixture
proves the Lexical root, version record, and head travel in one Yjs update; the peer's rendered
Lexical projection catches up after that shared transaction. Drive/WebSocket restore and automatic
conflict resolution remain unclaimed.

The twenty-fifth MCP tool exposes that same restore-as-new-head transaction. The packaged live
harness proves exact checkpoint readback after a temporary divergence, rejects stale document and
stale head attempts without adding a version, and rechecks bounded research-state integrity. It
does not authenticate caller identity or prove Drive/WebSocket restore convergence.

The frontend `extensions/` folder owns provider-neutral model descriptors, a content-free
provider-run provenance record, deterministic adversarial-run planning plus an evidence-gated
run-record validator and injected headless phase runner, strict researcher-plugin manifests/proposals, declarative custom model-adapter
profiles, public Draft 2020-12 schemas, and their headless contract tests. The plugin and adapter
certifiers use the committed schemas to certify
package containment, proposal fixtures, documentation/license presence, and declared-authority
probes without executing plugin/adapter code or contacting a model endpoint. The adversarial
runner accepts an injected executor and has no provider/product binding; its routing ledger is
separate from blinded judge artifacts, and its output cannot mutate shared state. These contracts
do not imply that remote adapters or plugin execution have shipped.

The non-executing plugin authority broker turns a validated manifest plus explicit grant into a
short-lived in-memory session. It returns detached project snapshots, pending revision-guarded
proposals, and narrow Drive/network/model authorization decisions, but contains no loader, fetch,
provider call, Drive call, or mutation implementation.

The first plugin WIT world is a separate public contract with zero imports. It accepts only a
bounded typed invocation and exports only no-change or proposal output; TypeScript validates the
same envelope before the future host may call the authority broker. The world is embedded in MCP
for installed-binary inspection. No component loader/runtime is present, so this is not a sandbox
availability claim.

| What | Where |
|---|---|
| Settings, experts, ask threads | localStorage key `syzygy` (webview) |
| Project manifests / active project / researcher attribution | localStorage key `syzygy` (webview, migration v3) |
| Collaborative project updates | IndexedDB database `syzygy-project-v1:<projectId>` |
| Portable project archive | User-chosen `.syzygy-project.json`; manifest plus exact checksummed Yjs state, no app/model/credential settings |
| Sanitized diagnostic history (last 500 entries) | localStorage key `syzygy-diagnostic-log-v1` (webview) |
| Google refresh token + client info | `<app-data>/google_auth.json` (Rust-only) |
| Optional remote-model API keys | OS credential store under service `org.penumbra.syzygy.model-provider`; the collapsed Settings UI can set/replace/delete and read only presence; no generation workflow is enabled |
| Selected Drive workspace ID/name | `<app-data>/drive_workspace.json` |
| Models (GGUF) | `<app-data>/models/` |
| Optional Drive mirror folder | `<Documents>/Syzygy` (manual sync with Drive folder "Syzygy") |
| Ephemeral MCP bridge descriptor | OS temp `syzygy-automation-v1.json` (port/token/PID/version only; removed on shutdown) |
| LAN pairing key | User-chosen 32-byte base64url key file; never stored in app settings, repository, Drive, command-line arguments, or coordinator descriptors |

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
- **LAN control never rebinds the GUI bridge.** The GUI remains IPv4-loopback-only; an explicit
  packaged agent makes the outbound encrypted connection and native MCP guards remain authoritative.
- **MCP automation is semantic and live.** Document mutations require a read revision and fail
  closed on concurrent change; the MCP receives no ambient Drive, filesystem, or model authority.
  Setup data is generated from `current_exe` in Rust and reused by the app and the
  `syzygy_installation` tool. See `MCP.md`.
- **Extensions request narrow authority.** Remote provider secrets and HTTPS stay in Rust. The
  OpenAI request/stream plus Anthropic, Gemini, and xAI one-shot boundaries are fake-server
  certified. Typed vault and generation commands now exist. Generation cannot accept an approval
  boolean, arbitrary disclosure categories, or detached source IDs from the webview. Rust derives
  categories/provenance from the structured research payload, shows a native per-send disclosure, and denial returns provenance
  before vault or network access. The bridge proves normalized execution, cancellation, and
  content-free Rust-to-TypeScript provenance. A separate adversarial batch authorizer validates
  exact remote routes and call ceilings, derives content categories from the real question/source
  scope plus cross-provider artifacts, and holds an expiring/revocable random capability in Rust
  process memory. Its private reservation state machine atomically enforces exact run/source-ID/
  route/call identity and route+total budgets under concurrency. It does not bind actual task bytes,
  read a credential, execute a call, or grant MCP authority; the authorized executor remains open.
  One product single-review workflow invokes provider execution; no MCP tool or adversarial batch invokes it;
  streamed tools, live-provider certification, and other remote adapters remain open.
  Plugins declare capabilities and submit revision-guarded proposals. No plugin
  code executes in the webview and no contract-only feature may report itself as available. See
  `PROVIDER-API.md`, `PLUGIN-API.md`, and ADR-0002/0003.

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
source of project truth. The explicit `inspect_drive_project_discovery` diagnostic asks the live
webview to refresh only selected-workspace project-manifest metadata; it returns a short folder
code and bounded project/document identities, never OAuth data, Drive file IDs, titles, or content.

The optional development LAN control plane keeps every GUI bridge loopback-only. On the primary
computer, the Settings host toggle launches the Penumbra-owned Node coordinator embedded in the
installed binary. It binds one explicit private address for encrypted outbound agents and a separate
pairing-key-authenticated control attachment on `127.0.0.1` at the adjacent port. Rust owns and
supervises that process with bounded restart backoff, starts it before the primary outbound agent, and
persists only listen address/port and pairing-key **path**. Host mode currently requires Node.js on the
primary computer.

Each `Syzygy --lan-agent` process spawns its installation's local stdio MCP and makes an outbound,
pairing-key-authenticated encrypted connection. Protocol `syzygy-lan-v1` uses fresh challenge nonces,
HMAC-SHA-256 proof, HKDF-SHA-256 direction keys, AES-256-GCM frames, replay counters, bounded requests,
and heartbeat eviction. The repository MCP wrapper authenticates to the loopback control attachment;
when app host mode is absent it can still own the coordinator and primary agent as a diagnostic fallback.
At app shutdown the outbound agent stops first, then closing the owned coordinator input asks Node to
close both listeners and active control sockets. Rust waits up to two seconds before a kill-and-reap
fallback. Key contents never enter the webview, persisted configuration, or process arguments. This
runtime controls installations; it is not a project persistence provider. See `LAN-MCP.md`.
The GUI parent now consumes a bounded, content-free stderr event stream from its outbound agent.
Settings therefore distinguishes child-process state from a completed encrypted handshake, retains the
last successful handshake time and retry count, and offers an immediate supervised reconnect. The
agent's internal network backoff remains bounded; a separate two-second parent supervisor restarts the
agent if the process itself exits. Process existence alone is never presented as connectivity.

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
| `drive_projects.rs` | Immutable active Drive project updates, content-addressed shared-title event graphs and retained snapshots, cancellation-bounded shared-project catalogs, snapshot-first bounded update/title archival, exact-inventory title restore plus recoverable quarantine, strict identity/integrity bounds, and the live cleanup canary. |
| `downloads.rs` | Resumable model downloads. |
| `updates.rs` | App version for the in-app updater. |
| `state.rs` | Shared state types (`Engine`, `Granted`, `KnowledgeCache`, …). |
| `vision.rs` | Optional vision-model engine swap (image describe/search). |
| `automation.rs` | Ephemeral authenticated loopback bridge into semantic live-webview actions. |
| `mcp.rs` | Embedded stdio MCP mode, tool schemas, and JSON-RPC protocol routing. |
| `lan_agent.rs` | Packaged outbound encrypted agent that proxies the installed stdio MCP to an authenticated private-LAN coordinator without rebinding the GUI bridge. |
| `mcp_setup.rs` | Running-executable discovery plus copy-ready JSON/TOML configuration and connection prompts shared by the UI and MCP. |
| `platform_contracts.rs` | Machine-readable provider-run, adversarial-review, and researcher-plugin schemas/status exposed to headless MCP clients. |
| `model_provider.rs` | Rust-owned remote-model HTTP/normalization boundary. OpenAI Responses, Anthropic Messages, Gemini Interactions, and xAI Responses one-shot/SSE wire contracts have fake-server evidence with bounded controls, custom-function schema mapping, non-executing proposal normalization, a depth/node/keyword-bounded schema subset, and exact post-assembly argument validation. Validation always separates structural status from unreviewed domain semantics and false execution authority. xAI's boolean ZDR response header is required before event dispatch and preserved in the run record. |
| `provider_runtime.rs` | Built-in provider task/vault/provenance bridge. Ordinary tasks use one native Send-once decision whose disclosure includes any tool names, descriptions, and argument schemas; normalized proposals stay transient and are never executed, while the content-free output hash commits to their bodies and validation state. The runtime matches calls only to definitions from the approved request and authors valid/invalid/missing-definition status before returning the final outcome. Adversarial execution uses one content-bound batch decision that freezes exact research bytes, graph/routes/dependencies/order/limits/budgets; atomically consumes calls; verifies upstream output hashes; derives phase prompts; uses fixed built-in endpoints and the OS vault; rejects unsafe JSON; and records content-free provenance. The product executor is reachable through typed Tauri wrappers and revision-guarded resumable MCP jobs. Loopback transport is proven; packaged dialog interaction and live-provider behavior are not. |
| `provider_stream.rs` | Incremental provider SSE normalization. OpenAI, Anthropic, Gemini, and xAI decoders handle fragmented frames, text/usage/finish lifecycles, unknown future events, sanitized provider errors, and bounded malformed/truncated input. Custom function calls normalize to one bounded start/delta/complete proposal lifecycle; orphaned, mismatched, malformed, duplicate, or unfinished calls fail closed. Anthropic/Gemini private-thinking bodies remain omitted. |
| `collaboration_identity.rs` | OS-vault Ed25519 installation key, public fingerprint report, and narrowly typed live-presence, durable project-registration, plus fresh relay-member connection signing commands; it exposes no arbitrary signing or private-key read surface. |
| `collaboration_device_trust.rs` | Bounded per-installation, per-project current-state approval/revocation registry for verified collaboration device fingerprints; exact-state mutations use a serialized crash-recoverable native replace and do not grant relay access. |
| `credential_vault.rs` | Provider-secret abstraction backed by Windows Credential Manager, macOS Keychain, or Linux Secret Service/keyutils. Unit tests use only a memory implementation; a separate live harness creates and deletes a random OS-store canary. |

**Security posture:** the model only ever sees selected text; the webview never sees OAuth
credentials/tokens (they live in Rust + app-data); local file access is allowlisted via
`Granted`. Google's collaboration token has Drive-wide technical authority, but every product
operation is constrained in Rust to a locally selected workspace folder ID and descendants. The
explicit shared-project catalog is the narrow exception: it enumerates only bounded app-owned
`.syzygy-projects` roots visible to the account and grants no mutation authority. Choosing **Join**
validates and persists that result's exact parent before normal selected-workspace operations begin.
Selected-workspace and cross-workspace catalog commands have one 12-second whole-operation deadline.
Within one root, at most eight project manifest/title reads run concurrently and preserve listing
order; roots remain serial so the 200-root bound cannot multiply request concurrency. The deadline
cancels pending work before the live automation bridge's 15-second response budget, while MCP derives
a 20-second socket budget from that bridge limit.
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
  `LogModal`), Drive (`GoogleDriveButton`, reused by Ask, the global Drive/project destination,
  and local-project sharing), brand (`SyzygyMark`). Drive connection is therefore not coupled to
  an AI thread.
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
  `extensions/adversarialHistory.ts` uses versioned peer-namespaced keys inside the existing
  provider-neutral `discussions` map for explicit full adversarial-review archives and separate
  immutable human decision events. Archives are canonical SHA-256 envelopes and every read
  reconstructs the native plan and revalidates public/provenance records. Save/decide require the
  exact live Yjs revision; conflicts fail closed; routine inspection omits question/source/result/
  note bodies; neither path touches the editor root. Because this reuses an existing reserved Yjs
  collection and adds no persisted Zustand field, no save-shape migration is required.
  `AdversarialReviewWorkspace.tsx` is the product adapter over the same automation registry and
  shared domain. It reads exact live semantic blocks through the registered editor controller,
  preflights only credential presence, starts/cancels the bounded native job, and requires a separate
  full-content share action. History observes only the discussions map, decodes fail-closed archives,
  exposes every evidence class and conflict, and appends exact-parent decisions. It has no editor
  mutation import or apply control. `AdversarialEvidenceView.tsx` keeps artifact categories lazy
  and pages opened categories and nested proposal claims in deterministic 50-item increments; closed
  categories materialize no body markup. `adversarial-workspace.css` contains only theme-token styling.
  `PolicyVersionRail.tsx` subscribes to that same live document, saves the exact semantic editor
  revision against the exact version head, and presents verified immutable checkpoints plus
  deterministic parent diffs. `projectArchive.ts` exports a size-bounded, SHA-256-protected
  envelope containing only the project manifest and exact Yjs state. Import validates both project
  and document identity, refuses manifest/document collisions and different orphaned IndexedDB
  state before accepting migration failures from that state, resets transport to local, persists
  before opening, and never carries settings, model
  configuration, OAuth state, or provider credentials. `ProjectArchiveControls.tsx` exposes the
  same engine-free import path with or without an existing project. Because the archive carries
  exact Yjs state, stable scenario IDs, parent IDs, ordered turns, revision history, and graph
  integrity failures survive local rebinding and disconnected IndexedDB reopen. The separate
  `scenarioPack.ts` boundary exports only reusable scenario authoring state: selected scenarios plus
  required ancestors, ordered turns, complete turn/scenario edit history, timestamps, and attribution.
  Its 64-MiB-bounded `syzygy-scenario-pack` envelope uses canonical SHA-256, strict exact-field
  decoding, closed acyclic graph checks, and atomic same-ID collision refusal. Votes, annotations,
  labels, responses, rerun results, policies, project files, settings, credentials, and transport state
  are deliberately excluded. `ScenarioPackControls.tsx` provides explicit export, validate-preview,
  and confirm-import actions against the same live Y.Doc without a model or network call.
- `workspace/driveProjectDiscovery.ts` keeps the selected-workspace refresh used by MCP/LAN
  diagnostics. It produces explicit checked-folder/count results and a bounded, content-free
  diagnostic projection. The product browser separately calls the native bounded cross-workspace
  Syzygy-root catalog. Both catalog paths cancel as a whole after 12 seconds and bound per-root
  project metadata reads to eight; Join persists the exact parent workspace before constructing the
  Drive-bound project.
- `workspace/driveTitleRepairJobs.ts` keeps long Drive title inspections/repairs outside the
  15-second live automation request. Four bounded jobs may run at once, running jobs heartbeat every
  30 seconds, and count-only terminal state expires after one hour. Rust remains the inventory,
  snapshot, deadline, archive, and quarantine authority; the JavaScript registry grants no Drive IDs
  or direct mutation path.
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

The frontend `workspace/` folder defines one collaboration-provider lifecycle and an explicit
`{ realtime, awareness, durableLocal, remotePersistence, attachments }` capability record.
IndexedDB remains the local durability layer. Local projects use it alone; Drive-bound projects add
an append-only remote provider that polls immutable coalesced Yjs updates in the selected workspace
and merges them through Yjs. A deterministic Memory provider remains the fast provider-contract
fixture. `WebsocketProjectProvider` is the first non-Drive implementation: it composes the same local
IndexedDB/automation lifecycle with the stable Yjs 13 `y-websocket` protocol, live awareness,
15-second initial-readiness bound, and reconnect backoff. Binding validation permits plaintext only
for loopback/private-LAN hosts and rejects credentials, queries, fragments, prefilled room paths, and
weak room IDs. The product can persist that binding, create or accept a strict bounded invitation,
reopen through IndexedDB, show owned connection status, and leave the relay while keeping the local
copy. Store v7 is the idempotent persistence boundary. A v1 third-party/legacy invitation uses the
room ID as one read/edit bearer. A v2 app-managed invitation adds an exact member ID, role, and random
capability without putting credentials in the canonical endpoint or room path. A v3 managed
invitation additionally carries the relay-issued capability generation and optional expiry so the
holder can see the same operator-clock limit the relay enforces; v2 remains readable. A v4
invitation additionally carries one enrolled
installation-key ID. Its capability is usable only when that installation produces a fresh typed
Ed25519 connection proof; v1-v3 remain readable for compatibility. Offline archives
deliberately redact the entire live binding. The webview CSP permits dynamic WS/WSS connections
because endpoints are user-configured, while the application parser retains the private-plaintext
boundary. Capabilities authorize relay operations; v4 also authenticates one self-issued enrolled
installation key, never a person.

Live WebSocket awareness can add a schema-v2 self-signed installation proof. Rust creates one
Ed25519 key per installation and persists its PKCS#8 private bytes only in the operating-system
credential store. The live-presence signing command accepts exact bounded project, document,
participant, Yjs-awareness client, and 32-byte random session-nonce fields. The frontend independently reconstructs the
domain-separated canonical bytes and verifies the public-key fingerprint and signature with
WebCrypto before showing **signed device**. Legacy schema-v1 awareness remains explicitly unsigned,
and a missing vault or unsupported verifier never prevents collaboration. Focus/blur republishing
restores the same proof without invoking the signer again. Verification deduplicates at most 200
in-flight proofs and retains at most 400 exact all-field cache entries, so peer-controlled awareness
cannot create an unbounded crypto queue or reuse a result after mutating a signed field. Awareness
and its proof remain ephemeral.

After a proof verifies, the local user may approve, revoke, or re-approve its fingerprint for the
current project. The native current-state registry lives in app data, is capped at 1 MiB, 64 projects,
and 64 device decisions per project, rejects unknown fields and stale expected-state mutations, and
serializes a synced temporary-file/previous-file replace. A valid primary always wins; a previous
copy is read only when the primary is missing, while a malformed primary fails closed. Decisions
never enter Yjs, Drive, archives, relay frames, invitations, or another installation.

Collaborative Drive and WebSocket projects also expose a separate explicit **Register this device in
project** action. Its domain-separated deterministic signature binds only project and self-reported
participant ID to the same installation public key. Valid registrations are stored as distinct
plain Yjs settings records keyed by every signed identity field. Reads strictly parse and independently
verify at most 200 records in batches of eight; more than 1,000 total settings entries fails the
directory closed before signature work. Disconnected registrations converge, survive IndexedDB,
Drive/full-state relay persistence and portable archives, and remain available when their publisher
is offline. Multiple participant claims by one key remain visible as a conflict rather than selecting
an identity. Explicit local approval/revocation controls apply to these offline entries through the
same native registry. `inspect_research_state` returns bounded public fingerprints, participant IDs,
counts, conflicts, and integrity state without gaining a registration or trust mutation route.

This remains a device-key continuity foundation, not participant authentication. Keys are
self-issued, and local approval is a user-editable label rather than an access control. Durable
registration is replayable by design, can be deleted or flooded by a bearer peer,
and exposes a stable cross-project-correlatable public fingerprint only after explicit action. There
is no project-shared device approval, trusted clock, key rotation/recovery, or binding from a
fingerprint to a person or organization. A holder can claim any
participant ID, a rotated key appears unapproved, and an exact captured proof can still be replayed
for the same project/document/client/nonce context. Durable Yjs research events are not signed. The
local fingerprint decisions do not issue or revoke relay access. Separately, an explicit public
enrollment request lets the relay operator bind one managed member to an installation key. That is
relay-host authorization of a self-issued device key, not acceptance of the shared Yjs directory or
authentication of its participant claim.

The optional app-managed relay is a separate child mode of the installed Syzygy executable. Its
saved native configuration contains only enabled/listen/port; room IDs never appear in process
arguments. It binds only an explicit loopback/private-LAN address, is supervised with bounded
restart backoff, and treats stdin closure as graceful shutdown. Desktop close does not complete
until the child is reaped and its port can be rebound. The relay implements the stable
`y-websocket` binary exchange without interpreting Syzygy domain nodes. It caps frames at 12 MiB,
rooms at 32 clients, 256 total connections and 256 active rooms, 512 MiB total storage, and each room's deduplicated
append-only document-sync log at 64 MiB/8,192 records. Awareness is broadcast but never written. Complete log records are synced before relay,
and one partial crash tail is repaired without discarding earlier complete records. This is bounded
recovery storage, not an independently administered backup. Node.js and PowerShell are not runtime
dependencies for this research relay. Its separate, strict `members-v1.json` registry caps 256 rooms
and 64 members per room, stores only SHA-256 capability digests, and requires one active admin.
Managed WebSocket queries carry a random member ID and 256-bit capability. Admin/editor roles may
send Yjs step-two/update frames. A viewer transport drops outbound document-update frames while
retaining sync requests and awareness; the relay independently rejects every non-empty viewer write
before broadcast or persistence. New peers trigger a protocol query so existing awareness is
republished without server retention. Host-local issue/rotation/revocation commands still require an
exact registry revision and restart the owned child. A reserved, bounded relay control path also lets
an enrolled device-bound admin inspect the room or issue, rotate, and revoke members. Each connection
first consumes the ordinary fresh member proof, then accepts exactly one strict JSON action whose
SHA-256 digest, room, admin member, exact revision, issue time, and nonce are signed under the separate
`syzygy-relay-admin-action-v1` domain. Status uses revision zero; mutations hold the relay state lock,
durably replace and reload the registry, and evict every room peer so product providers obtain a fresh
signature before reconnecting. Issue requires the recipient's public device enrollment; responses
return a new capability only once. Rooms absent from the registry retain explicit legacy room-bearer compatibility. A member may additionally store one
validated Ed25519 public enrollment. Bound connections sign the exact room/member/capability/
generation plus a 32-byte nonce and issue time; the relay accepts at most a one-minute-old proof,
allows 15 seconds of forward clock skew, and atomically consumes it in a bounded 4,096-entry replay
cache before sending retained data. y-websocket reconnect creates a new provider and proof instead
of replaying the old query. Public WSS termination, authenticated human or organizational identity,
shared-directory approval, administrator recovery, trusted time, automatic replacement-credential
delivery, log
compaction/export/backup, broader abuse controls, and physical packaged multi-install proof remain
gates. A deterministic binary harness covers five device-bound clients, 60 rapid writes, a two-client
partition/rejoin, awareness cleanup/recovery, forced reauthentication, exact-revision conflict,
replay denial, and remote issue/rotate/revoke; it is not packaged physical-client evidence. Active member capabilities may expire between five minutes and one year or remain
unbounded. Exact-revision rotation preserves member ID and role, increments a public generation,
optionally replaces the expiry, and stores only the new digest so every old copy is rejected. This is
device-authorized capability administration, not key escrow or participant authentication. The
Drive provider publishes to the UI/MCP automation registry only after local reopen plus its initial
remote pull, and a live canary proves the underlying Google create/list/readback/cleanup path.
Drive project titles are a second, metadata-only append path rather than a mutable manifest field.
Each zero-body `title-event-<sha256>.json` record carries its strict event envelope in Drive
description metadata, names zero or more exact parent event hashes, and is rehashed on every read.
The immutable manifest supplies the initial `base-<sha256>` guard. One tip projects the current
title; simultaneous root or child events remain visible as multiple tips; one explicit event naming
the complete current tip set reconciles them without deleting history. The native boundary rejects
wrong project/document identity, missing parents, malformed or tampered hashes, stale/incomplete
tip sets, more than 20 parents, reads beyond the 400-event maintenance ceiling, and any new event at
the 200-active-event write ceiling. Canonical retained snapshots keep up to 5,000 events while active
records move to a recoverable archive. Exact-inventory repair reconstructs the maximal closed graph
from active plus archived plus quarantined records, snapshots it before moving anything, and quarantines invalid
active records without deleting or trusting them. The provider pulls
title state during normal synchronization, publishes it through an identity-safe registry, and only
updates the local Drive-bound manifest projection. A dirty product draft keeps the guards captured
when editing began, so a later peer title cannot be overwritten by silently adopting newer guards.
The local provider publishes its document to the UI/MCP automation registry only after IndexedDB
synchronization and uses a connection generation guard so stale lifecycle continuations fail closed.
`presenceRegistry.ts` separately publishes the active provider awareness object and an explicit
capability mode; token-gated cleanup prevents an old mount from removing a newer registration.
`presenceModel.ts` projects at most 200 schema-versioned participant states and omits cursor/
selection bodies. `ResearchPresence.tsx` renders the installation researcher identity, current
editing sessions, malformed-state warnings, and precise provider copy. Memory transports real
awareness packets and disconnect tombstones for two-client tests. Local mode is device-only;
Drive polling carries durable Yjs edits but no awareness packets, so it is labeled as lacking live
cursors and online status. Awareness is ephemeral and never written to Yjs, IndexedDB, Drive,
archives, diagnostics, or immutable versions.
Its `nodes/PolicyBlockNode.ts` is the first original domain editor node. The node now represents
placement and a render projection; `policyContentModel.ts` owns the canonical content record in a
deterministically named top-level Y.Text keyed by stable policy ID. Character data, bounded Lexical
inline embeds, text attributes, schema version, and draft/review/approved state therefore survive
independently of the root delete/insert used for a move. A versioned index supports enumeration and
archive inspection. `migrateLocalPolicyContentDocument` in `migrations.ts` validates every seed
before one idempotent local backfill transaction. It never auto-migrates an already-shared legacy
Drive baseline.

`policyContentBridge.ts` mirrors genuine local policy edits into the stable record and projects
canonical remote changes back into Lexical with `SKIP_COLLAB_TAG`, so projection does not create a
second Drive packet or enter local undo history. It reprojects after both collaboration-tagged
editor updates and arbitrary Yjs transactions, covering separately delivered append-only move and
edit packets. `editorStructure.ts` owns one semantic reorder command shared by toolbar buttons and
Alt+Shift+Arrow shortcuts, while `ResearchTableOfContents.tsx` derives navigation from live
headings. Local projects enable reorder. Drive projects enable it only when the bridge is healthy
and reports zero legacy policy IDs; checking, malformed, and legacy states fail visibly closed.

`nodes/ScenarioReferenceNode.tsx` is a Penumbra-original inline domain node that persists only a
stable scenario ID. `ScenarioReferenceContext.tsx` resolves its title from the same live project
Y.Doc used by the scenario gallery, so renames update the rendered chip without mutating editor
state. Missing targets are shown explicitly. The semantic editor/MCP form is
`[scenario:<stable-id>]`; parsing recreates the node, snapshots expose a sorted unique ID set, and
immutable policy checkpoints retain that set.
`nodes/ScenarioSpotlightNode.tsx` is the block-level companion. It also persists only the stable
scenario ID and projects title, workflow state, background, and ordered turns from the live project
Y.Doc. Embedding appends one shared Lexical block; collapsing replaces it with the inline reference
inside the same collaborative history, so undo/redo and remote Yjs updates preserve the transition.
The exact automation/version form is `[spotlight:<stable-id>]`; semantic blocks carry empty text
plus `scenarioId`, and immutable checkpoints restore the live projection rather than a stale copy
of scenario content. Missing targets remain visible. Packaged two-install pointer interaction is not
yet claimed.

`scenarioResponseModel.ts` stores response revisions in its own versioned, peer-namespaced section
of the shared discussions map, so existing Drive archives and Yjs transport carry them without a
new top-level save shape. Every revision retains response/scenario identity, exact parent, content,
author ID and display-name snapshot, timestamp, and human or provider/model/run provenance. Exact-
current guards reject stale edits; concurrent sibling edits both survive and select a deterministic
current projection. Reused identities, malformed graphs, and disconnected root collisions fail
closed. `ScenarioResponseWorkspace.tsx` is the live selected-scenario product controller: it uses
the same model for manual no-AI roots, human edits, generated variants, and regeneration; rechecks
scenario and response integrity before writes or provider/credential work; preserves stale drafts while disabling save; and
bounds rendering to 50 response cards and 50 recent lineage revisions. `ScenarioGenerator.tsx`
owns only provider selection/execution and passes generated exact-parent variants into that shared
workspace. `scenarioGeneration.ts` retains the bounded provider-neutral request/output and exact-
source commit guards. Arbitrary historical-parent selection and explicit sibling-branch resolution
remain open.

`suggestionModel.ts` stores immutable proposal and decision events in a separate versioned,
peer-namespaced section of the existing shared discussions map, so no save-shape migration or
second mutable policy copy is introduced. Proposals retain their source document revision, author
snapshot, timestamp, and human or provider/model/run provenance. Decisions name the exact proposal
event and retain the reviewer snapshot. Connected stale or opposite decisions fail before mutation;
disconnected opposite decisions both survive and project an explicit conflict. Replayed events are
idempotent, identity reuse and disconnected proposal-root collisions fail closed, and proposal or
decision writes never apply proposal text to the policy root. `SuggestionNode.tsx` persists only
the stable suggestion ID and projects the live proposal, decision history, missing-target state, and
conflict state through `SuggestionContext.tsx`. Accept and reject record review decisions only.
`suggestionApplication.ts` separately fingerprints the semantic policy content while excluding
review-card markers. **Apply to draft** requires the exact accepted proposal and decision, exact live
editor revision, unchanged policy-content fingerprint, exactly one marker, and no policy-ID collision.
It then replaces that marker through the existing semantic editor controller with one `review`
policy block whose stable ID is the suggestion ID. The controller rechecks the revision at mutation,
so a preparation/replacement race leaves the draft untouched. The application does not add MCP
authority or make reviewer identity authenticated.

`heuristicsModel.ts` is the first non-editor shared research domain service. Each heuristic is a
nested Y.Map so concurrent edits to different fields merge instead of replacing an opaque object;
a nested edit map retains unique author/time/changed-field/value events. Reads validate and
project bounded records, duplicate/reused edit identity fails closed locally and after peer merge,
and top-level deletion wins over a concurrent nested edit in the committed convergence fixture.
`heuristicExampleModel.ts` adds immutable positive/negative example and exact-parent removal
events in peer-namespaced buckets inside the existing discussions map, avoiding a save-shape
migration. `heuristicCheck.ts` freezes a bounded exact policy/heuristic/example snapshot and owns
the strict pass/fail/uncertain response contract. Every result requires non-empty rationale and
uncertainty plus sorted, non-overlapping citations whose quotes exactly equal the supplied policy
UTF-16 spans. `heuristicCheckRuntime.ts` routes that same contract to optional local inference or
the four native Send-once API adapters, permits one malformed-output repair attempt, and exposes no
tool or ambient-source authority. `heuristicCheckResultModel.ts` commits only while project, policy,
heuristic, and active-example revisions remain exact, then stores immutable attributed provenance
in peer-namespaced discussions buckets. Disconnected results coexist; hostile or colliding identity
fails closed. `HeuristicWorkspace.tsx` and `HeuristicChecker.tsx` keep manual rules/examples usable
with AI off and display rationale, residual uncertainty, verified spans, and route provenance.
Research inspection returns only result counts and integrity, omitting all bodies and citations.
Authenticated identity, semantic/model quality, live paid-provider proof, and packaged two-install
interaction are not claimed.

`scenarioEvaluation.ts` owns a strict handled/unhandled/uncertain contract over one verified
immutable policy version and one exact scenario revision. `scenarioEvaluationRuntime.ts` binds
that envelope to optional local inference or the four native Send-once routes without tools or
ambient sources. `scenarioRerunQueue.ts` stores immutable job/control/item/result records in
peer-namespaced existing settings/discussions maps: begin is durable before provider work and result
plus completion commit atomically. Projection rejects forks, identity reuse, route/version/revision
mismatch, foreign items, and malformed bounds. `scenarioRerunRunner.ts` is sequential, prevents a
duplicate runner in one app, resumes interrupted attempts, skips completed work, emits 30-second
progress heartbeats, and enforces a two-minute item deadline. `ScenarioRerunQueuePanel.tsx` exposes
paused creation plus creator-only start/pause/cancel/retry while every collaborator can read results.
Research inspection returns queue/status/route/item/integrity counts and orphan IDs only; all policy,
scenario, response, rationale, and uncertainty bodies remain omitted.

`scenarioComparison.ts` is a pure derived boundary over two verified completed queue projections and
two verified immutable policy snapshots. It accepts only exact-compatible project/document/prompt/
scenario-revision sets, sorts rows by stable scenario ID, derives rather than stores the outcome
matrix, and produces a 24-MB-bounded canonical `syzygy-scenario-comparison-v1` artifact. Decode
recomputes policy-version, scenario-revision, and artifact SHA-256 values plus every redundant job/
result/route join, executed-model set, latest source timestamp, change flag, and matrix.
`ScenarioComparisonPanel.tsx` reads only completed shared queues, keeps previews transient, presents
neutral side-by-side evidence, and uses the existing typed native Save helper for explicit export.
The open Draft 2020-12 schema documents structural bounds; runtime checks remain authoritative for
semantic joins and checksums. Research-state MCP inspection adds only a compatible-pair count.

`scenarioModel.ts` stores each scenario, ordered turn collection, turn revision DAG, and scenario
edit history as nested Yjs types. Public scenario, turn, and edit identities are stored under peer-
specific internal keys so disconnected collisions survive merge and make projection fail closed.
Each turn persists one selected `headEditId`; every revision persists its complete parent set and
source (`create`, `edit`, `reconcile`, or `migration-v1`). Projection validates the complete acyclic
graph and derives every unconsumed tip. Independent scalar edits and turn insertions converge;
simultaneous exact-parent edits remain sibling tips rather than overwriting one another. Ordinary
turn updates require the exact single current tip. A reconciliation requires the exact research
revision, selected head, and complete current tip set, then appends one attributed merge revision
whose parents retain every sibling. Stale or incomplete reconciliation is zero-write, exact retries
remain idempotent, and a later-arriving sibling reopens the conflict. A graph inspector detects
invalid records, missing parents, and cycles. `ScenarioWorkspace.tsx` provides an engine-free product gallery
with create/select/edit/status and attributed vote/withdraw controls against the same live Y.Doc.
`ScenarioTurnWorkspace.tsx` owns manual ordered turn creation and exact-parent revision editing,
keeps stale drafts visible until the researcher reloads shared state, visibly disables ordinary
editing when sibling tips exist, and lets the researcher retain a selected sibling through an
explicit all-parent merge. It bounds both conversation pages and visible lineage to 50 items without
discarding retained history. The broad MCP research
inspection remains body-free; `read_scenario` is a separate explicit disclosure that validates one
scenario and returns its background plus bounded ordered turn identity/head metadata without turn
bodies. `read_scenario_turn_revision` then returns exactly one chosen current, named, or indexed
revision body and exposes the persisted head, complete tip set, and reconciliation requirement.
Both reads are detached, graph-validated, and zero-write. `reconcile_scenario_turn` exposes the
same exact-head/complete-tip merge contract to MCP without granting model authority.
`ScenarioCollaborationPanel.tsx` adds scenario/turn note and flag create/edit/resolve/reopen plus
project-label create/rename/assignment controls. It pages both projections at 50 items, captures
exact event parents when editing, and rechecks graph, annotation, and label integrity immediately
before every write. The workspace observes peer updates, refuses stale detail saves when any scenario
edit identity changed, and makes integrity failures read-only. P-16 adds optional generation without making the gallery
dependent on AI: local inference is available only while the model is loaded, remote routes reuse
the native one-shot disclosure boundary, and both write through the attributed response domain only
if the selected scenario revision is unchanged. Arbitrary historical-parent regeneration and
response-variant conflict resolution remain outside this slice. Portable scenario packs emit the
strict v2 revision-DAG schema while accepting checksummed v1 packs through deterministic in-memory
migration. Existing project scenario records are upgraded only through `migrations.ts`, after local
IndexedDB or the initial Drive pull and before automation publication; archive imports migrate
before persistence fingerprinting. Strict preflight makes malformed/future input zero-write.

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
annotation identities are integrity failures. The product exposes the lifecycle without claiming
authenticated identity, moderation, notification delivery, or a trusted clock.

`scenarioLabelModel.ts` stores context-label and scenario-assignment event histories in separate
versioned namespaces inside the reserved settings collection. Label renames and add/remove
assignments name their exact parent; disconnected concurrent renames remain in history and one
timestamp/event-ID ordering produces a deterministic current name. Filtering projects only active
assignments. Colliding roots and orphan scenario/label targets fail closed or surface in inspection.
The product exposes creation, exact-parent rename, and per-scenario assignment without claiming
authenticated identity, moderation, or a trusted clock.
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

The frontend `extensions/` folder owns provider-neutral model descriptors, content-free
provider-run provenance, deterministic adversarial planning/validation, the native call-graph
builder/executor, revision-guarded resumable jobs, strict researcher-plugin manifests/proposals,
declarative custom model-adapter profiles, public Draft 2020-12 schemas, and headless contract
tests. The adversarial runner keeps route identity outside judge-visible artifacts, forwards only
exact completed upstream bytes, and can return only a pending non-mutating result. The job registry
limits concurrency, heartbeats every 30 seconds, aborts at 15 minutes, and retains terminal results
for one hour. Plugin and adapter certifiers still inspect packages without executing them; plugin
loading and custom-adapter execution remain unavailable.

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
| Ephemeral cursor/presence state | Active provider awareness only; never persisted or sent through Drive polling |
| Portable project archive | User-chosen `.syzygy-project.json`; manifest plus exact checksummed Yjs state, no app/model/credential settings |
| Sanitized diagnostic history (last 500 entries) | localStorage key `syzygy-diagnostic-log-v1` (webview) |
| Google refresh token + client info | `<app-data>/google_auth.json` (Rust-only) |
| Optional remote-model API keys | OS credential store under service `org.penumbra.syzygy.model-provider`; the webview reads only presence, and draft-review/scenario calls cross the Rust-owned native Send once boundary |
| Selected Drive workspace ID/name | `<app-data>/drive_workspace.json` |
| Models (GGUF) | `<app-data>/models/` |
| Optional Drive mirror folder | `<Documents>/Syzygy` (manual sync with Drive folder "Syzygy") |
| Ephemeral MCP bridge descriptor | OS temp `syzygy-automation-v1.json` (port/token/PID/version only; removed on shutdown) |
| LAN pairing key | User-chosen 32-byte base64url key file; never stored in app settings, repository, Drive, command-line arguments, or coordinator descriptors |
| Optional LAN agent settings | `<app-config>/lan-agent.json` (enabled flag, node label, private coordinator address/port, pairing-key path only; no key contents) |
| Optional LAN host settings | `<app-config>/lan-dev-coordinator.json` (enabled flag, explicit private listen address/port, pairing-key path only; no key contents) |

## Key invariants

- **Local inference needs no paid API.** Never write copy claiming the whole app or every AI
  path is offline—see `DESIGN.md → Voice`. Internet is touched only by explicitly invoked features:
  model downloads, update checks, Google Drive, and native-confirmed remote-provider calls.
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
- **LAN control never rebinds the GUI bridge.** The GUI remains IPv4-loopback-only. App host mode owns
  a separate explicit private coordinator listener plus authenticated loopback MCP attachment; packaged
  agents connect outbound, shutdown reaps both process classes, and native MCP guards remain authoritative.
- **MCP automation is semantic and live.** Document mutations require a read revision and fail
  closed on concurrent change; the MCP receives no ambient Drive, filesystem, or model authority.
  Setup data is generated from `current_exe` in Rust and reused by the app and the
  `syzygy_installation` tool. See `MCP.md`.
- **Extensions request narrow authority.** Remote provider secrets and HTTPS stay in Rust.
  Ordinary calls cannot forge approval, disclosure categories, or detached provenance. The
  adversarial path freezes the exact research bytes and complete call graph before one native
  decision; Rust atomically consumes call and route budgets, verifies dependency-output hashes,
  derives phase prompts, and dispatches only through built-in provider transports. MCP may start,
  inspect, or cancel this one revision-guarded workflow, but cannot choose arbitrary source bytes,
  prompts, endpoints, credentials, Drive content, or shared mutations. Results remain pending
  human review. Conformance uses loopback providers; live-provider certification, tool execution and
  result continuation, durable run UI/history, and quality evidence remain open. Current custom-function
  output is an inspectable transient proposal with no MCP, Drive, filesystem, plugin, editor, network,
  or shared-project mutation authority. Safe-subset schema validation is structural only: domain state
  remains explicitly unreviewed and execution remains false even when arguments match.
  Plugins declare capabilities and submit revision-guarded proposals. No plugin
  code executes in the webview and no contract-only feature may report itself as available. See
  `PROVIDER-API.md`, `PLUGIN-API.md`, and ADR-0002/0003.

## Network-boundary evidence gate

Every network-active feature has one entry in `docs/audits/NETWORK-BOUNDARIES.json`: default state, human activation, destination origins/routes, payload classes, credential handling, implementation anchors, matching product copy, and evidence. `scripts/network-boundary-harness.mjs` strictly validates that contract, walks production TypeScript/TSX/Rust/Tauri configuration, and fails on any unclassified literal origin. The sanitized proof records source path/line, origin, feature classification, and source hashes only—never a URL credential, path, query, fragment, request body, or source body.

The contract is embedded in `syzygy_platform_contracts`. This closes the reproducible source/copy evidence slice only. It does not replace Windows/macOS/Linux packet capture, DNS/CDN observation, third-party SDK wire inspection, or opt-in live-provider canaries, so S-06 remains `implemented_unverified`.

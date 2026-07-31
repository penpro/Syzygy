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
| `provider_runtime.rs` | Built-in provider task/vault/provenance bridge. Ordinary tasks use one native Send-once decision. Adversarial execution uses one content-bound batch decision that freezes exact research bytes, graph/routes/dependencies/order/limits/budgets; atomically consumes calls; verifies upstream output hashes; derives phase prompts; uses fixed built-in endpoints and the OS vault; rejects unsafe JSON; and records content-free provenance. The product executor is reachable through typed Tauri wrappers and revision-guarded resumable MCP jobs. Loopback transport is proven; packaged dialog interaction and live-provider behavior are not. |
| `provider_stream.rs` | Incremental provider SSE normalization. The OpenAI decoder handles byte-fragmented Unicode, multiline frames, usage/finish events, unknown future events, sanitized provider errors, and bounded malformed/truncated input. |
| `credential_vault.rs` | Provider-secret abstraction backed by Windows Credential Manager, macOS Keychain, or Linux Secret Service/keyutils. Unit tests use only a memory implementation; a separate live harness creates and deletes a random OS-store canary. |

**Security posture:** the model only ever sees selected text; the webview never sees OAuth
credentials/tokens (they live in Rust + app-data); local file access is allowlisted via
`Granted`. Google's collaboration token has Drive-wide technical authority, but every product
operation is constrained in Rust to a locally selected workspace folder ID and descendants. The
explicit shared-project catalog is the narrow exception: it enumerates only bounded app-owned
`.syzygy-projects` roots visible to the account and grants no mutation authority. Choosing **Join**
validates and persists that result's exact parent before normal selected-workspace operations begin.
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
  mutation import or apply control. `adversarial-workspace.css` contains only theme-token styling.
  `PolicyVersionRail.tsx` subscribes to that same live document, saves the exact semantic editor
  revision against the exact version head, and presents verified immutable checkpoints plus
  deterministic parent diffs. `projectArchive.ts` exports a size-bounded, SHA-256-protected
  envelope containing only the project manifest and exact Yjs state. Import validates both project
  and document identity, refuses manifest/document collisions and different orphaned IndexedDB
  state, resets transport to local, persists before opening, and never carries settings, model
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
  Syzygy-root catalog; Join persists the exact parent workspace before constructing the Drive-bound
  project.- `automationBridge.ts` — semantic live-app dispatcher for MCP status, walkthrough, project
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
`presenceRegistry.ts` separately publishes the active provider awareness object and an explicit
capability mode; token-gated cleanup prevents an old mount from removing a newer registration.
`presenceModel.ts` projects at most 200 schema-versioned participant states and omits cursor/
selection bodies. `ResearchPresence.tsx` renders the installation researcher identity, current
editing sessions, malformed-state warnings, and precise provider copy. Memory transports real
awareness packets and disconnect tombstones for two-client tests. Local mode is device-only;
Drive polling carries durable Yjs edits but no awareness packets, so it is labeled as lacking live
cursors and online status. Awareness is ephemeral and never written to Yjs, IndexedDB, Drive,
archives, diagnostics, or immutable versions.
Its `nodes/PolicyBlockNode.ts` is the first original domain editor node: stable identity and
review state live with editable Lexical content and survive JSON/MCP serialization and two-editor
convergence. `editorStructure.ts` owns one semantic reorder command shared by toolbar buttons and
Alt+Shift+Arrow shortcuts, while `ResearchTableOfContents.tsx` derives navigation directly from
live heading nodes rather than storing a second outline. Reordering is enabled for the current
single IndexedDB document; the explicit partitioned move-versus-edit expected-failure fixture must
pass before any remote provider may claim structural-edit safety.

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
closed. `ScenarioGenerator.tsx` now projects those variants in the selected scenario, while `scenarioGeneration.ts` owns the bounded, provider-neutral P-16 request/output contract and exact-source commit guard. `Regenerate` supplies the exact current response revision as bounded context and appends a new exact-parent model revision to the same response identity. Earlier and concurrent sibling variants remain inspectable; arbitrary historical-parent selection and human conflict resolution are not yet exposed.

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

`scenarioModel.ts` stores each scenario, ordered turn collection, turn revision collection, and
scenario edit history as nested Yjs types. Public scenario, turn, and edit identities are stored
under peer-specific internal keys so disconnected collisions survive merge and make projection
fail closed. Independent scalar edits and turn insertions converge; turn revisions retain every
attributed alternative and select a deterministic current value. A graph inspector detects invalid
records, missing parents, and cycles. `ScenarioWorkspace.tsx` provides an engine-free product gallery with create/select/edit/status
controls, ordered turn addition, and attributed vote/withdraw controls against the same live Y.Doc.
It observes peer updates, refuses stale detail saves when any scenario edit identity changed, and
makes graph-integrity failures read-only. P-16 adds optional generation without making the gallery
dependent on AI: local inference is available only while the model is loaded, remote routes reuse
the native one-shot disclosure boundary, and both write through the attributed response domain only
if the selected scenario revision is unchanged. Turn revision editing, arbitrary historical-parent
regeneration, and response conflict resolution remain outside this slice. Portable scenario packs
are handled by the independent open codec and product controls described above.

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
  human review. Conformance uses loopback providers; live-provider certification, streamed tools,
  durable run UI/history, and quality evidence remain open.
  Plugins declare capabilities and submit revision-guarded proposals. No plugin
  code executes in the webview and no contract-only feature may report itself as available. See
  `PROVIDER-API.md`, `PLUGIN-API.md`, and ADR-0002/0003.

## Network-boundary evidence gate

Every network-active feature has one entry in `docs/audits/NETWORK-BOUNDARIES.json`: default state, human activation, destination origins/routes, payload classes, credential handling, implementation anchors, matching product copy, and evidence. `scripts/network-boundary-harness.mjs` strictly validates that contract, walks production TypeScript/TSX/Rust/Tauri configuration, and fails on any unclassified literal origin. The sanitized proof records source path/line, origin, feature classification, and source hashes only—never a URL credential, path, query, fragment, request body, or source body.

The contract is embedded in `syzygy_platform_contracts`. This closes the reproducible source/copy evidence slice only. It does not replace Windows/macOS/Linux packet capture, DNS/CDN observation, third-party SDK wire inspection, or opt-in live-provider canaries, so S-06 remains `implemented_unverified`.

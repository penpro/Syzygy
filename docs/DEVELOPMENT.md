# Development & Release Processes

## Daily dev

```powershell
cd D:\PolicyPad\syzygy\frontend
npm install                # once
npm run fetch-engine       # once — MUST run from PowerShell, not Git Bash (see gotchas)
npm run tauri dev          # full app (Rust + webview)
npm run dev                # webview only on :5173 (splash overlays without the engine)
```

Checks (all must be green before shipping):
```powershell
npx tsc -b --force         # 0 errors
npx vitest run             # all pass
cargo check                # in src-tauri (cargo is at C:\Users\penum\.cargo\bin, not on PATH)
npm run audit              # architecture, identity, provenance, capability-ledger invariants
npm run test:providers     # fake-server remote-provider boundary; no live key or network required
npm run test:provider-runtime # fake-vault task bridge and Rust-authored provenance; no live key/network
npm run test:provider-runtime-interop # Rust record → public TS schema + semantic validator
npm run test:contracts     # public provider-run/adversarial/plugin schemas and semantic validators
npm run test:provider-streams # fragmented/multiline/unknown/malformed SSE conformance
npm run test:credentials   # memory-backed credential-vault contract; no OS store mutation
npm run test:plugin-sdk    # non-executing package/schema/path/authority certification
npm run test:model-adapter-sdk # non-executing custom adapter profile/endpoint certification
cargo fmt --all -- --check # Rust formatting
```

## Bounded command watchdog

Long-running development and overnight commands run through the repository watchdog:

```powershell
cd D:\PolicyPad\syzygy\frontend
node ..\scripts\run-with-heartbeat.mjs --timeout-seconds 480 --heartbeat-seconds 30 -- npm test
npm run test:watchdog
npm run test:goal-framework
```

`--timeout-seconds` is mandatory. Heartbeats default to 30 seconds and the runner rejects any
interval above 60 seconds, so a silent operation is inspected at least once per minute. It forwards
ordinary output without creating a second log containing possible research content. At the deadline
it terminates the child process tree and returns exit code 124; Ctrl+C returns 130. On Windows,
process-tree cleanup uses `taskkill /t /f`, while Unix uses TERM followed by a one-second KILL
fallback. The executable fixtures prove successful and failing exit propagation, a silent-command
heartbeat, rejection above the maximum interval, and forced timeout cleanup.

The watchdog does not make a hung operation successful and does not justify retrying indefinitely.
Use the operation-specific clamp from the active run plan, inspect no slower than the heartbeat,
and pivot after two identical failures or the slice timebox.

### Detached supervised build

Use the repository build supervisor for edit/check/package cycles instead of manually chaining
watchdog commands through one terminal or agent call:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run check:supervised           # detached tests, frontend build, audit, cargo check
npm run build:supervised           # detached tests, audit, cargo check, shutdown, installer, MCP smoke
npm run build:status               # latest run; add -- <run-id> for a specific run
npm run build:follow -- <run-id>   # reconnect to live output
npm run build:cancel -- <run-id>   # explicitly stop the worker and its active process tree
```

The launcher returns immediately with a run ID. The detached worker owns the entire plan, so losing
a PTY, tool yield, or Codex sampling turn does not abandon the build. Atomic `state.json`
checkpoints and `output.log` live in the ignored `.syzygy-dev-runs/<run-id>/` folder. Only one
active run is allowed; a dead worker is marked interrupted before a replacement starts. The check
profile has a 30-minute total deadline. The package profile has a 40-minute total deadline. Every
child step also uses `run-with-heartbeat.mjs` with a mandatory operation-specific deadline and a
30-second heartbeat. Production steps also stop after at most 120 seconds without real child output,
with the longest silence allowance reserved for Rust linking and installer generation. Child stdin
is closed, so an unattended prompt fails instead of waiting.

Before native packaging, the supervisor snapshots process ownership, requests a normal Syzygy
window close, and waits for both the app and its captured `llama-server` child to exit. If normal
close exceeds 60 seconds it terminates only the captured Syzygy process tree and verifies exit. It
refuses to kill an unrelated `llama-server`. Success also requires `Compiling app v` in the
Tauri output and a packaged MCP smoke pass. Run `npm run test:build-supervisor` for detached
success, fail-fast checkpoint, explicit cancellation, child-output stall, and process-tree timeout fixtures.

Long unattended goals use the complete
[worker/supervisor framework](UNATTENDED-GOAL-FRAMEWORK.md), not the command watchdog alone. Start
from the checked-in goal and supervisor templates; the independent supervisor stays read-only,
recovers after two silent one-minute checks, resumes from the last verified Git checkpoint, and
removes itself when the goal finishes.

If every sandboxed command fails before PowerShell, Node, or Git starts with
`helper_unknown_error: apply deny-read ACLs`, stop repository work and follow the dated
[Codex Windows sandbox incident recovery](UNATTENDED-GOAL-FRAMEWORK.md#codex-windows-sandbox-incident--2026-08-10).
The failure is user-level Codex sandbox state, not evidence of repository corruption; do not reset
the worktree or broadly rewrite repository ACLs.

## Headless local-AI lifecycle proof

```powershell
cd D:\PolicyPad\syzygy\frontend
npm test -- --run src/localAi.test.ts src/localAi.ui.test.ts src/migrations.test.ts
npm run test:engine-shutdown
npm run build
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

The policy tests fail unless an explicit opt-out selects no model, an opted-in install without a
text model requests setup, the saved model is preferred, and the largest text model—not a vision
projector—is the fallback. Server-rendered component checks require the explicit first-run escape
and an accessible off switch in the title-bar statistics surface. Migration coverage proves legacy
saves default on while an explicit off choice survives restart. The frontend and Rust compile gates
ensure lifecycle ownership stays
split correctly: Rust starts nothing during setup; React starts only after reading persisted state.
These checks do not replace the packaged UI proof of setup skip, unload/reload, and VRAM-bar state.
The Rust shutdown gate launches a real child process, terminates it through the production bounded
reaper, and requires an observed exit. On Windows it also makes a child hold a DLL-shaped probe
with delete/overwrite sharing disabled, proves the file is locked, then requires it to be
replaceable immediately after shutdown returns. Normal window close and the updater use that same
path; they do not rely on a fixed sleep. A successful shutdown report additionally requires the
local-AI port to stop accepting connections. This proves tracked-process and OS file-lock release,
not cleanup after a hard power loss or an externally launched untracked process.

## Headless workspace proof

Run the editor/project scaffold without opening a webview:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:workspace
```

This fails unless project manifests reject malformed/future schemas, old persisted stores migrate
idempotently, duplicate/out-of-order Yjs updates converge, concurrent offline collections survive,
and acknowledged project state reopens from IndexedDB. The local provider must remain absent from
the live automation registry until that IndexedDB merge finishes. Migration tests also require
store v3 to rewrite the generated researcher ID once, preserve an existing ID/name, and reject a
future store version. The version-rail component contract separately requires corrupt history to
replace stale results with an alert and a disabled save action against unverified state.
`driveProjectProvider.test.ts` proves two logical installations converge through the Drive provider
contract, including independent offline edits and reconnect. It also proves explicit compaction pulls
first, appends a complete snapshot before archival, retains a record arriving during compaction,
reconstructs the exact Yjs state on a clean installation, reports partial archival without losing
state, retries safely, and runs a caller revision guard after the final pull but before snapshot
upload. `driveProjectMaintenanceRegistry.test.ts` proves a disconnecting old provider cannot remove
its replacement's maintenance authority. Rust `drive_projects::tests` cap each archival batch at 200,
exclude the snapshot and unknown concurrent IDs, retain recoverable zero-move retry behavior, and
the structural audit requires a 30-second deadline on every native Drive-project HTTP request plus
a 60-second deadline around the post-snapshot validation/archive phase. A phase timeout is an
explicit safe-retry result: the snapshot already exists and moved records remain recoverable.
These remain distinct from a real-Drive compaction canary and two-physical-install packaged gate.

The shared-project title gate spans `drive_projects::tests`, `driveProjectProvider.test.ts`,
`driveProjectTitleStatus.test.ts`, `driveProjectMaintenanceRegistry.test.ts`,
`driveProjectStore.test.ts`, and `WorkspaceView.ui.test.ts`. Rust rehashes strict description-backed
events, rejects missing parents/tampering/excess history, derives every sibling tip, and proves an
all-tip merge. Provider tests inject disconnected siblings, retain both, reconcile their exact tip
set, and reject a stale rename after a final pull. The product draft test proves that an edit keeps
the guards captured when it became dirty rather than adopting a peer update. MCP schema/routing and
the stdio harness require a unique 1-20 guard array for Drive projects. The physical LAN mutating
harness additionally renames from each installation, waits for the other local manifest projection,
rejects the old guard, and restores the original title; its boolean evidence does not print titles.
Title retention now builds one canonical, content-addressed snapshot from the complete validated
graph before moving any observed title event or superseded snapshot. Rust fixtures prove snapshot
round-trip, canonical ordering, missing-parent rejection, and a concurrent child whose archived
parent remains resolvable. Provider/registry tests prove the exact guard, count-only result, local
projection update, and replacement-provider ownership; the product and strict
`retain_drive_title_history` MCP tool expose an explicit retryable action. New renames stop at 200
active title files while reads/retention accept a bounded 400-file concurrency overflow; retained
history stops at 5,000 events and 4 MiB, archive moves at 200/eight-way, and the
post-snapshot phase at 60 seconds. Those deterministic gates do not substitute for rerunning the
physical harness on a packaged build or for real-Drive quota/interruption/partial-move evidence.

Retained-title recovery uses two explicit steps. `google_drive_project_title_repair_inspect` hashes
the exact recognized active/archive/quarantine inventory and returns only counts. Repair requires that hash,
constructs the maximal parent-complete graph, appends/reuses its canonical snapshot, re-lists the
inventory, and refuses every move if pre-existing input changed or any unexpected record appeared.
Invalid active records move to `quarantined-title-history/`; valid active records return to the
recoverable archive; nothing is deleted. Focused native planning and MCP routing:

```powershell
node scripts\run-with-heartbeat.mjs --timeout-seconds 120 --heartbeat-seconds 30 -- cargo test --manifest-path frontend\src-tauri\Cargo.toml shared_title_repair
node scripts\run-with-heartbeat.mjs --timeout-seconds 120 --heartbeat-seconds 30 -- cargo test --manifest-path frontend\src-tauri\Cargo.toml mcp::tests
node scripts\run-with-heartbeat.mjs --timeout-seconds 120 --heartbeat-seconds 30 -- npm --prefix frontend exec vitest run src/workspace/driveTitleRepairJobs.test.ts src/workspace/WorkspaceView.ui.test.ts
```

The native operation has a 120-second absolute deadline, retains 30-second request deadlines and a
60-second move phase, inspects at most 501 active/5,200 archived/5,200 quarantined recognized records, reads at most 64
snapshots and 32 MiB per location, and moves 200 records eight-way per run. MCP uses a four-active-job
registry so the 15-second semantic bridge returns immediately; running jobs heartbeat every 30
seconds and count-only terminal records expire after one hour. Tests prove planning and job behavior,
not real-Drive interruption, quota, process-loss recovery, or the semantic trustworthiness of
quarantined data.

The Drive catalog supervision gate spans `drive_projects::tests` and `npm run audit`. Both the
selected-workspace list and the cross-workspace browser are wrapped in one cancellation-safe
12-second deadline. Project manifest/title reads are ordered and limited to eight concurrent
requests within a root, while roots remain serial. The Rust test completes a ready future, times out
an indefinitely pending future, verifies that cancellation drops its work, and checks the sanitized
retry error. A compile-time assertion keeps the catalog deadline below the live automation bridge's
15-second response budget; MCP derives its 20-second socket read budget from that bridge constant.
The structural audit locks all of those production call sites and constants. This proves bounded
cancellation and wiring without a credential; large-account Drive quota/latency behavior remains a
real-Drive evidence gap.

Portable archives are covered by `projectArchive.test.ts` and
`ProjectArchiveControls.ui.test.ts`. The domain fixture exports the exact Yjs state, reopens every
reserved shared collection through IndexedDB without a network provider, and rejects corrupted
hashes, future schemas, unknown envelope/manifest fields, project/document collisions, identity
mismatch, oversized input, and different orphaned local state even when that orphan contains
malformed scenario records. The server-rendered UI contract
requires import with no current project, disables export before the live document is ready, and
announces errors. `scenarioArchiveGraph.test.ts` is the additional P-22 gate: a four-node,
two-level graph with ordered turn/revision content must survive archive decoding, local persistence,
and disconnected IndexedDB reopen exactly, while a missing-parent integrity failure must remain
visible rather than being laundered by import. This is engine-free, fake-IndexedDB evidence; P-22
and S-04 remain `implemented_unverified` until packaged two-install interaction is reproduced.
Evidence: `docs/audits/runs/SCENARIO-BRANCH-ARCHIVE-2026-07-19.json`.

The editor structure slice is covered by `ResearchEditorFormatting.test.ts`,
`editorStructure.test.ts`, `ResearchTableOfContents.ui.test.ts`, `PolicyBlockNode.test.ts`,
and the `policyContent*` suites. They prove supported heading/quote/mark structure, a shared
pointer/keyboard reorder command, a live-derived accessible outline, and stable policy identity
across a partition where one peer moves a block while another edits, formats, and changes its
status. Canonical policy content lives in deterministic top-level Y.Text records, independent of
Lexical root placement. Drive-shared reorder stays readiness-gated for legacy or invalid documents;
packaged physical two-install interaction remains a separate environment check.

`ScenarioReferenceNode.test.tsx` is the P-05 headless gate. It requires strict stable-ID JSON
round-trip, rejects missing identity, proves rename-safe live label resolution, and converges the
reference across two Yjs-bound editors. `editorAutomation.test.ts` separately proves that the
`[scenario:<stable-id>]` MCP/checkpoint marker reconstructs a semantic node and reports its ID.
`ScenarioSpotlightNode.test.ts` is the P-06 gate: stable-ID-only JSON, embed-to-link undo/redo,
and two-editor Yjs embed/collapse convergence. The semantic editor suite requires exact
`[spotlight:<stable-id>]` round-trip and rejects copied spotlight text; policy-version and restore
fixtures retain the stable spotlight identity. Vitest discovery explicitly includes both
`.test.ts` and `.test.tsx`; the repository audit fails if either extension is dropped. The
production TypeScript/Vite build is part of the same gate. Packaged pointer insertion and the
physical two-install LAN/Drive run remain separate environment checks.

`scenarioResponseModel.test.ts` and `ScenarioResponseWorkspace.ui.test.tsx` are the P-07
domain/product gates. They prove immutable author/display-name snapshots, exact-parent human edits,
model provider/model/run provenance, replay safety, stale zero-write rejection, hostile-history
write denial, pre-provider generation denial, two-peer concurrent sibling retention, deterministic
convergence, manual no-AI authoring, accessible stale-draft recovery, and bounded response/lineage rendering.
`ScenarioGenerator.ui.test.tsx` proves the provider controls host the shared editor rather than a
second response store. Run those files together with `ScenarioWorkspace.ui.test.ts`; the
production TypeScript/Vite build and repository audit are mandatory. These gates do not prove
authenticated identity, trusted clocks, packaged two-client interaction, or near-limit latency.

`scenarioGeneration.test.ts`, `scenarioGenerationRuntime.test.ts`, and
`ScenarioGenerator.ui.test.tsx` are the P-16 gates. They require a detached, selected-scenario-only
snapshot; 240,000-character context and 500,000-character output ceilings; route/run/model binding;
hostile-envelope rejection before mutation; exact-source revision checking at commit; separate
concurrent variants; local-disabled refusal; fake local streaming; native-approved remote task
construction; cancellation routing; and honest local/API/manual UI copy. The existing response-domain
gate must accept common provider model route names without using them as storage keys. This proves the
provider contract and product wiring, not a live paid-provider call, generated-response editing,
model quality, or packaged interaction. Evidence: `docs/audits/runs/SCENARIO-GENERATION-2026-07-18.json`.

`scenarioRegeneration.test.ts` is the P-17 gate. It requires exact-current parent binding, retained
root/child content and provenance, stale-response zero-write rejection, cross-scenario parent denial,
and two-peer concurrent sibling retention with deterministic convergence. The runtime test proves
the prior variant crosses both local and remote adapter context, and the UI test requires a visible
**Regenerate** action plus collapsed parent-attributed lineage. It does not prove arbitrary historical-
parent selection, human sibling-conflict resolution, a live provider, or quality improvement.
Evidence: `docs/audits/runs/SCENARIO-REGENERATION-2026-07-18.json`.

`heuristicExampleModel.test.ts`, `HeuristicWorkspace.ui.test.tsx`, and
`heuristicExampleInspection.test.ts` are the P-18 gates. They require disconnected positive and
negative additions to converge across duplicate/reversed delivery, exact-parent concurrent removals
to retain attribution and history, exact replay to be idempotent, reused identities/root collisions/
hostile records to fail closed, and oversized or control-byte bodies to leave shared state unchanged.
The UI gate requires engine-free collaborative copy, explicit polarity/removal controls, attribution,
and accessible loading/error states. The inspection canary proves MCP counts and integrity omit both
example bodies and participant display names. These tests do not prove authenticated identity,
packaged two-install interaction, semantic example quality, or an evaluation engine. Evidence:
`docs/audits/runs/HEURISTIC-EXAMPLES-2026-07-19.json`.

`suggestionModel.test.ts` and `nodes/SuggestionNode.test.tsx` are the P-08 domain/editor gates.
They prove attributed human/model proposals, exact-proposal decisions, replay and stale rejection,
disconnected opposite-decision retention, explicit conflict projection, proposal-root collision
failure, stable-ID-only JSON/Yjs projection, and pending/decided/missing UI states. The semantic
editor and immutable-version fixtures require exact `[suggestion:<stable-id>]` round-trip and
reject copied proposal content or duplicate IDs. `researchStateInspection.test.ts` proves MCP
inspection exposes bounded provenance/status metadata while omitting proposal and decision bodies.
Those P-08 gates do not make a decision mutate policy text. `suggestionApplication.test.ts` and
`suggestionApplicationIntegration.test.ts` are the separate P-24 gates. They require a deterministic
policy-content fingerprint that excludes suggestion markers, exact accepted proposal/decision and
live-editor revision guards, stale-source zero-write rejection, one-marker and policy-ID collision
checks, a simulated read/replace race stopped by the controller, and a real Lexical replacement into
one stable `review` policy node. `SuggestionNode.test.tsx` requires a distinct **Apply to draft**
action and unchanged-content copy. This does not prove authenticated identity, packaged two-install
interaction, an MCP application route, or semantic correctness of the proposed policy. Evidence:
`docs/audits/runs/SUGGESTION-APPLICATION-2026-07-19.json`.

`presenceModel.test.ts`, `presenceRegistry.test.ts`, `deviceIdentity.test.ts`,
`signedPresencePublisher.test.ts`, `memoryProvider.presence.test.ts`, and
`ResearchPresence.ui.test.tsx` are the P-11 gates.
They require a 200-state hostile-input bound, schema-versioned researcher identity, content-free
projection, identity-safe provider replacement, two-client live awareness, immediate disconnect
cleanup, reconnect tombstones, and honest local/Drive/live copy. The editor must pass the migrated
installation identity to Lexical instead of a fixed username. Schema v2 additionally requires an
exact Ed25519 proof parser, project/document/participant/awareness-client/session binding, invalid
signature states, legacy unsigned compatibility, one native signing call per live provider session,
restoration after Lexical focus/blur republishes its original awareness data, an all-signed-field
verification cache key, and 200-pending/400-cache-entry bounds. Run
`npm run test:collaboration:identity` to build the exact Rust harness under a 120-second deadline and
verify the same generated installation key signs the canonical ephemeral-presence and durable
project-registration domains, with four presence and two registration claim mutations rejected by
Node WebCrypto; the proof output must contain no private-material field. The native
`collaboration_device_trust` tests additionally
require exact-state approve/revoke/re-approve transitions, per-project isolation, corrupt-primary
fail-closed behavior, missing-primary recovery, primary precedence, canonical key IDs, and unchanged
saved bytes after 64-device or 64-project bound rejection. `ResearchPresence.ui.test.tsx` requires
the short fingerprint, local-only approval/revocation labels and controls, and explicit copy denying
relay authorization. Only one UI trust mutation may be in flight. `presenceResearchInspection.test.ts`
requires MCP to expose only transport mode and session/integrity counts. This is provider-neutral
and product-visible evidence, but the local app-data registry is a user preference, not a signed
project record or access-control boundary. The managed relay separately supports explicit
operator enrollment and signed installation-key-to-role authorization. This does not prove human
identity, shared-directory approval, propagated identity revocation, presence-proof replay prevention, key
rotation/recovery, durable event signatures, a physical two-install cursor run, or the Phase 5
five-client soak.

`projectDeviceDirectory.test.ts` is the durable registration gate. It requires explicit strict
Ed25519 project/participant registration proofs, idempotent publish, disconnected merge convergence,
offline full-state reopen, cross-project and participant-mutation rejection, exact storage-key
binding, visible same-key participant conflicts, 200-registration and 1,000-settings fail-closed
bounds, and no write into a poisoned directory. Signature verification runs in batches of at most
eight. `ResearchPresence.ui.test.tsx` requires explicit registration, stable-fingerprint correlation
copy, offline local approval controls, conflict/integrity warnings, and no directory surface in a
local-only project. `researchStateInspection.test.ts` proves the existing read-only MCP route returns
only bounded public device metadata and omits hostile record bodies. This does not prove that a
registration is append-only against a bearer peer, trusted enrollment, identity, role, shared
approval/revocation, relay authorization, or a signed durable research event.

The same suite includes `heuristicsModel.test.ts`. Forty seeded delivery orders prove concurrent
field edits retain both values and attribution events, and another forty prove concurrent additions
plus delete-versus-edit converge without resurrection. Invalid identity and conflicting edit-ID
replay fail locally; peer-specific internal keys retain disconnected collisions so merged reads
fail closed instead of silently choosing one event. This is the P-04 domain contract; it does not prove a
heuristics UI, evaluation workflow, presence, or remote collaboration transport.

The suite also includes `policyVersionModel.test.ts`. It requires canonical semantic-block
snapshots, SHA-256 address verification on every read, idempotent identical saves, detached
projections, parent validation, historical display-name attribution, and forty reordered/duplicate
delivery checks for independently created branches. Direct record tampering must fail closed. This
proves the P-23/P-27 domain layer. `PolicyVersionRail.ui.test.ts` adds a server-rendered product
contract for the save form, current-head metadata, selected checkpoint, deterministic change note,
bounded changed-block list, and two-step restore confirmation. `versionAutomation.test.ts` proves
the exact editor-revision plus exact-head save path, one-transaction restore, rollback after a
partial synthetic editor failure, and stale-input zero-mutation behavior.
`versionRestoreIntegration.test.ts` binds real pinned Lexical/Yjs editors across the Memory
provider and proves the restored root, immutable record, and head reach the peer in one Yjs update;
the final peer Lexical projection is asserted separately. Packaged pointer interaction and
Drive/WebSocket transport remain separate gates.

`scenarioModel.test.ts` is the P-14/P-15 domain gate. It covers lifecycle CRUD, ordered multi-turn
round-trip, attributed immutable turn revisions, exact-current conflict refusal, exact-retry
idempotence, branch lineage, independent concurrent field and turn additions, delete-versus-nested-
edit, peer-colliding public scenario/turn IDs, exact record shapes, malformed order, and missing-
parent inspection. It also requires a durable selected head, the complete derived sibling-tip set,
zero-write rejection of stale or incomplete reconciliation, an all-parent merge revision, and
conflict reopening when a late sibling arrives. Eighty seeded duplicate/reordered delivery checks
must converge.
`ScenarioWorkspace.ui.test.ts` covers the engine-free gallery shell. The product-level
`ScenarioTurnWorkspace.ui.test.tsx` gate proves manual no-AI add/edit, immutable attribution, stale
zero-write recovery with the draft retained, hostile-state write refusal, deterministic disconnected
sibling convergence, Save denial when a sibling arrives under an already-open editor without moving
the selected head, visible conflict controls, explicit all-parent reconciliation, accessible
empty/identity copy, and 50-item conversation/lineage bounds. `migrations.test.ts`,
`localProvider.test.ts`, `driveProjectProvider.test.ts`, and `scenarioArchiveGraph.test.ts` prove
strict zero-write v1 preflight, deterministic/idempotent migration, disconnected convergence,
IndexedDB reopen, migration after the initial Drive pull with v2 republish, and archive migration
before persistence fingerprinting. These headless gates do not prove authenticated identity or
time, packaged pointer/focus/screen-reader behavior, a physical two-install reconciliation, or
near-limit latency.

`scenarioVoteModel.test.ts` is the P-19 domain gate. It covers exact replay idempotency, attributed
re-voting, abstention, withdrawal without history erasure, disconnected first-vote merge,
concurrent same-participant re-votes, conflicting event identities, malformed buckets, namespace
isolation, and orphan scenario targets. Eighty seeded duplicate/reordered deliveries must converge.
This proves a shared vote ledger, not authenticated identity, a trusted distributed clock,
moderation, flags/notes UI, or remote transport.

`scenarioAnnotationModel.test.ts` is the P-20 domain gate. It covers note editing, turn-scoped
flags, resolve/reopen attribution, exact-current revision guards, replay idempotency, disconnected
first annotations, concurrent edit-versus-resolve branches, public-ID collision, namespace
isolation, and missing scenario/turn targets. Eighty seeded duplicate/reordered deliveries must
converge. This proves the lifecycle ledger, not its UI, authentication, moderation, or transport.

`scenarioLabelModel.test.ts` is the P-21 domain gate. It covers label create/rename, scenario
add/remove/filter, exact-current event guards, immutable history, disconnected assignments,
concurrent rename branches, public-ID collisions, and orphan targets. Eighty seeded duplicate/
reordered deliveries must converge. This proves the context-label domain, not its UI,
authentication, moderation, or remote transport.

`policyVersionHistory.test.ts` extends that gate for P-28/P-29. It rejects stale expected heads
before creating a version, restores an old snapshot only by creating a new child of the current
head, retains both concurrent restore branches across forty reordered/duplicate deliveries, and
produces the same structured diff/count note on repeated runs with no model dependency. The product
restore adds exact live-editor/head guards, semantic-block replacement without markup
reinterpretation, rollback inside the transaction, a two-step accessible rail contract, and a
two-peer one-update integration fixture. This does not prove Drive/WebSocket transport, packaged
pointer/focus behavior, crash injection at the IndexedDB durability boundary, or the semantic
usefulness of every diff. Export also remains open.

## Headless explainable-heuristic proof

Run the P-26 contract, runtime, collaborative-state, UI, and content-free inspection gates without
a model, API key, network, or webview:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm test -- --run src/workspace/heuristicCheck.test.ts src/workspace/heuristicCheckRuntime.test.ts src/workspace/heuristicCheckResultModel.test.ts src/workspace/HeuristicChecker.test.tsx src/workspace/researchStateInspection.test.ts
```

The gates require exact bounded input snapshots; route-bound strict output; mandatory rationale and
uncertainty; exact sorted citation spans; cancellation; one malformed-output repair; local-AI-off
behavior; native remote task construction; immutable replay-safe peer convergence; policy/heuristic/
example stale-write rejection; product-visible provenance; and MCP-safe counts with body canaries.
They use injected fake providers and do not prove live-provider behavior, answer quality, authenticated
identity, or packaged two-install interaction.

## Headless versioned scenario-rerun proof

Run the P-30 contract, route adapters, persistent queue, supervised runner, product copy, and
content-free MCP inspection without a model, key, network, webview, or manual queue operation:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm test -- --run src/workspace/scenarioEvaluation.test.ts src/workspace/scenarioEvaluationRuntime.test.ts src/workspace/scenarioRerunQueue.test.ts src/workspace/scenarioRerunRunner.test.ts src/workspace/ScenarioRerunQueuePanel.ui.test.tsx src/workspace/ScenarioWorkspace.ui.test.ts src/workspace/researchStateInspection.test.ts
```

The gates require exact immutable policy/scenario binding; unique bounded job/run/result identities;
creator-only exact-parent controls; durable begin-before-send; atomic result/completion; single-item
execution; 30-second progress heartbeats; two-minute item deadlines; pause/cancel/retry; crash reopen;
completed-item deduplication; local-off behavior; native remote task construction; injection-shaped
output rejection; product-visible provenance; and MCP-safe counts with body canaries. Injected
providers do not prove live-provider quality, authenticated identity, packaged two-install
convergence, or crash durability below the Yjs update boundary.

## Headless stable scenario-comparison proof

Run the P-31 deterministic comparison, public schema, adversarial decoder, product copy, and
content-free MCP-count gates without a model, key, network, webview, or manual file selection:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm test -- --run src/workspace/scenarioComparison.test.ts src/workspace/ScenarioComparisonPanel.ui.test.tsx src/workspace/ScenarioRerunQueuePanel.ui.test.tsx src/workspace/researchStateInspection.test.ts
```

The gates complete two real persistent P-30 jobs against verified immutable policy versions, prove
canonical byte-stable derivation, strict Draft 2020-12 alignment, JSON round-trip, exact policy and
scenario checksums, neutral nine-cell transition counts, same-input guards, ambient-field and
tampering denial, explicit export disclosure, and body-free compatible-pair inspection. They do not
prove model quality, causality, authenticated identity, live-provider determinism, or packaged OS
Save-dialog behavior.

## Headless portable scenario-pack proof

Run P-33's lossless import/export, public-schema, committed-sample, adversarial decoder, collision,
and product-copy gates without a model, key, network, webview, or manual file selection:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm test -- --run src/workspace/scenarioPack.test.ts src/workspace/scenarioPackSchema.test.ts src/workspace/ScenarioPackControls.ui.test.tsx src/workspace/ScenarioWorkspace.ui.test.ts
```

The gates require automatic ancestor closure, canonical SHA-256 verification, strict Draft 2020-12
v2 alignment with durable heads and parent sets, deterministic checksummed-v1 migration, full
ordered turn/revision/edit attribution round-trip into a different project, exact-
duplicate idempotency, whole-import refusal on any same-ID/different-content collision, and explicit
included/excluded-data copy. The sample at `docs/samples/source-review.syzygy-scenarios.json` is CC0
and must pass both the public schema and runtime decoder. Rust platform-contract tests prove the same
current v2 schema is returned by `syzygy_platform_contracts`. These gates do not prove authenticated identity,
trusted clocks, semantic quality, packaged OS file dialogs, or third-party reader interoperability.

## Headless live-MCP contract proof

Run the embedded MCP protocol, loopback-security, and live-editor mutation contracts without
opening a GUI:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:mcp
# interrogate an already-built packaged executable without launching its GUI
node ..\scripts\mcp-harness.mjs --executable <absolute-Syzygy.exe>
```

The harness compiles the real application binary, starts `app --mcp` over stdio, negotiates MCP
`2025-11-25`, discovers all thirty-nine tools, checks notification framing and ping, calls a typed live
status result, then calls `syzygy_installation` without a GUI. That self-description must contain
absolute executable/install-folder paths plus configuration and a connection prompt derived from
the executable. Separate frontend tests prove structured Lexical reads, replace/append behavior,
and stale-revision rejection; Rust tests prove authenticated loopback parsing, browser-origin
rejection, and correct JSON/TOML generation for executable paths with spaces. See `MCP.md` for the
security and tool contract.

The live collaboration document registry and `researchStateInspection.test.ts` add a content-
minimized MCP self-check. It validates every scenario/heuristic record, scenario branch/vote graph,
version hash/schema, project identity, head, and full bounded version ancestor chain, while
returning at most 200 metadata summaries per collection and omitting policy text, scenario
background/turn/revision/voter bodies, heuristic guidance/edit values, and notes. Rust tests require `inspect_research_state` to route only to this content-minimized read operation. The mutation-capable
live harness checks it when explicitly run; CI does not claim a packaged GUI proof.

`scenarioAutomation.test.ts` is the MCP scenario read/mutation gate. Inspection returns a monotonic
Yjs state-vector revision and rejects an internally inconsistent read if state changes during its
asynchronous hash checks. Creation requires that exact revision, rechecks project identity, and
mutates the registered live Y.Doc synchronously. `read_scenario` validates exact project/graph/
scenario identity and returns one detached background plus at most 1,000 ordered turn identities,
roles, revision counts, selected heads, complete tip sets, and conflict state without turn bodies.
`read_scenario_turn_revision` then
returns one detached current, named, or zero-based indexed body. Both reads leave the Y.Doc byte-
identical. Add-turn and revise-turn require the revision from inspection or the immediately preceding
mutation; revisions retain both authors and bodies. Ordinary revision is blocked when more than one
tip exists. `reconcile_scenario_turn` requires the exact current research revision, selected head,
and complete tip set, then appends one attributed merge revision with every sibling as a parent.
Stale and incomplete reconciliation tests prove zero scenario/turn writes. Rust
routing and the packaged live harness cover each named scenario read/mutation tool; the live harness
proves the scenario-index-to-indexed-revision traversal chain. The voting
gate chains support, re-vote, and withdrawal events, then proves a stale call adds no vote event;
MCP output exposes aggregate counts, not voter bodies. The annotation gate chains create, edit,
resolve, and reopen under both project-research and exact-current-event guards, then proves both
conflict classes add no lifecycle event. MCP output and inspection omit every annotation body. The
label gate chains create, rename, assign, and remove; rename/follow-up assignment require both
research and exact-current-event guards, and both stale conflict classes add no event. This grants
one explicit bounded scenario-content read plus direct scenario editing, attributed voting,
annotation lifecycle, and shared-label mutation—not model generation or authenticated identity.

`versionAutomation.test.ts` adds the MCP checkpoint mutation gate. It proves semantic editor blocks
become one immutable head, a stale document revision fails before hashing, a document revision that
changes during hashing fails inside the final head transaction without inserting a version, and a
stale version head fails before mutation. The Rust tool route and compiled stdio discovery are
separate gates. This grants checkpoint creation only—not document editing, restore, or identity
authentication.
`restore_active_policy_version` reuses the same product restore transaction. It requires an
inspected target version, the exact latest document revision, and the exact current non-null head.
The target semantic blocks become the live draft and a new immutable child of the current head in
one guarded Yjs transaction; history is never rewritten. The transaction rolls draft/head back if
editor replacement throws. The extended `--write-proof` live harness creates a checkpoint, creates
and checkpoints a temporary divergence, restores the earlier checkpoint, reads the live document
back exactly, and verifies the new head and bounded integrity state. Separate stale-document and
stale-head calls must both fail without adding a version. This is a packaged single-profile proof,
not authenticated identity, Drive/WebSocket convergence, crash durability, or two-install
evidence.

The packaged UI exposes the same Rust-generated values under **Settings → Connect an LLM → MCP
setup guide**. Do not hard-code an installer location in React or documentation; installed paths
vary by OS, installer choice, and portable/dev execution.

## Headless LAN MCP control-plane proof

Run the LAN suites through the bounded-command watchdog. No command may exceed a one-minute
heartbeat interval:

```powershell
cd D:\PolicyPad\syzygy
node scripts\run-with-heartbeat.mjs --timeout-seconds 60 --heartbeat-seconds 15 -- node --test scripts\lan-bridge.test.mjs
node scripts\run-with-heartbeat.mjs --timeout-seconds 60 --heartbeat-seconds 15 -- node --test scripts\lan-agent-supervisor.test.mjs
node scripts\run-with-heartbeat.mjs --timeout-seconds 60 --heartbeat-seconds 15 -- node --test scripts\lan-dev-mode.test.mjs
node scripts\run-with-heartbeat.mjs --timeout-seconds 90 --heartbeat-seconds 15 -- node scripts\lan-mcp-harness.mjs
node scripts\run-with-heartbeat.mjs --timeout-seconds 90 --heartbeat-seconds 15 -- node scripts\lan-packaged-agent-harness.mjs
node scripts\run-with-heartbeat.mjs --timeout-seconds 120 --heartbeat-seconds 30 -- node scripts\lan-drive-live-harness.mjs --listen 192.168.1.20 --port 37663 --key-file "$env:USERPROFILE\.syzygy-lan.key" --local-executable "$env:LOCALAPPDATA\Syzygy\Syzygy.exe" --primary-node office-primary --secondary-node office-secondary --mutate
```

The unit suite proves pairing-key/node/nonce binding, directional session keys, authenticated
AES-GCM framing, replay and tamper rejection, bounded node identities, and the one-minute request
ceiling. The two-node harness proves discovery, read-only fleet probing, independent per-node
mutation routing, invalid-key rejection, and disconnect cleanup. It reserves agent and control
ports independently, waits for both listeners, synchronizes owned-child exit before asserting
disconnect, and surfaces termination failures instead of discarding `taskkill` results. The packaged harness is the
cross-language gate: compiled Rust `Syzygy --lan-agent` must authenticate to the Node coordinator,
discover at least twenty-five native tools, and return exact installation self-description through
the encrypted route. `docs/audits/runs/LAN-MCP-CONTROL-PLANE-2026-07-16.json` records the evidence
and explicitly does not claim two-physical-machine or project-convergence proof.

The supervisor suite proves that the host restarts a stopped local packaged agent with bounded
backoff and stops it cleanly. The developer-mode lifecycle suite starts both coordinator listeners,
rejects the wrong pairing key, authenticates the loopback MCP attachment, negotiates/list tools, closes
the app-owned input, and proves the coordinator, attachment process, private listener, and control
listener all exit within bounded deadlines. Rust and server-rendered UI tests separately cover saved
agent/host configuration, private-address/key-path validation, startup order, disable/reconfigure
replacement, graceful two-second shutdown, kill-and-reap fallback, and shutdown order. The physical
harness requires two exact node labels and all thirty-seven native tools on each installation. Its
default mode performs only catalog/identity checks; `--mutate` uses a dedicated proof project, exact
revisions, guarded share/join, partition-like concurrent document appends, bidirectional readback,
and stale-write rejection. It also creates one scenario turn, makes simultaneous revisions, reads
both exact sibling bodies from both nodes, requires the same selected head and complete two-tip set,
calls explicit all-parent reconciliation, requires the four-revision merged head on both nodes, and
rejects a stale follow-up write. It prints content-free booleans and counts and has its own 15-second
heartbeat and two-minute absolute deadline in addition to the outer watchdog. A passing
synthetic or single-profile test never substitutes for this two-installed-profile gate.

## Headless remote-provider boundary proof

Run the remote-provider transport checks without a real API key or internet access:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:providers
```

The fake loopback provider captures the actual Rust HTTP request and fails unless OpenAI Responses
uses the expected path, bearer header, `store:false`, bounded output, and approved disclosure. It
also proves malformed output, unsafe non-TLS endpoints, rejected disclosure, provider error-body
redaction, a bounded whole-request deadline (including a body stalled after headers), and idempotent
in-flight cancellation. The same fake server sends a real `text/event-stream` response in separated
TCP writes; the transport checks `stream:true`/`store:false`, normalizes events incrementally,
enforces terminal order and a total-byte ceiling, distinguishes sanitized provider failure, and
cancels between dispatched events. Passing this is request/stream/control conformance, not live
availability; streamed product delivery and an opt-in live canary are separate gates.

The same command certifies the Anthropic Messages one-shot and streaming boundary. Its fake server checks
`POST /v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`, developer-to-system and user-to-
message mapping, `max_tokens`, bounded `input_schema` tool definitions, and one-shot `stream:false`. Its SSE fixture separately checks
`stream:true`, the event-stream media type, message/content lifecycle, cumulative usage, terminal
order, fragmented delivery, sanitized errors/warnings, and omission of private thinking bodies.
`npm run test:provider-runtime` also routes that stream through the product task accumulator and
proves secrets, prompts, categories, and private-thinking canaries stay out of serialized outcomes.
Fragmented `input_json_delta` tool arguments normalize into bounded non-executing proposals and
malformed or unfinished calls fail closed. This does not prove tool execution/result continuation,
a live credential/provider, or packaged native-dialog interaction.

It also certifies the stable-v1 Gemini Interactions one-shot and streaming boundary. Fake servers check
`POST /v1/interactions`, `x-goog-api-key`, `store:false`, `background:false`, `stream:false`,
`thinking_summaries:none`, system/user mapping, bounded function definitions, output bounds, aggregate
usage consistency, sanitized failures, timeout, and cancellation. The SSE fixture separately checks
`stream:true`, `Accept:text/event-stream`, indexed step lifecycle, initial and delta text, final
usage/status/`[DONE]`, fragmented delivery, omission of thought/signature bodies, and normalization
of complete function-call steps into the common non-executing proposal lifecycle. The test
rejects `/v1beta` instead of silently drifting API versions. The runtime suite routes the same stream
through the product accumulator and excludes secret, prompt, category, and thought canaries from
serialized outcomes. Tool execution/result continuation, thought-signature continuation, a live credential,
and packaged native-dialog interaction remain open.

The xAI Responses one-shot and SSE boundaries use the Responses shape without assuming OpenAI's
privacy semantics. Fake servers check bearer auth, `store:false`, no previous-response/cache
identifier, bounded normalization, timeout/cancellation, `stream:true` plus event-stream media
negotiation, and a mandatory boolean `x-zero-data-retention` response header. The stream rejects a
missing or non-boolean header before dispatching any event and preserves the attestation in the
authoritative content-free run record. Whole custom function-call chunks normalize into bounded
non-executing proposals. Tool execution/result continuation, encrypted reasoning continuation, WebSocket mode, live policy/rate/
cost behavior, packaged native-dialog interaction, and live proof remain open.

`npm run test:provider-runtime` proves the next internal boundary: a typed task retrieves a key
from an injected vault, executes through the existing provider transport, normalizes the result,
and authors a content-free provider-run record. The fixture fails if the secret, prompt, or content
category appears in serialized output. A disclosure denial is recorded without contacting the
network or reading the credential vault. Credential set/status/delete and one-shot
generation/cancellation are registered through typed `tauri.ts` wrappers. The generation command
uses Rust's native dialog with explicit **Send once** / **Cancel** buttons; there is no
caller-supplied approval field. The pure disclosure-copy test is headless, while actually clicking
the OS dialog remains a packaged-GUI check.
The workspace single-review panel is now the first product caller: its pure envelope tests bind the
current semantic draft to a SHA-256 source identity, retain editable provider/model/question fields,
and cannot supply approval, categories, provenance, or credentials. Result text remains transient
and does not mutate the shared draft. Live-key execution and UI interaction remain separate gates.
The command also does not accept free-form disclosure categories or a detached source-ID list.
`ProviderResearchTaskRequest` carries a question, optional task instructions, labeled source
snapshots, and optional bounded custom-function definitions; Rust serializes the actual payload,
derives the categories and unique provenance IDs, includes tool names/descriptions/schemas in the
native disclosure, then validates bounds before opening the native dialog. The workspace displays
normalized calls as inspect-only proposals and has no execution or result-return path. A content-free
output hash binds both response text, proposal bodies, and their validation state while the run
record retains neither body. Definitions outside the depth/node/property/keyword-bounded schema
subset fail before disclosure. Rust validates every complete proposal against the exact approved
definition and authors valid/invalid/missing-definition status; the frontend's pinned AJV 2020
validator independently checks definition preflight and streaming display. Both paths keep domain
review unperformed and execution false.
Evidence and remaining domain/live-provider gaps are recorded in
`docs/audits/runs/PROVIDER-RESEARCH-ENVELOPE-2026-07-15.json`.
The evidence and explicit limitations are recorded in
`docs/audits/runs/NATIVE-PROVIDER-DISCLOSURE-2026-07-15.json`.
The provider-neutral proposal lifecycle, hostile fixtures, limits, authority exclusions, and live
non-claims are recorded in `docs/audits/runs/PROVIDER-TOOL-PROPOSALS-2026-08-11.json`.
The safe-subset keyword/depth/node gates, cross-language valid/invalid/missing-definition fixtures,
bounded diagnostics, and remaining domain/authority non-claims are recorded in
`docs/audits/runs/PROVIDER-TOOL-SCHEMA-VALIDATION-2026-08-11.json`.

Settings now has a collapsed remote-provider key section for OpenAI, Anthropic, Gemini, and xAI.
The component calls only typed status/set/delete wrappers, keeps the key out of React state and all
persisted stores, clears the password field before awaiting the vault write, and never imports the
generation command. `npm run audit` locks those structural properties; a transient DOM/heap canary
and macOS/Linux live-vault checks remain release evidence gaps.
Browser-only Vite previews intentionally show a neutral installed-app status and do not attempt
vault commands; this prevents a missing desktop runtime from masquerading as a credential error.
The structural/build/MCP proof and non-claims are recorded in
`docs/audits/runs/PROVIDER-SETTINGS-2026-07-15.json`.
`npm run test:provider-runtime-interop` closes the record check by running the Rust bridge,
passing its serialized record directly to Vitest, and requiring both public validators to accept
it. The record names its actual literal-loopback destination with `loopback-conformance`; it does
not pretend the fixture contacted a production URL.

`npm run test:contracts` also validates the public content-free provider-run record. It rejects
undisclosed remote transmission, non-HTTPS remote destinations, contradictory retention
attestation, raw prompts/outputs/credentials, invalid terminal state, inconsistent token totals,
and duplicate or malformed provenance. This proves the record and validator; the interop harness
proves internal runtime emission, while product execution remains unavailable.

`npm run test:adversarial` also exercises the injected adversarial phase runner with synthetic
executors. It proves independent proposal/critique phases, evidence audit, reversed-order
judgments, exact compute-matched baseline calls, route/payload separation, cancellation, sanitized
failure, pending human review, and no shared mutation. It does not contact a provider or prove
answer quality. Product execution still requires an executor that consumes the native batch
authorization, binds actual approved task bytes to each reserved call, and has live
benchmark evidence.

The Rust provider-runtime suite also proves the non-executing adversarial batch authorizer. It
rejects mismatched totals, duplicate routes/sources, misleading model labels, and oversized scope;
its disclosure lists route ceilings and policy handling without research text. Denial stores no
authority, approval creates a 30-minute random in-memory capability, status reports only the
bounded scope, and revocation removes it. This is not an authorized model-call test because no
consumer exists yet. The same suite now proves the private reservation boundary: parallel attempts
cannot overspend per-route or total ceilings, call IDs cannot be reused across routes, wrong
run/source/route identity consumes nothing, and expired capability is removed. Reservation has no
public command, credential read, network access, or prompt/content binding.

`npm run test:provider-streams` separately feeds the OpenAI, Anthropic, Gemini, and xAI decoders
fragmented, multiline, unknown, malformed, mismatched, oversized, and truncated SSE fixtures. It
proves parser normalization, provider identity, indexed Gemini step validation, and private-body
omission in isolation. `test:providers` separately proves each
parser is fed through fake HTTP streaming and that the same controls wrap both one-shot and streamed
transport.

Run the explicit OS-store canary only when validating a desktop environment:

```powershell
npm run test:credentials:live
```

It creates a process-unique random credential, proves exact readback, deletes it, and independently
proves it is absent. The value is never printed. This intentionally touches the current user's OS
credential store and is therefore not part of the default headless suite.

## Headless researcher-plugin contract proof

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:plugin-sdk
npm run test:plugin-host
npm run certify:plugin -- ..\examples\plugins\citation-auditor
```

`npm run test:contracts` also checks the published
`docs/wit/syzygy-research-plugin-v1.wit` zero-import world and its bounded invocation/result
validators. The Rust platform-contract suite uses pinned `wit-parser` 0.223.1 to resolve the public
package and prove the world has zero imports and one export. TypeScript proves unknown/ambient
fields, duplicate source identity, unbounded/cyclic payloads,
direct mutation, and malformed proposals fail closed. It does not instantiate WebAssembly; MCP and
the structural audit must continue to report `published-zero-imports-no-runtime` until a real host
passes resource, trap, and denied-import tests.

The first command tests schema rejection, real-path containment, wildcard-domain semantics, and
undeclared-authority denial. The second emits a JSON certification report for the interface-only
example. Neither command executes plugin code; runtime/WASI certification remains a separate gate.
The host test exercises the separate in-process authority broker: explicit grant subsets,
detached bounded snapshots, revision/identity-guarded pending proposals, HTTPS/domain decisions,
model/Drive target decisions, expiry, revocation, and content-free errors. It performs no network,
model, Drive, project mutation, or plugin execution.

## Headless custom model-adapter contract proof

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:model-adapter-sdk
npm run certify:model-adapter -- ..\examples\model-adapters\local-vllm
```

This validates strict adapter/certification schemas, package-contained docs/license/fixtures,
literal-loopback versus HTTPS-remote policy, built-in ID protection, protocol/route agreement, and
exact origin-plus-route endpoint allow/deny probes. It does not execute an adapter, contact vLLM,
validate model features, store a credential, or make the custom provider product-available.

After building the current packaged executable, an explicit live-profile proof can
launch the GUI through MCP, create a visible demonstration project, exercise replace/append and
stale-write rejection, and read it back:

```powershell
npm run test:mcp:live
# packaged binary instead:
node ..\scripts\mcp-live-harness.mjs --write-proof --executable <absolute-Syzygy.exe>
```

This intentionally changes the current user's Syzygy project list, so it is not part of CI.

## Local installer build

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run tauri build
# → src-tauri\target\release\bundle\nsis\Syzygy_<version>_x64-setup.exe
```

Regenerate the committed Syzygy icon set and installer artwork after changing the canonical
mark:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\generate-brand-assets.ps1
```

## Headless Drive-to-model proof

After linking Drive with collaboration access and choosing a workspace, run:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:drive-live
```

The harness uses the normal Rust-owned `google_auth.json` and `drive_workspace.json`, exports the
real native Google file through Drive, retrieves the canary without hard-coding its value, sends
the resulting evidence to the loaded loopback model, and exits nonzero unless the model answer
contains the canary. Credentials/tokens are never printed. A legacy app-file-only grant also
exits nonzero with a precise re-link error.

## Headless Drive write/readback proof

After linking Drive, choosing a workspace, and enabling both the Drive and Google Sheets APIs in
the OAuth client's Cloud project, run:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:drive-write-live
```

The harness creates a temporary native Sheet in the selected workspace, writes a deterministic
20×10 grid, reads all 200 cells back independently, compares them, and trashes the probe. It uses
the normal Rust-owned grant, prints no token or cell content, and exits nonzero if cleanup fails.


## Headless Drive shared-project proof

After linking Drive and choosing a workspace, run the real transport canary:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:drive-project-live
```

The bounded harness uses the normal stored grant and selected workspace. It creates one temporary
project, appends records from two logical writers, independently lists and reads both records, and
trashes the temporary project folder. It prints no token, file ID, or research content and exits
nonzero if cleanup fails. Pair it with `driveProjectProvider.test.ts`: the live canary proves the
Google transport path, while the deterministic frontend fixture proves actual Yjs merge, equal
state vectors after partition/reconnect, and a non-destructive shared-project discovery transition
from an existing active project. The sidebar control must remain available whenever any project is
open. Catalog refreshes cancel after 12 seconds, before the 15-second MCP live bridge budget, and
run at most eight ordered project-detail reads per root. The two-physical-install diagnostic must
additionally prove the secondary can discover and join
an accessible project with no previously selected workspace; the catalog must select the exact parent
folder before the provider starts. The 2026-07-17 v0.1.14 reproduction established the prior failure
mode: the primary reported folder code `L7ybUosw` and one project while the secondary reported
`workspace: null` and zero projects. Neither test alone claims real-time cursors or the unresolved
partitioned structural move-versus-edit case.

The collaboration-entry UI has a separate engine-free headless contract:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm test -- src/components/Sidebar.ui.test.ts src/workspace/DriveProjectControls.ui.test.ts src/workspace/ProjectArchiveControls.ui.test.ts src/workspace/WorkspaceView.ui.test.ts
```

It proves that Drive setup is reachable outside Ask, a local project exposes live sharing, and
portable export/import is labeled as an offline non-syncing copy. It does not prove Google
transport.

## Release (the iteration loop)

1. Land the work; checks green.

2. `npm run bump patch` (syncs package.json, package-lock ×2, tauri.conf.json,
   Cargo.toml, Cargo.lock — all five must stay in lockstep).
3. Commit → `git push origin main` → `git tag vX.Y.Z` → `git push origin vX.Y.Z`.
4. CI (`.github/workflows/release.yml`, tag `v*`) builds Win/macOS/Linux via
   tauri-action, **signs updater artifacts**, publishes the GitHub release including
   `latest.json`.
5. Users: **Settings → ⬆ Updates → Check for updates** → downloads, verifies signature,
   relaunches.

Updater endpoint: `https://github.com/penpro/Syzygy/releases/latest/download/latest.json`.

### Release configuration split

- Base `tauri.conf.json`: `createUpdaterArtifacts: false`, nsis-only — local builds need
  no signing key.
- `tauri.release.conf.json` (CI overlay via `args: --config`): updater artifacts **on**,
  all OS bundle targets.

### Secrets & keys

| Thing | Where | Notes |
|---|---|---|
| Updater signing key | `~/.tauri/syzygy.key` (private, empty password) + repo secret `TAURI_SIGNING_PRIVATE_KEY` | **BACK UP THE KEY FILE.** Lose it → can never sign another update; users must manually reinstall. Pubkey is in `tauri.conf.json`. |
| Google OAuth client | `frontend/.env.local` (gitignored) + repo secrets `VITE_GOOGLE_OAUTH_CLIENT_ID` / `VITE_GOOGLE_OAUTH_CLIENT_SECRET` | Injected at build time (`import.meta.env`). **Never commit them** — GitHub push protection will (correctly) block the push. They do ship inside the binary; Google documents Desktop-client creds as non-confidential. |

## Gotchas (every one of these burned us once)

| Symptom | Cause → fix |
|---|---|
| `fetch-engine` fails: `tar: Cannot connect to C:` | Git Bash's MSYS tar misparses `C:\` paths → run from **PowerShell** (uses Windows tar). |
| Build fails: `failed to rename app binary … Access is denied` | **Syzygy.exe is running** (locks target\release binary). Close the app; check `tasklist | findstr Syzygy` for zombies. |
| Frontend change builds "successfully" but the exe shows the **old UI** | Tauri embeds `dist/` at Rust-compile time; with no Rust edits cargo used to skip re-embedding. Fixed permanently by `build.rs`: `cargo:rerun-if-changed=../dist`. If it ever recurs: `touch src-tauri/src/lib.rs` and rebuild — and confirm `Compiling app` appears in the build log. |
| Push rejected: `GH013 … Push cannot contain secrets` | OAuth creds in source. `git reset --soft HEAD~1`, move them to `.env.local` / Actions secrets, re-commit. Never "allow" the secret through. |
| `npm run bump` reports a file didn't contain the old version | Version files drifted out of lockstep — fix the odd one by hand, keep all five identical. |
| Windows says "protected your PC" on the installer | Unsigned (no code-signing cert — separate thing from updater signing). More info → Run anyway. |
| "Check for updates" says up-to-date — or errors `None of the fallback platforms … found` — right after tagging | The CI matrix uploads `latest.json` **per-OS as each job finishes** (Windows is slowest). Fixed structurally: releases are created as **drafts** and a final `publish` job flips them live only after all three OS jobs upload — so the feed is always complete. If you ever see it again, the publish job failed; check the run. |

## Diagnostic log

`src/log.ts` — persistent in-app ring buffer (Settings → 📜 View log, localStorage key
`syzygy-diagnostic-log-v1`, newest 500 entries). Every backend command
failure is captured automatically by the `invoke` wrapper in `tauri.ts` (command name +
error only — never prompts/file contents/tokens), plus uncaught errors and unhandled
rejections; consecutive repeats collapse to `×N`. Drive logs restored/linked/disconnected state,
workspace discovery/selection, sync summaries, and high-level failure phase without file contents or
tokens. Entries survive app restarts until **Clear**. First stop for any user-reported failure:
**Copy all**.

## Conventions

- Components never import `invoke` — add a typed wrapper in `tauri.ts`.
- No hard-coded colors — theme tokens only (`docs/DESIGN.md`).
- Save-shape changes go through `migrations.ts` with idempotent backfills.
- Copy follows the local-first voice rules (`docs/DESIGN.md → Voice`).
- Commit messages: what + why, wrapped ~72 cols.

## Headless network-boundary proof

Run S-06 without a model, API key, live network request, webview, or manual inspection:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:network-boundaries
node ..\scripts\network-boundary-harness.mjs --write-proof
```

The first command adversarially rejects unknown manifest fields, duplicate boundary IDs, missing copy anchors, and new unclassified production origins. A secret-bearing URL canary proves the output omits credentials, paths, queries, and fragments. The second command refreshes `docs/audits/runs/NETWORK-BOUNDARIES-2026-07-20.json`; review its hashes and origin-only observations before committing. This is a source/copy/destination trace, not an OS packet capture or live-provider certification.

## Headless self-hosted collaboration proof

Run the first non-Drive provider contract without Google, a model, or a webview:

```powershell
cd D:\PolicyPad\syzygy
node scripts\run-with-heartbeat.mjs `
  --timeout-seconds 120 `
  --heartbeat-seconds 30 `
  -- npm --prefix frontend run test:collaboration:websocket
```

The harness starts the exact test-only `@y/websocket-server@0.1.1` relay on loopback. Its raw protocol
clients prove bidirectional document/awareness propagation, relay termination/restart, partition
convergence, and stale-awareness removal. A separately supervised Vitest child then exercises the
product manifest and bearer-invitation codec, two real `WebsocketProjectProvider` instances with
separate IndexedDB stores, process-level relay exchange, destroy/recreate of one logical client, local
reopen, and return synchronization. The child has a 30-second deadline and the outer harness still
reaps the relay in `finally`. The result explicitly reports that the basic relay retained no document
state. This proves a synthetic same-computer product flow, not authenticated identity, a bundled
relay, relay persistence/backups, five-client soak, physical two-install use, or packaged CSP/network
behavior.

Build and exercise the exact bundled Rust relay separately:

```powershell
cd D:\PolicyPad\syzygy\frontend
node ..\scripts\run-with-heartbeat.mjs `
  --timeout-seconds 120 `
  --heartbeat-seconds 30 `
  -- cargo build --manifest-path src-tauri\Cargo.toml --bin collaboration-relay

cd D:\PolicyPad\syzygy
node scripts\run-with-heartbeat.mjs `
  --timeout-seconds 120 `
  --heartbeat-seconds 30 `
  -- node scripts\bundled-collaboration-relay-harness.mjs `
    --relay-executable frontend\src-tauri\target\debug\collaboration-relay.exe
```

The second harness starts the same relay server used by the installed executable, proves legacy
two-client convergence, exits every source client, gracefully stops/restarts the process, and
recovers the document into a new empty client. It then writes the exact digest-only membership
registry, proves missing/wrong credentials receive no protected frame, admin/editor convergence,
viewer read and awareness, viewer write rejection before broadcast/persistence, revocation after
restart, operator-clock expiry denial, exact-revision capability rotation with old-token denial and
retained-state recovery, managed v3 expiring invitation/provider/IndexedDB reopen, managed-v2
backward compatibility, and legacy-room compatibility beside protected rooms. It also generates
real Ed25519 installation keys, stores only their public enrollment, proves missing/stale/replayed
signed connection claims receive no protected frame, and runs the actual v4 invitation/provider/
IndexedDB-reopen flow with a fresh signature for every physical connection. Awareness is not
persisted and the listener is reusable after shutdown. Rust unit tests cover strict registry
recovery/bounds/revisions, five-minute-to-one-year expiry limits, rotation generation/digest-only
storage, validated device enrollment, typed signature field binding, private binding, secret-free child arguments,
protocol message classes, damaged-header denial, and partial-tail repair. This does not prove
authenticated humans, shared/remote membership administration, trusted time, replacement-invitation
delivery, public TLS/WSS, backup restoration,
hostile-frame fuzzing, physical packaged clients, or five-client soak.

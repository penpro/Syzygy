# Syzygy end-goal delivery plan

> Canonical plan for turning Syzygy into a free, local-first collaborative research
> workspace that independently delivers an inclusive collaborative research workflow. It is
> written as an auditable argument:
> important claims require a source, an acceptance test, or an explicit `UNKNOWN` marker.

**Baseline:** 2026-07-14
**Status:** proposed implementation plan
**Short history/summary:** `ROADMAP.md`

## 1. Definition of done

A research team can, without buying an editor service, database service, LLM API, or
Syzygy-hosted
infrastructure:

1. create, join, export, import, and recover a research project;
2. collaboratively edit a rich policy/research document with conflict-free offline merge;
3. see collaborators and cursors when using an explicitly real-time transport;
4. create, branch, label, discuss, flag, vote on, and test conversation scenarios;
5. compare responses across policy versions and spotlight scenarios inside the document;
6. generate and accept/reject policy suggestions from positive/negative examples;
7. define heuristics and run explainable checks against the current policy;
8. save immutable, attributed versions with deterministic diffs and optional AI notes;
9. use the bundled local llama.cpp model for every AI workflow by default;
10. use Google Drive without requiring every collaborator to mirror a large folder; and
11. independently reproduce product claims from committed tests and audit evidence.

The capability ledger below is Syzygy's independently written product contract. Other products
demonstrate the problem space, but they are not implementation, design, prompt, or schema sources.

## 2. Non-negotiable constraints

- Bundled loopback-only llama.cpp is the default AI path. Cloud AI is optional and explicit.
- No Tiptap package/service/code, PolicyPad code/assets/prompts/schemas/fixtures, Firebase,
  mandatory account, or mandatory API key.
- Shipping dependencies must be permissively licensed and recorded in the SBOM.
- OAuth credentials/tokens stay in Rust except for a separately reviewed minimal picker flow.
- `frontend/src/tauri.ts` is the only frontend `invoke` boundary.
- Persisted-shape changes use idempotent migrations.
- Collaboration correctness comes from a CRDT, never filesystem mtimes or last-write-wins.
- No silent conflict resolution, AI mutation, network access, or permission broadening.
- AI results are proposals/evidence until a human accepts them.
- Every milestone closes with executable evidence, not “looks implemented.”

## 3. Independent-source and license gate

Syzygy is a Penumbra-original implementation. PolicyPad and Tiptap repositories are prohibited
implementation inputs: do not copy or translate their code, UI, node definitions, prompts,
schemas, fixtures, assets, or tests. Comparative product descriptions may be used only to ask
whether Syzygy's independently defined research goals are complete.

The baseline editor candidate is **Lexical plus its Yjs binding**, using published packages
under MIT. All Syzygy editor UI, plugins, nodes, commands, schemas, and tests are authored here.
Do not copy Lexical playground/template UI; package use does not imply template reuse.

Before editor work, create `docs/audits/EDITOR-PROVENANCE.md`. Classify every editor file as
`Penumbra original` or an exact-version permissive dependency with source/license evidence.
Generate an SBOM and exact package-license report in CI. Human review is mandatory.

External evidence checked 2026-07-14:

- Lexical repository and capabilities: <https://github.com/facebook/lexical>
- Lexical MIT license: <https://github.com/facebook/lexical/blob/main/LICENSE>
- Lexical Yjs package: <https://www.npmjs.com/package/@lexical/yjs>
- Yjs architecture: <https://docs.yjs.dev/>

Auditor challenge: verify package-level license, source repository, commit/tag, and shipped
source for every locked version; scan for prohibited package names and suspicious source
similarity. Marketing pages do not close the gate.

## 4. Capability ledger

Every row needs evidence in `docs/audits/CAPABILITIES.json` before becoming `verified`.

| ID | Independently defined capability | Syzygy target and decisive check |
|---|---|---|
| P-01 | room/project entry | two clean installs open the same stable project ID |
| P-02 | rich policy editor | fixture round trip preserves every supported node |
| P-03 | policy block | add/edit/reorder/serialize/concurrent-merge test |
| P-04 | heuristics block | concurrent add/edit/delete converges |
| P-05 | scenario chip | linked by ID; rename does not break it |
| P-06 | spotlight scenario | shared, undoable embed/unembed |
| P-07 | editable response | edit stores author and version metadata |
| P-08 | suggestion node | preview/accept/reject; no pre-accept mutation |
| P-09 | formatting | marks, headings, lists, links, code, tables, images fixture |
| P-10 | drag/reorder | pointer and keyboard tests |
| P-11 | cursors/presence | two-client awareness plus disconnect cleanup |
| P-12 | simultaneous editing | randomized partition/reorder/reconnect convergence |
| P-13 | offline editing | independent offline edits merge without text loss |
| P-14 | scenario gallery | CRUD with loading/empty/error states |
| P-15 | multi-turn scenario | durable revision DAG, exact sibling reconciliation, deterministic fixture round trip |
| P-16 | scenario generation | bounded local/API contract, fake streams, stale-source and hostile-output gates |
| P-17 | regeneration | exact-parent variants retained; stale and concurrent sibling gates |
| P-18 | positive/negative examples | attributed add/remove history and disconnected classifications converge |
| P-19 | voting | per-user idempotency and concurrency tests |
| P-20 | flags/notes | author, timestamp, resolve lifecycle |
| P-21 | context labels | add/remove/filter/concurrent rename |
| P-22 | scenario branching | exact parent graph and integrity failures survive persisted offline import |
| P-23 | attribution | display-name change preserves historical identity |
| P-24 | policy suggestion | accepted typed proposal applies only to the exact unchanged draft |
| P-25 | discussion prompt | cancellation/failure and prompt fixture |
| P-26 | heuristics checker | pass/fail/uncertain, rationale, cited spans, retry |
| P-27 | immutable policy version | content hash prevents mutation |
| P-28 | history/restore | restore creates a new head, never rewrites history |
| P-29 | change note | deterministic diff works with engine off |
| P-30 | rerun scenarios | bounded pause/resume/retry job |
| P-31 | baseline comparison | stable side-by-side fixture and export |
| P-32 | diagnostics | research content absent from diagnostic log |
| P-33 | scenario packs | schema-validated import and sample pack |
| P-34 | table of contents | derived from headings, not duplicate truth |
| P-35 | accessibility/themes | keyboard, contrast, reduced motion, all themes |
| S-01 | direct Drive research | collaborator doc cited without mirror |
| S-02 | optional mirror | no bulk download before explicit Sync |
| S-03 | local model setup | first generation on clean install without API key |
| S-04 | portable export | disconnected second machine imports archive |
| S-05 | replaceable transport | same Yjs fixture converges on every provider |
| S-06 | data minimization | network trace matches active feature/copy |
| S-07 | private-LAN multi-install control | two physical installed applications authenticate, remain isolated, and pass bounded routed MCP probes |

P-05 now has an original inline Lexical node and product insertion control. Only the scenario ID is
serialized; the visible title is derived from the shared scenario collection, and missing targets
remain inspectable. Headless JSON, rename, semantic-marker, immutable-reference, and two-editor Yjs
gates pass. Packaged pointer interaction remains open, so the capability is
`implemented_unverified`.

P-06 now has an original block-level Lexical node and product control. It persists only the stable
scenario ID, renders live scenario fields, collapses to the inline link, and preserves the
presentation transition through undo/redo and two-editor Yjs updates. Exact semantic markers and
immutable checkpoint restore are covered headlessly. Packaged two-install pointer interaction
remains open, so the capability is `implemented_unverified`.

P-07 now has an original collaborative response-revision domain and a visible selected-scenario
workspace. Manual no-AI creation and human editing append exact-parent revisions with stable author
and display-name snapshots; model revisions retain provider/model/run provenance. The product keeps
a stale unsaved draft visible, refuses its save before mutation, rechecks hostile history before
manual or provider work, exposes explicit reload, and bounds response/lineage rendering. Disconnected product edits retain sibling
branches and converge deterministically. Authenticated identity, trusted clocks, explicit sibling
resolution, packaged physical two-client interaction, and near-limit performance remain open, so
the capability remains `implemented_unverified`.

P-08 now has an original shared proposal/decision ledger and live stable-ID editor card. Proposals
retain exact source revision plus human/model provenance; decisions retain reviewer attribution and
the exact proposal event. Stale/reused identities fail before mutation, disconnected opposite
decisions remain as an explicit conflict, and no proposal/decision operation applies policy text.
Semantic automation and immutable versions retain only `[suggestion:<stable-id>]`; MCP inspection
omits proposal and decision bodies. Authenticated identity, packaged two-client interaction, and model generation remain open, so
P-08 is `implemented_unverified`; accepted-text application is tracked separately as P-24.

P-11 now has bounded schema-versioned ephemeral awareness, an identity-safe active-provider
registry, migrated researcher identity in Lexical, remote cursor classes, an accessible capability
strip, and content-free MCP session counts. The Memory transport proves live two-client updates,
immediate disconnect cleanup, and reconnect tombstones. Local and Drive modes state that they do
not provide remote live presence; Drive edit polling is unchanged. A packaged live network
provider, authenticated identity, physical two-install cursor proof, and five-client soak remain
open, so P-11 is `implemented_unverified`.


P-04 now has a Penumbra-original typed Yjs domain service and deterministic headless evidence for
concurrent add, independent field edit, attributed edit history, and delete-versus-edit without
resurrection. This closes the data-model convergence slice only; the visible block editor,
examples and the P-26 explainable checker are now separate implemented-unverified slices; broader evaluation and packaged interaction remain open.

P-23/P-27 now have a Penumbra-original immutable version domain service. Canonical structured
policy snapshots, lineage, scenario references, participant identity, display-name-at-save,
timestamp, and notes are stored as SHA-256-addressed strings and reverified on read. Headless
tests cover tampering, detached results, idempotent replay, display-name changes, and forty
reordered/duplicate branch deliveries. The product rail now saves the exact active semantic draft
under an exact shared head and lists verified hashes, notes, authors, and times. Store migration v3
persists one per-install attribution identity while preserving historical display names. Product
restore now replaces exact semantic blocks and appends a new current-head child in one guarded Yjs
transaction with rollback evidence. Branch reconciliation, Drive/WebSocket convergence, packaged
interaction, crash-durability injection, and archive interchange remain open.

P-14/P-15 now have a Penumbra-original collaborative scenario domain and engine-free product
workspace. Stable scenarios contain lifecycle state, background, ordered multi-turn content,
attributed immutable turn revisions, attributed scenario edits, and optional branch parents. Each
turn persists one selected head; every revision persists its parent set and source; projection
derives the complete acyclic tip set.
Peer-specific internal keys preserve disconnected public-ID collisions for fail-closed projection;
graph inspection detects missing/cyclic ancestry. Researchers can create turns and append exact-
current revisions manually without AI; stale drafts stay visible but add no write, disconnected
siblings remain auditable and converge deterministically, ordinary edit is blocked during conflict,
and explicit UI/MCP reconciliation appends an all-parent merge under exact research/head/tip guards.
Valid v1 local, Drive, archive, and pack histories migrate deterministically before publication;
hostile/future input is zero-write. Product conversation/lineage views are bounded. Generation,
manual/generated response variants, evaluation, votes, annotations, labels, and open scenario-pack
interchange are implemented as separately audited layers. Authenticated identity and time,
near-limit performance, packaged accessibility, and physical two-install reconciliation proof remain
open.

P-19 now has a Penumbra-original collaborative vote-event ledger. Exact replay is idempotent;
re-votes and withdrawals retain attributed history; peer-specific namespaced buckets preserve
disconnected first votes; concurrent votes by one participant select a deterministic current event;
and conflicting event identity fails closed. Visible vote controls have landed; authenticated
identity, a trusted distributed clock, moderation, and packaged two-install interaction remain open.

P-20 now has a Penumbra-original flag/note lifecycle ledger. Immutable create/edit/resolve/reopen
events retain attribution and exact parent links. Stale product writes fail, concurrent children
remain auditable, and missing scenario/turn targets or colliding annotation identities fail closed.
Visible scenario/turn create, edit, resolve, and reopen controls now use exact event parents and
write-time integrity checks. Authenticated identity, moderation, notifications, trusted clocks,
and packaged two-install interaction remain open.

P-21 now has a Penumbra-original context-label ledger. Immutable create/rename and scenario
add/remove events use exact-parent guards; disconnected assignments merge, concurrent rename
branches remain auditable, filtering is deterministic, and colliding roots or orphan targets fail
closed. Visible create, rename, assign, and remove controls now use exact event parents and bounded
lists. Authentication, moderation, trusted clocks, and packaged remote interaction remain open.

P-28/P-29 now have exact-head commit, restore-as-new-child, and deterministic engine-free diff
services. A stale head fails before creating an orphan; two concurrent restores preserve both
immutable branches and converge one Yjs head across forty delivery orders. The product rail selects
and renders parent change notes plus bounded block details without a model. Product restore now
uses a two-step confirmation, exact draft/head guards, semantic-block replacement, and rollback.
A real two-peer Lexical/Yjs fixture proves root, immutable version, and head travel in one shared
update, while the peer editor projection is checked after synchronization. The twenty-fifth MCP
tool reuses that restore transaction with an inspected target, exact document revision, and exact
head. A packaged single-profile proof checkpoints a temporary divergence, restores exact readback,
and rejects stale document/head calls without adding a version. Branch reconciliation, richer
human notes, Drive/WebSocket proof, packaged pointer/keyboard interaction, crash injection,
authenticated identity, and archive interchange remain open, so P-28 remains
`implemented_unverified`.

## 5. Target architecture

```text
Workspace UI
  editor | scenarios | evaluate | versions | sources | Ask
                         |
Domain services (no React/provider imports)
  project | policy | scenario | evaluation | version | participant
                         |
Yjs live model + immutable version objects
             /-----------+----------------\
Local persistence                 Collaboration providers
IndexedDB/app data                test | Drive | WebSocket | WebRTC?
             \-----------+----------------/
                         |
Typed AI tasks
bundled llama.cpp default | user OpenAI-compatible endpoint
```

Layer rules:

1. Components call domain services, never Google/provider SDKs.
2. Domain objects use stable IDs and schema versions.
3. Yjs is mutable collaborative truth; versions are immutable content-addressed snapshots.
4. Providers exchange updates/awareness and do not interpret policy nodes.
5. Local persistence is always attached; network providers are replaceable.
6. Large attachments stay outside Yjs and are content-hash references.
7. AI tasks return typed, validated proposals/evidence with provenance.

Minimum logical model:

```text
ProjectManifest: schemaVersion, projectId, title, timestamps, documentIds,
                 transport hints, required capabilities
CollaborativeProject (Y.Doc): policy XML, scenarios map, heuristics map,
                              discussions map, evaluation index, settings
Scenario: stable ID, title, background, turns, labels, parent ID,
          response variants, preferred examples, review metadata
Version: content hash, parent, policy snapshot, scenario references,
         author/time, deterministic diff, optional AI note/evaluations
```

### Provider contract

Providers expose lifecycle, status, and `{ realtime, awareness, attachments }` capabilities.
Planned implementations:

- `MemoryProvider`: deterministic tests.
- `LocalProvider`: IndexedDB/app-data, always enabled.
- `DriveProvider`: default account-based asynchronous collaboration, remote-first.
- `WebSocketProvider`: optional real-time self-hosted y-websocket-compatible service.
- `WebRtcProvider`: experiment only; disclose signaling dependency and privacy tradeoffs.

Drive polling is not real-time presence. The UI must state provider capabilities honestly.

### Drive CRDT spike

Never store one mutable Yjs blob with last-write-wins. Compare:

1. append-only uniquely named Yjs updates plus snapshots/compaction;
2. generation/revision writes with optimistic concurrency; and
3. a real-time service with Drive used only for durable export/backup.

Test concurrent upload, duplicates, reordering, interrupted compaction, stale clients, API
calls, object growth, storage, and latency.

`RESOLVED-GOOGLE-01` (2026-07-14): a live comparison proved `drive.file` omitted a
collaborator-created Google Doc from the same app-created folder. ADR-0001 records the evidence,
Picker comparison, restricted-scope/verification burden, explicit re-link requirement, and the
selected-folder application boundary. The reauthorized Drive→local-model harness passed on
2026-07-14 against a collaborator-created native Google file. S-01 is now
`implemented_unverified`; a second-account/second-install reproduction is still required before
the capability becomes `verified`.

### AI task contract

Typed tasks: scenario response/metadata, policy suggestion, discussion prompt, heuristic check,
and version-note summary. Each defines input/output JSON schema, context budget, cancellation,
timeout/retry, validation/repair, deterministic fallback, privacy class, network destination,
and provenance (model, parameters, prompt-template version, time). Do not port Next server
actions, OpenAI/Together SDK objects, or API-key assumptions into UI code.

## 6. Delivery phases and hard gates

Effort is relative (`M`, `L`, `XL`), not a calendar promise.

### Phase 0 — provenance and reproducible baseline (`M`)

Deliver provenance ledger, machine-readable capability ledger, SBOM/license CI, original sample
project, original behavior fixtures, and automated prohibited-dependency/source scans.

Gate: every file is Penumbra-original or a recorded permissive dependency; every capability
row has a phase and verification method;
a second reviewer reproduces the inventory from documented commands.

Progress at the 2026-07-14 working baseline: `docs/audits/CAPABILITIES.json`,
`EDITOR-PROVENANCE.md`, `DATA-FLOW.md`, `THREAT-MODEL.md`, ADR-0001, and `npm run audit` exist.
SBOM/license generation, the original sample project/behavior fixtures, and independent reviewer
reproduction are still open; Phase 0 is not complete.

Post-baseline progress: exact editor dependencies are pinned and their package-level license,
source, version, and registry-integrity evidence is recorded in `EDITOR-PROVENANCE.md`. The full
generated SBOM/license inventory and independent reproduction remain open.

### Phase 1 — domain contracts and migrations (`L`)

Deliver schema-versioned project/scenario/heuristic/evaluation/version/participant types,
malformed/legacy/large/Unicode fixtures, idempotent migrations, provider-independent services,
portable archive spec, content hashing, and performance budgets.

Gate: repeat/interruption migration tests pass; fixtures round-trip; property tests preserve
valid graphs and reject invalid references.

Progress: project-manifest schema v1, persisted-store migration v2, reserved provider-neutral Yjs
collections, fail-closed manifest validation, and the first duplicate/reorder/round-trip harness
exist. The project archive envelope and content hashing now exist with bounded corruption,
collision, and offline-reopen fixtures. Full domain schemas, property tests, cross-machine packaged
import, and scale budgets remain.

### Phase 2 — clean-room editor vertical slice (`XL`)

Deliver a `workspace` view using exact-version MIT Lexical and `@lexical/yjs` packages, an
original three-panel Syzygy UI, original policy/heuristic/scenario/suggestion/spotlight nodes,
formatting,
undo, paste sanitation, accessibility, Yjs binding, and local persistence.

Gate: P-02–P-10/P-34/P-35 pass; 100-page stress budget passes; bundle contains no Tiptap,
PolicyPad, Firebase, Next, or copied template code; every theme is reviewed.

Progress: an original Lexical/Yjs policy surface, heading/quote/mark fixtures, undo, local IndexedDB
persistence, the three-panel workspace shell, pointer/keyboard policy reordering, and a live
heading-derived table of contents exist. Stable ID-keyed Y.Text records now separate policy
content/marks/embeds/review state from root placement. The former partitioned move-versus-edit case
and both separate append-only delivery orders pass; local backfill is atomic/idempotent, and only a
healthy zero-legacy Drive bridge enables reorder. Existing shared legacy baselines remain gated.
Packaged two-install Drive interaction, randomized/large-document stress, more custom research
nodes, and cross-theme visual review remain.

### Phase 3 — local project lifecycle (`L`)

Deliver create/open/rename/archive/export/import, crash-safe persistence, attachment store,
recovery/backups/quota UI, stable participant identity, immutable versions, restore-as-new.

Gate: fault injection loses no acknowledged edit; export/import works offline with engine off;
P-01/P-13/P-23/P-27–P-29/S-04 pass.

Progress: create/open/rename/archive, stable participant identity, immutable versions, safe
restore-as-new, and an engine-free portable archive product path exist. The archive is checksummed,
identity-bound, stripped of prior transport on import, collision/orphan-state safe, and proven to
reopen from fake IndexedDB without a network provider. Two-clean-install packaged transfer,
attachment storage, crash/power-loss fault injection, recovery/backups/quota UI, and decisive
S-04 verification remain open.

### Phase 4 — Drive projects and asynchronous CRDT (`XL`)

Deliver folder/project selection, authorization decision, Yjs-update provider, fetch-on-demand
attachments, retry/backoff/quota UI, safe compaction/GC, collaborator removal, separate
Google-native research-source reading, and explicit optional mirror/export.

Gate: partitioned two-machine edits converge; no unreferenced large download; interrupted
compaction recovers; P-12/P-13/S-01/S-02/S-05 and authorization tests pass; network trace and
Drive object layout match docs.

Progress: explicit compaction now pulls and flushes first, applies exact document/research guards for
MCP, appends a complete Yjs snapshot, then moves at most 200 already-applied update records per run
into a recoverable sibling folder with eight-way bounded concurrency. Unknown concurrent and failed
moves stay active. Headless tests prove clean-install reconstruction, concurrent retention, partial
retry, and replacement-provider lifecycle; Rust proves the bounded plan. Real-Drive interrupted-run,
quota/latency, archive-retention, and packaged two-install evidence remain open, so the affected
capabilities stay `implemented_unverified`.

Shared-title retention independently requires the complete exact tip set, canonicalizes all valid
events into one content-addressed snapshot before moving active events or superseded snapshots, and
keeps a rename arriving after the snapshot as an active child whose parent remains resolvable. The
product and 42-tool MCP expose count-only retryable maintenance. Rust/frontend gates cover canonical
ordering, missing parents, stale pre-move refusal, concurrent-child projection, and replacement
provider ownership. Explicit recovery now hashes active plus archived plus quarantined inventory, reconstructs only a
complete parent-closed graph, snapshots it before moving anything, quarantines invalid active records
without deletion, leaves invalid archived/quarantined data untouched, and can include later-valid
parent-complete quarantine in a new snapshot. Long MCP recovery runs use four bounded
background slots with 30-second heartbeats instead of holding the 15-second live request. Real-Drive
interruption/process-loss/quota and physical two-install repair evidence remain open.

### Phase 5 — optional real-time and presence (`L`)

Deliver provider-neutral awareness UI and a documented self-hostable WebSocket deployment with
health, persistence, auth hook, quotas, backup, and pinned versions. WebRTC ships only if its
signaling/privacy/reliability spike passes.

Gate: five-client rapid-edit soak converges; stale presence disappears; restart/partition loses
no edit; schema is unchanged when switching providers; P-11/P-12/S-05 pass.

### Phase 6 — scenario workflow (`XL`)

Deliver gallery/CRUD/labels/branches/contributors, multi-turn editing, local generation and
regeneration, variants, examples, votes, flags, notes, links, spotlight, and bounded job queue.

Gate: P-05–P-08/P-14–P-23 pass under two-client concurrency; engine failure cannot corrupt
state; reference graph survives delete/restore/export/import; jobs do not freeze editing.

Progress: the engine-free product covers scenario gallery CRUD/status, ordered turn creation and
exact-current revision editing, votes, notes/flags, labels, branches, generated/manual response
variants, examples, evaluation queues/comparison, stable links/spotlights, and open scenario packs.
Broad MCP inspection remains body-free, while explicit `read_scenario` and
`read_scenario_turn_revision` tools provide a bounded background/turn-head index followed by exactly
one selected-head, named, or indexed revision body. `reconcile_scenario_turn` adds an exact-research,
exact-head, complete-tip all-parent merge path. The physical LAN/Drive harness now discovers
the same turn identity on both installations before verifying both concurrent sibling bodies and the
same selected head/tip set, performing that merge, and requiring the four-revision result on both.
Its component gates pass; installing
this build on both office computers and recording the physical run, authenticated identity/time,
packaged accessibility, and near-limit performance remain open.

### Phase 7 — policy assistance and heuristics (`L`)

Deliver local-AI suggestion/discussion tasks, explainable heuristic results with cited spans and
manual override, review/diff/accept/reject/partial-edit UI, deterministic diff and optional note.

Gate: P-24–P-26/P-29 pass; malformed output is recoverable; prompt-injection fixtures cannot
cause commands/exfiltration; accepted AI work is attributed to its human accepter and provenance.

### Phase 8 — versioned evaluation (`XL`)

Deliver response matrix by version, baseline comparison, resumable evaluation queue, version
rail/evaluate panel, exports, and reproducibility metadata: model/hash where possible, samplers,
context, prompt version, seed support, timestamp, and nondeterminism label.

Gate: P-27–P-31 pass; restore preserves lineage; interrupted evaluation resumes without
duplicates; export is independently inspectable.

### Phase 9 — capability closure, security, accessibility, and release (`XL`)

Deliver closed capability ledger, threat model, data-flow inventory, accessibility audit, platform
smoke matrix, installer/updater/recovery/performance evidence, SBOM/licenses, user docs for each
transport/AI configuration, and documented open project/scenario import formats.

Gate: every capability row is verified, explicitly approved out-of-scope, or a blocker; no critical/high
security issue; clean install requires no paid service/key; signed artifacts pass fresh machines.

## 7. Mandatory adversarial testing

- Schema/migration fixtures, fuzzing, Unicode, invalid references, and large projects.
- CRDT duplicates, reordering, partitions, concurrent structural edits, and compaction.
- Identical provider contract suite across Memory, Drive fake/emulator, and WebSocket.
- Fake AI server: fragmented streams, malformed JSON, timeout, cancel, model loss, overflow.
- Two isolated app profiles for end-to-end collaboration.
- Paper plus all dark themes, DPI/font scaling, narrow layout, keyboard-only use.
- Deny-by-default network baseline and sanitized per-feature traces.
- Installer/model bootstrap/update/recovery/import/export on clean machines.

Required hostile cases:

1. offline delete vs edit of the same policy block;
2. reconnect after compaction removed old updates;
3. duplicate/out-of-order Drive listings;
4. multi-gigabyte attachment and quota exhaustion;
5. traversal names, active HTML/script URLs, malformed Yjs, archive bombs, prompt injection;
6. OAuth revoked mid-sync and API quota exhausted;
7. model dies mid-stream or returns prose instead of JSON;
8. provider/model changes during evaluation;
9. simultaneous version saves;
10. collaborator removed or renamed mid-edit;
11. crash during commit/upload/snapshot/import/migration; and
12. network unplugged after prior Drive use.

## 8. Audit artifacts and falsification protocol

Milestone PRs update or generate:

```text
docs/audits/CAPABILITIES.json
docs/audits/EDITOR-PROVENANCE.md
docs/audits/DATA-FLOW.md
docs/audits/THREAT-MODEL.md
docs/audits/DECISIONS/ADR-*.md
artifacts/test-summary.json
artifacts/dependencies.cdx.json
artifacts/licenses.json
artifacts/network/
artifacts/benchmarks/
```

Large artifacts may live in immutable CI runs, but commits retain summaries and links.

Claims such as “offline,” “private,” “real-time,” “capability complete,” “conflict-free,” and “no paid
dependency” must state exact scope, test/environment, evidence, limitation/counterexample,
verified commit/date, and re-verification owner.

### Prompt for an adversarial LLM reviewer

Give it this plan, the commit, and artifacts. Ask it to:

1. challenge whether the independently defined capability ledger covers the stated end goal;
2. trace every editor file to license/provenance evidence;
3. search lockfile/bundle for Pro, Cloud, Firebase, OpenAI, Together, Next server actions,
   and hard-coded vendor endpoints;
4. find mutations absent from schema/migration ledgers;
5. find components importing concrete providers;
6. reject convergence tests lacking duplicate/reordered/delayed updates;
7. compare privacy copy with network traces;
8. find AI outputs that mutate state without human acceptance;
9. reproduce commands on a clean checkout; and
10. mark plausible but unsupported claims `UNVERIFIED`.

Required review output: claim, contradictory evidence, file/line or artifact, severity, and
smallest test that resolves the disagreement.

## 9. Threat and scale gates

Threat model: hostile shared content/collaborator/webview/endpoint, stolen OAuth token, path
traversal, unsafe preview/open, CRDT amplification, attachment bombs, prompt-driven exfiltration,
participant replay/impersonation, rollback, and malicious update. The model has no ambient file
or Drive capability; domain services select and label AI context.

Phase 1 establishes measured budgets—not invented promises—for 10/100/500-page editing,
100/1,000/10,000 scenarios, Yjs startup/update size, Drive calls/objects/bytes, reconnect and
compaction time, five/twenty-client sessions, local-model latency, and evaluation throughput.

## 10. Decisions before expensive work

| Decision | By phase | Required evidence |
|---|---|---|
| editor provenance/reuse | 2 | written rights plus file ledger |
| Google Picker vs broader scope | 4 | two-account spike, security and verification review |
| default async vs relay tier | 4 | workflow, cost, privacy, reliability evidence |
| y-websocket/WebRTC/other transport | 5 | license, self-host docs, soak results |
| one Y.Doc vs domain docs | 1 | scale/consistency benchmark |
| attachment transport | 4 | lazy-load, quota, offline tests |
| participant authentication | 5 | impersonation/revocation analysis |
| evaluation reproducibility | 8 | model/llama.cpp behavior tests |

## 10.1 Open research platform and adversarial-model track

This enabling track does not replace the 41 product capabilities or inflate their completion
count. It lets researchers inspect, automate, compare, and extend those capabilities without
making a paid provider mandatory.

### Provider-neutral model layer

1. Contract-only descriptors and retention/training capability fields (landed).
2. Rust OS-credential boundary plus canary/redaction harness.
3. Fake-server conformance suite for streaming, structured output, tools, cancellation, rate
   limits, malformed events, usage, and storage-off inspection.
4. Local adapter conformance, then one remote adapter at a time: OpenAI Responses, Anthropic
   Messages, Gemini Interactions, xAI Responses, and documented custom adapters.
5. Task-level content/provider disclosure and per-run provenance/cost/retention record.

Progress: the strict Draft 2020-12 provider-run schema and plan-independent semantic validator now
land. Synthetic fixtures prove content exclusion, remote disclosure/HTTPS, dated policy metadata,
typed retention attestation, terminal-state consistency, source identity, token totals, and cost
bounds. MCP embeds the same schema. The registered Rust one-shot command now authors the record;
workflow persistence and live-provider evidence remain open, and client-authored records are not
authoritative evidence.

The constrained custom-adapter profile and non-executing headless certifier now also land. They
cover OpenAI Responses, Chat Completions, and Anthropic Messages compatibility; pin literal
loopback or HTTPS remote endpoints to an exact origin/route; require honest data-policy metadata;
and reject built-in shadowing, traversal, unknown fields, and hostile endpoint probes. Runtime
transport conformance, arbitrary WASI protocols, credential wiring, and live capability checks
remain open, so `custom` is still `contract-only`.

Gate: local remains the no-account default; no key appears in webview state, logs, crash reports,
projects, MCP, or exports; every remote adapter passes the same conformance suite and a sanitized
network trace before the UI calls it available.

### Adversarial review

Protocol v1 uses blind independent proposals, cross-critique, source audit, reversed-order judge
passes, minority retention, explicit human acceptance, and an equal-call single-agent baseline.
The rationale, counterevidence, and benchmark design live in `RESEARCH-EXTENSIONS.md`.

Gate: a versioned public/licensed fixture corpus reports source support, omission, abstention,
position stability, minority retention, human preference, latency, tokens, and cost. A panel may
ship as experimental even when it loses, but Syzygy cannot claim superiority unless held-out,
compute-matched results and limitations are published.

Progress: the deterministic planner, strict public record, semantic validator, and native
product executor now pass hostile synthetic and loopback fixtures. One batch approval freezes the
exact content, complete graph, routes, dependencies, judge order, per-call limits, and
compute-matched baseline. Rust atomically consumes calls, verifies upstream-output hashes, derives
phase prompts, uses fixed built-in transports plus the OS vault, rejects malformed/private
reasoning output, and returns content-free provenance. Three MCP tools start, inspect, and cancel
a revision-guarded resumable job from selected live document blocks; jobs have 30-second
heartbeats, a 15-minute deadline, one-hour terminal retention, and no shared-mutation authority.
Two additional MCP tools explicitly archive a completed full review into the existing collaborative
Yjs discussions namespace and append immutable, exact-parent human accept/reject events. Canonical
hashing, provider-provenance replay validation, bounded peer convergence, stale-write refusal,
conflict retention, content-minimized inspection, and zero draft mutation are headlessly tested.

The product workflow now selects exact draft blocks, configures two to eight perspectives plus
judge/baseline routes, reports the full call count, reuses the resumable native job, separately
shares full archives, renders every evidence class and conflict, and appends immutable human
accept/reject history with no draft mutation.

Evidence categories now remain unmounted until opened and progress in 50-item pages. Still open:
packaged native-dialog interaction evidence, physical two-install archive/decision interaction,
live provider compatibility/cost/rate-limit evidence, public benchmark corpus, statistical review,
near-32-MiB decode/memory and end-to-end usability proof, and any quality or superiority claim.

The run-record interchange is now published as strict Draft 2020-12 JSON Schema and embedded in
MCP. Its typed plan-relative validator remains the authority for cross-record semantics that JSON
Schema alone cannot establish.

### Research plugin API

Manifest/proposal/certification schema v1, TypeScript validators, and a non-executing headless
package certifier have landed. The runner proves bounded schema/path/fixture/authority metadata and
deliberately labels results `contract-certified`, not runtime-safe. Next deliver a no-authority
WASI host/WIT world on the implemented non-executing authority broker, declarative contribution rendering, local
install/disable/upgrade, and the advanced native MCP trust tier. Marketplace control is optional;
local packages and open documentation are required.

The authority broker now opens 15-minute sessions only from a strict manifest plus explicit grant
subset, returns detached bounded snapshots, accepts only pending exact-revision proposals, and
issues non-executing Drive/network/model decisions with target/disclosure/provenance recheck flags.
It contains no loader or external operation and is reported separately from `pluginLoader`.

The first public WIT contract is also landed as `syzygy:research/plugin@1.0.0`. It has no imports,
accepts a bounded optional project snapshot, and returns only no-change or revision-guarded
proposals. The exact source is headlessly inspectable through MCP. No WebAssembly parser, loader,
resource limiter, or component execution is claimed yet.

Gate: unknown/undeclared authority fails closed; WASI begins with no project, Drive, network,
model, or filesystem access; native MCP is never described as sandboxed; all mutations are bounded
revision-guarded proposals with a human-visible diff and attribution.

Machine-readable inspection is available through `syzygy_platform_contracts`. It must keep
live-provider certification separate from local conformance and report:
`native-multi-provider-executor-resumable-mcp-pending-human-review` for adversarial execution,
`native-content-bound-call-graph-authorizer` for batch authorization,
`native-atomic-dependency-bound-executor` for native reservation/execution, and
`contract-only` for custom-adapter execution and plugin loading.

Progress: OpenAI Responses one-shot request construction, bounded whole-operation timeout,
idempotent in-flight/inter-event cancellation, and fake-network incremental SSE dispatch now pass
unwired Rust conformance suites and are reported as `request-stream-and-schema-validated-tool-proposal-conformance`.
Aggregate remote execution is now `native-disclosure-openai-anthropic-gemini-xai-stream-schema-validated-tool-proposal-review-ui-no-live-proof`: the registered task bridge
retrieves an OS-vault credential, applies native one-use disclosure/timeout/cancellation controls,
normalizes the response, and authors content-free provenance. All four built-in providers use an ordered per-call Tauri
channel and bounded Rust/TypeScript accumulators so one workspace component can render the exact-draft
review incrementally without mutating shared state. xAI also binds its mandatory boolean ZDR response
header into the typed outcome and content-free run record before any stream event is dispatched.
All four transports map bounded custom-function definitions and normalize calls to a common
start/delta/complete lifecycle. The product renders those calls as transient inspect-only proposals;
Rust and the pinned frontend AJV independently classify complete arguments against the exact
approved safe-subset schema as valid, invalid, or missing-definition. Domain status remains
unreviewed and execution false. The surface has no result loop or MCP/Drive/filesystem/plugin/editor/
network/shared-mutation authority. Tool execution, domain validation/authority design,
slow-consumer/backpressure proof, packaged adversarial UI interaction, and
opt-in live-provider evidence remain open; the durable product workflow and shared history are implemented.
The cross-language record gate now passes: the Rust loopback execution record is explicitly marked
as conformance evidence and passes both the public TypeScript schema and semantic validator without
leaking its secret or prompt canaries.

Anthropic Messages request/stream/control conformance now passes the same bounded Rust boundary and
the exact-draft review routes its normalized SSE events and fragmented tool proposals through the
scoped product channel with safe-subset schema status. Tool execution/result continuation, domain
validation/authority design, and live-provider evidence remain open,
so no live compatibility claim is made.
Gemini Interactions stable-v1 request/stream/control conformance now passes with storage,
background execution, and thought summaries forced off. Its indexed SSE step path is routed through
the exact-draft review while omitting thought/signature bodies and normalizing/schema-validating complete function-call
steps. Tool execution/result continuation, domain validation/authority design, and
live-provider evidence remain open, so no live compatibility claim is made.
xAI Responses request/stream/control conformance now passes with storage off, no thread/cache
identifier, explicit pre-dispatch ZDR response attestation, bounded Responses SSE normalization,
whole-call custom-function proposal normalization/schema validation, and exact-draft product routing. Tool execution/result continuation, domain validation/authority design, encrypted-reasoning/
WebSocket continuation, and live-provider evidence remain open, so no live compatibility claim is made.

Credential progress: the cross-platform OS-vault abstraction, zeroizing secret wrapper, memory
contract tests, and an opt-in Windows Credential Manager create/read/delete/absence canary pass.
Typed credential and generation/cancellation Tauri commands and wrappers now exist. A collapsed
Settings surface calls status/set/delete for OpenAI, Anthropic, Gemini, and xAI and keeps keys out of
React/store persistence. The exact-draft remote review calls the scoped stream command for OpenAI,
Anthropic, Gemini, and xAI. The
generation request carries no approval boolean; a
Rust-owned native dialog creates one-use approval, and denial is headlessly proven not to read the
vault or contact the network. macOS/Linux live canaries, transient-entry and end-to-end leak scans,
and a packaged native-dialog click proof remain open.
The public command also no longer accepts caller-authored categories or a detached snapshot list:
Rust derives both from the structured question/instructions/labeled-excerpt payload before the
dialog. Product domain orchestration still must decide which frozen snapshots enter that envelope.

## 11. Recommended next slice

P-18 now has immutable attributed positive/negative example history, replay/collision/hostile-
input gates, disconnected convergence, engine-free product controls, and content-free MCP inspection.
Packaged two-install interaction, authenticated identity, semantic quality, and evaluation remain
unproven, so it is `implemented_unverified`.

P-22 now has a real-domain four-node branch fixture that preserves stable ancestry, ordered
turn/revision content, and workflow state through portable export, local persistence, and disconnected
IndexedDB reopen. Missing-parent failures remain visible after import. Packaged two-install interaction
is still open, so it is `implemented_unverified`.

P-24 now separates human acceptance from draft mutation. Its product action binds the exact
proposal and accepted decision to a deterministic unchanged-policy fingerprint, exact live editor
revision, unique marker, and stable policy identity; the real Lexical controller replaces only that
card with one review policy block. Authenticated identity, packaged two-client interaction, MCP
application, partial edit, and semantic-quality proof remain open, so it is `implemented_unverified`.

P-30 now has a persistent exact-version/exact-scenario rerun queue with bounded peer-namespaced
events, sequential local/API execution, begin-before-send and atomic completion, crash resume,
pause/cancel/retry, a two-minute item deadline, 30-second progress heartbeats, product controls,
and body-free MCP integrity counts. Live-provider quality, authenticated identity, and packaged
two-install crash/convergence remain unproven; portable interchange is proven separately by P-33, so P-30 is
`implemented_unverified`.

P-31 now derives a deterministic neutral transition matrix from two completed queues only when
project, document, prompt, scenario identities, and exact scenario revisions match. The side-by-side
product surface and 24-MB open JSON export retain verified policy snapshots, exact scenario and result
bodies, route/model/run/attribution, explicit missing seed/sampler/model-hash metadata, canonical order,
and recomputed SHA-256/identity/summary checks. MCP exposes only compatible-pair count. Live-provider
reproducibility, causal or semantic improvement, authenticated identity, and packaged pointer/save
interaction remain unproven, so it is `implemented_unverified`.

P-33 now publishes a strict Draft 2020-12 v2 `syzygy-scenario-pack` schema and retains the CC0 v1
sample as a compatibility fixture, with a
64-MiB-bounded canonical SHA-256 runtime codec. Product controls export selected scenarios plus required
ancestors or the full graph, disclose included/excluded state, preview a validated import, skip exact
duplicates, and abort the complete atomic Yjs import on any same-ID content collision. Full ordered
turn, revision, edit, lineage, timestamp, and author attribution round-trip into a different project.
New packs persist durable heads and parent sets; checksummed v1 packs become deterministic
`migration-v1` chains before import. The current v2 schema is discoverable through
`syzygy_platform_contracts`. Authenticated identity, trusted clocks,
packaged OS file-dialog interaction, and external third-party reader interoperability remain unproven,
so it is `implemented_unverified`.

S-06 now has a strict versioned manifest covering eight network boundaries, matching Settings/onboarding/update copy, a production-source URL-origin classifier, adversarial unknown-field/missing-copy/unlisted-origin fixtures, and a sanitized committed proof. The manifest is available through MCP. It makes source and copy drift mechanically reviewable but does not claim cross-platform packet capture, DNS/CDN pinning, third-party SDK payload inspection, or paid-provider live compatibility.

Status snapshot on 2026-07-20: the 42-row ledger has 42 `implemented_unverified`, 0 `planned`,
and 0 `verified` capabilities. The shipped local editor, Drive research path, local engine, and MCP
pilot are meaningful foundations, but none substitutes for the decisive two-install, convergence,
portable-archive, workflow, accessibility, and adversarial gates below. MCP setup/onboarding is
tracked as enabling infrastructure rather than inflating the product-capability count.

Do not use the web port or upstream source as an implementation input. First:

1. maintain the new provenance and machine-readable capability ledgers and finish their open
   SBOM/license/sample-fixture/reviewer gates;
2. maintain the now-pinned Lexical/Yjs dependency and source ledger;
3. add the extension contract harness and truthful MCP self-description (landed; keep it green);
4. maintain the policy block's root-order, stable-content, formatting, pointer/keyboard, and
   outline fixtures. Stable Y.Text content/status identity and separate placement now pass the
   move-versus-edit partition plus both append-only delivery orders; keep legacy Drive baselines
   gated until a coordinated migration exists, and finish packaged two-install/stress evidence;
5. maintain the now-landed two-editor `MemoryProvider` live/partition/reconnect suite and require
   Drive/WebSocket providers to pass the same contract;
6. render it in paper and all retained dark themes;
7. measure bundle/startup/editor latency; and
8. stop for audit before scenarios, provider calls, plugin execution, or Drive CRDT state.

This tests the riskiest assumptions—license, Tauri integration, schema, Yjs, persistence, and
design—without creating another monolith.

## 12. Completion rule

A polished editor, two-cursor demo, or one local generation does not satisfy the end goal.
Completion does not require copying any existing product: the independently defined capabilities
and their evidence decide completion.

# Roadmap & History

The comprehensive delivery program, capability ledger, hard gates, and adversarial review
protocol are in [`END-GOAL-PLAN.md`](END-GOAL-PLAN.md). This file remains the short history.

> Where Syzygy came from, what's done, and what's next — so decisions don't get re-made.

## Lineage

1. Existing collaborative research tools demonstrated a valuable workflow, but commonly
   rely on paid editor/collaboration services, hosted databases, and large-model APIs.
   They are product comparisons only—not source material for Syzygy.
2. **syzygy-web** (`D:\PolicyPad\syzygy-web`) was an early experiment and is abandoned.
   None of its code, prompts, schemas, fixtures, assets, templates, or UI may be ported.
3. **Syzygy** (this repo) — pivot to desktop: fork of **Aphelion**'s proven Tauri shell
   (installer, auto-updater, bundled llama.cpp engine, Rust file access), roleplay
   surface removed, document/collab surface being built.

## Done (shipped)

- **v0.1.0** — Aphelion shell stripped to the Ask surface (experts, folder knowledge,
  document generation, optional vision). Real dead-code removal; store/types rewritten;
  persist key `syzygy`.
- **v0.1.1** — Google Drive auth (loopback + PKCE, cancelable, scope fail-fast + helper
  modal); Drive file primitives + per-thread prompt mirroring; **paper/ink design
  system** (default theme, IBM Plex, aligned-bodies mark, animated splash); diagnostic
  log + Settings viewer; renameable/scrolling ask threads; reopenable model wizard;
  **live update pipeline** (signed releases, in-app updater, 3-OS CI).
- **v0.1.2** — **Drive folder mirror** (`Documents/Syzygy` ↔ Drive, two-way LWW sync);
  📂 Use Drive folder (knowledge reads + documents land there, auto-push after
  generation); offline-claims copy audit → local-first voice.
- **v0.1.4** — initial remote-first Drive retrieval/native Google export, OAuth/file-boundary
  hardening, paper-theme token repairs, signed updater validation, and the auditable end-goal plan.
- **v0.1.5** — replaced all shipping Aphelion icon/installer artwork and strings with reproducible
  Syzygy assets; fixed the stale uninstaller data path; added explicit Drive workspace selection,
  consented collaboration access, recursive native Google export, fail-closed Shared Ask, and a
  real Drive→local-model headless harness; began Phase 0 with a 41-item capability ledger,
  provenance/data-flow/threat-model evidence, ADR-0001, and CI structural audits.

## Current validation tranche

- The current post-0.1.10 local-inference slice makes the bundled engine optional without making
  projects or remote providers conditional on it. First run can continue without a download; a
  persisted title-bar switch beside VRAM unloads/reloads the real text and vision processes; native
  startup now waits for the frontend's migrated preference. Focused policy/migration tests, the
  production frontend build, and `cargo check --locked` pass. Packaged pointer/keyboard interaction
  and restart process/VRAM proof remain open, so S-03 stays `implemented_unverified`.

- The reauthorized Windows account now passes the headless collaborator-created native Google
  Doc→local-model canary proof without a mirror. S-01 is `implemented_unverified` pending the
  planned second-account/second-install reproduction.
- The v0.1.6 patch adds the required shared-drive flag to traversal/read/write/sync requests,
  distinguishes OAuth success from workspace setup failures, and persists sanitized diagnostics
  across restarts.
- The v0.1.7 patch closes the observed Ask-to-native-Sheet gap: Drive evidence no longer lets the
  model imply an unperformed write; bounded literal cell proposals require exact human
  confirmation, are scoped again in Rust, and have a temporary-Sheet write/readback/cleanup
  harness. Its production-grant proof wrote, read back, and cleaned up a 20×10/200-cell native
  Sheet. Native Docs and Slides remain explicitly read-only until their own typed edit contracts
  exist, although their Cloud APIs are enabled for that future work.
- The v0.1.8 workspace slice pins the independently licensed Lexical/Yjs stack and adds
  a schema-versioned local project, original research-editor shell, local IndexedDB Yjs provider,
  and a headless project harness. The harness covers malformed schemas, idempotent save migration,
  duplicate/reordered update convergence, concurrent offline domain edits, and close/reopen local
  persistence. This is scaffolding, not a claim of two-user rich-text or Drive CRDT completion.
- The v0.1.9 workspace slice embeds a stdio MCP mode in the Syzygy executable and an authenticated
  loopback bridge to the live webview. Its first ten semantic tools inspect and explain the
  workspace, navigate project identity, and read/replace/append the active Lexical draft with
  optimistic revision guards. The MCP explicitly reports disabled versions, scenarios, Drive
  project transport, and real-time presence instead of implying those placeholders work.
- The v0.1.10 MCP onboarding slice moves connection instructions into Settings. Rust derives
  the exact executable/install folder and produces JSON, Codex TOML, a connection prompt, and a
  starter task used by both the UI and the new `syzygy_installation` MCP tool. The headless harness
  rejects relative paths or configuration that is not tied to the binary under test; the packaged
  proof is recorded in `docs/audits/runs/MCP-SETUP-2026-07-14.json`.
- The post-0.1.10 development slice defines provider-neutral descriptors for local, OpenAI,
  Anthropic, Gemini, xAI, and custom adapters; a deterministic adversarial-review planner; strict
  plugin/proposal schemas; and a twelfth headless MCP inspection tool. Remote adapters and plugin
  loading remain explicitly unavailable. Adversarial execution now has an injected headless phase
  runner but no product executor or live-provider panel. The evidence and
  falsification design is in `RESEARCH-EXTENSIONS.md`; APIs are in `PROVIDER-API.md` and
  `PLUGIN-API.md`.
- The same slice adds a provider-neutral collaboration lifecycle and a deterministic two-editor
  Memory transport. Its headless suite proves bidirectional live document/domain updates,
  partition isolation, offline edits, reconnect merging, awareness cleanup, and identical final
  state. This is evidence for the provider contract, not a claim that Drive or WebSocket
  collaboration has shipped.
- The first original product node is now implemented but not yet interaction-verified: a Lexical
  `PolicyBlockNode` with stable
  identity, editable text, draft/review/approved state, strict JSON import, theme-token UI, and a
  semantic MCP round-trip that preserves identity/state. The headless fixture covers add, edit,
  reorder, serialize, restore, malformed identity, partitioned concurrent edits, and connected
  reorder convergence. The first apparent reorder failure was a harness defect: it compared
  Lexical node-map enumeration rather than root document order. The corrected oracle passes and
  is documented in the run evidence. P-03 is `implemented_unverified`. The product now has one
  semantic reorder command shared by pointer controls and Alt+Shift+Arrow shortcuts, plus a live
  heading-derived outline and formatting fixtures. P-09/P-10/P-34 are therefore
  `implemented_unverified`; P-10 remains blocked from remote-safe claims by the explicit expected-
  failure move-versus-edit partition fixture.
- The first remote-model execution boundary is now headlessly testable with a bounded product caller.
  Rust constructs and normalizes an OpenAI Responses one-shot request, requires matching content
  disclosure, forces `store:false`, accepts only HTTPS or literal loopback test endpoints, bounds
  the response, and sanitizes failures. A fake server captures the real wire request and fifteen tests
  cover secret redaction, unsafe endpoints, disclosure, response parsing, and malformed/error
  responses. Its incremental SSE decoder now passes byte-fragmented Unicode, multiline, unknown
  future event, usage/finish, sanitized error, malformed, mismatched, oversized, and truncated
  fixtures. Bounded request and stalled-body deadlines plus idempotent in-flight/inter-event
  cancellation now have fake-server evidence. Real HTTP SSE chunks are incrementally normalized,
  terminal order and aggregate size are enforced, and sanitized provider errors remain distinct.
  The adapter is labeled `request-and-stream-control-conformance`; tools, the frontend streaming
  event bridge, and opt-in live-provider proof remain gates before broader availability.
- The provider credential vault now has a collapsed product Settings caller. Its provider-neutral
  trait passes an in-memory set/read/delete/error-redaction suite; secret strings zeroize on drop;
  and a Windows Credential Manager harness created, read, deleted, and independently proved absence
  of a random canary without printing it. Native macOS Keychain and persistent Linux backend builds
  are configured, but their live canaries and transient DOM/heap leak proof remain open. The UI
  supports OpenAI, Anthropic, Gemini, and xAI set/replace/remove without persisting a key or gaining
  generation authority.
  Evidence: `docs/audits/runs/PROVIDER-SETTINGS-2026-07-15.json`.
- P-04 now has a typed collaborative heuristics domain service. Nested Yjs maps merge concurrent
  field edits, retain per-edit author/time/value attribution, reject invalid or conflicting replay
  locally, and fail closed when disconnected peers collide on one edit ID,
  and make deletion win over concurrent nested edits without resurrection. Eighty seeded delivery
  permutations plus invalid-state tests pass. UI, positive/negative examples, voting, evaluation,
  and remote transport remain open, so the capability is `implemented_unverified` rather than a
  product-complete claim.
  Evidence: `docs/audits/runs/HEURISTICS-CONVERGENCE-2026-07-15.json`.
- The open researcher API now has a non-executing package certifier and a complete interface-only
  citation-auditor example. Draft 2020-12 schemas, bounded JSON, real-path containment, valid and
  invalid proposal fixtures, plugin identity, documentation/license/runtime-file presence, and
  seven explicit authority allow/deny probes run headlessly. The report says
  `contract-certified`, never runtime-safe; plugin discovery, install, WASI execution, permission
  brokerage, UI, lifecycle, and output-flood/crash tests remain open.
- The non-executing plugin authority broker now enforces explicit grant subsets in 15-minute
  sessions, detached bounded project snapshots, pending revision-guarded proposals, selected-Drive
  identity, granted HTTPS host patterns, and configured model providers. It returns decisions only:
  no loader, fetch, provider call, Drive call, or mutation is wired. WASI/native hosts, install
  lifecycle, DNS/redirect enforcement, UI, and runtime failure tests remain open.
  Evidence: `docs/audits/runs/PLUGIN-AUTHORITY-BROKER-2026-07-15.json`.
- The public `syzygy:research/plugin@1.0.0` WIT world now has zero host imports and one bounded
  invocation/output surface. Tests reject ambient fields, duplicate sources, cyclic/oversized
  envelopes, direct mutation, and malformed proposals; pinned upstream `wit-parser` resolves one
  zero-import/one-export world; MCP embeds the exact WIT and reports
  `published-zero-imports-no-runtime`. Component parsing/instantiation, import inspection,
  fuel/memory/time limits, traps, install lifecycle, and any capability-bearing WIT world remain
  open. This is an interface proof, not sandbox execution.
  Evidence: `docs/audits/runs/PLUGIN-WIT-CONTRACT-2026-07-15.json`.
- The adversarial protocol now has an executable run-record validator and synthetic benchmark
  fixture. Eight tests enforce blinded artifacts, complete candidates/critiques, claim-level source
  audits, planned reversed judge order, equal actual call budgets, supported-minority retention,
  finite accounting, prohibited hidden reasoning, and revision-guarded human acceptance before
  mutation. This validates evidence structure, not multi-model quality; model-call orchestration,
  real benchmark fixtures, statistics, and any superiority claim remain open.
- Adversarial run record v1 is now a public strict Draft 2020-12 schema, embedded in the headless
  MCP platform contract and checked for drift against the typed valid fixture. Structural schema
  success is explicitly separate from plan-relative semantic validation and any quality claim.
- The adversarial protocol also has an injected headless runner. For `N` participants it proves
  `N` independent proposals, `N` cyclic critiques, one evidence audit, two order-swapped
  judgments, and a separate `2N + 3` call baseline. Synthetic executors prove phase isolation,
  route blinding, cancellation, sanitized failure, pending human review, and no shared mutation.
  Native batch scope validation/disclosure plus expiring/revocable authorization now exist without
  a consumer. An internal concurrency-tested reservation function now enforces exact run/source-ID/
  route/call identity and atomic route+total decrements, but binds no task bytes and executes
  nothing. A content-bound product provider executor, UI/persistence, public fixtures, and live
  comparative evidence remain open; this is not a quality or superiority claim.
  Evidence: `docs/audits/runs/ADVERSARIAL-BATCH-AUTHORIZATION-2026-07-15.json` and
  `docs/audits/runs/ADVERSARIAL-BATCH-RESERVATION-2026-07-15.json`.
- Anthropic Messages now has a one-shot `request-control-conformance` slice. A fake server
  proves the current `/v1/messages` path, `x-api-key`, pinned API version, system/user mapping,
  bounds, normalized text/usage, thinking-block non-retention, sanitized failure, timeout, and
  cancellation. Anthropic streaming, tools, product workflow UI, and live proof remain open.
- Gemini Interactions now has a stable-v1 `request-control-conformance` slice. Its fake
  server proves header auth, storage/background/stream off, thought-summary suppression, system and
  user mapping, output bounds, text-only retention, consistent aggregate usage, sanitized failure,
  timeout, and cancellation. Streaming, tools/thought signatures, UI, and live proof remain open.
- xAI Responses now has an unwired one-shot `request-control-conformance` slice. Its fake server
  proves storage-off/no-threading request shape, bearer auth, bounded normalization, controls, and
  mandatory boolean ZDR attestation without confusing standard retention with enterprise ZDR.
- A strict public provider-run record now captures content-free call provenance, disclosure,
  destination, dated policy, storage/ZDR state, terminal outcome, usage, and cost. Its semantic
  validator and MCP embedding are implemented; the Rust task command now emits authoritative
  records, while workflow persistence and live-provider evidence remain open.
- Custom compatible model adapters now have strict profile/certification schemas, a non-executing
  package runner, hostile profile fixtures, exact endpoint probes, and a documented local-vLLM
  example. Runtime transport and credentials remain `contract-only`.
- The built-in one-shot provider task bridge now proves vault lookup, fixed-endpoint dispatch,
  sanitized normalized output, disclosure denial without network contact, and Rust-authored
  content-free provenance. Credential and generation/cancellation Tauri commands exist. Generation
  always asks through a Rust-owned native **Send once** dialog; approval is absent from the request,
  and denial is proven to avoid both vault reads and network. The public request carries a
  structured question plus labeled source snapshots; Rust derives disclosure categories and unique
  provenance IDs from the same serialized payload. The workspace now calls it for one optional,
  non-mutating current-draft review with editable provider/model/question and cancellation.
  The headless proof and non-claims are recorded in
  `docs/audits/runs/NATIVE-PROVIDER-DISCLOSURE-2026-07-15.json`.
  Envelope binding evidence: `docs/audits/runs/PROVIDER-RESEARCH-ENVELOPE-2026-07-15.json`.
- The actual Rust-authored task record now crosses process serialization and passes the public
  TypeScript schema plus semantic validator. Loopback evidence is explicitly marked and cannot be
  mistaken for a production HTTPS call.
- Immutable policy checkpoints now use a canonical semantic-block envelope stored under its
  SHA-256 address. Readback re-canonicalizes and rehashes; direct tampering fails closed, returned
  values are detached, parent links are validated, and the author's stable participant ID plus
  display-name-at-save survive later name changes. Forty reordered/duplicate branch deliveries
  converge. The workspace version rail now saves the exact active semantic revision under the exact
  current head, lists verified checkpoints, and shows author, note, time, hash, and current-head
  metadata. Store migration v3 makes the generated per-install participant ID durable. Safe
  restore now has a product caller; Drive/WebSocket transport and packaged
  pointer/keyboard validation remain open.
- Exact-head version commits and restore-as-new-child are now implemented at the domain layer.
  Stale commits fail before insertion; concurrent restores retain both immutable branches while
  Yjs selects one deterministic head. A pure structured block diff and stable count note operate
  with the model engine off. The rail now renders that note and up to eight ordered block changes
  for the selected checkpoint, with a server-rendered accessible-control harness. P-28 now has a
  two-step product caller: exact semantic editor replacement and the new immutable child/head share
  one Yjs transaction, synthetic partial failure rolls back, and a real two-peer Lexical/Yjs
  fixture receives root/version/head in one update. P-28/P-29 remain `implemented_unverified`;
  conflict reconciliation, exports, Drive/WebSocket convergence, crash-durability injection, and
  packaged interaction tests remain open.
- Portable project archives now serialize the exact Yjs document plus the project manifest in a
  size-bounded, SHA-256-protected open JSON envelope. Product controls export from a live project
  and import even when no project exists; import verifies identity and checksums, refuses project
  or document collisions and different orphaned IndexedDB state, strips the old transport binding,
  and reopens locally without an engine or network provider. Headless fake-IndexedDB reopen and UI
  contracts pass. S-04 remains `implemented_unverified` until two clean packaged installations
  complete an offline file transfer and import.
- The live MCP now advertises a thirteenth semantic tool, `inspect_research_state`. A lifecycle-
  safe registry points it at the same active Y.Doc as the editor. The tool validates heuristic
  records, immutable version hashes, project ownership, head shape, and complete ancestor lineage,
  but returns only bounded metadata summaries and no policy/guidance/edit/note bodies. Pure
  frontend, Rust routing, and compiled debug-executable stdio tests are committed; the mutation-
  capable packaged live harness is updated but was not run by this non-interactive checkpoint.
- MCP can now save the exact active semantic draft as an immutable attributed checkpoint. The tool
  requires the document revision from `read_active_project` and the current head from
  `inspect_research_state`; the document revision is rechecked inside the same final transaction
  that rechecks the head and inserts the content-addressed version. Four headless tests prove stale
  and mid-hash document changes create no version, while Rust routes the fourteenth semantic tool.
  Packaged MCP checkpoint and restore mutation now pass; authenticated participant identity remains open.
- Collaborative scenario foundations now cover lifecycle CRUD, ordered multi-turn content,
  attributed turn revisions, scenario edit history, and branch parents. Forty seeded concurrent
  field/turn-add deliveries and forty delete-versus-turn-edit deliveries converge; disconnected
  public scenario/turn ID collisions, malformed order, unknown fields, and missing parents fail
  closed. The product panel now exposes engine-free create/select/edit/status, ordered turn
  addition, and integrity-error states. Turn revision UI, generation, response variants,
  flags/notes/labels, evaluation, and portable scenario packs remain open.
- The existing `inspect_research_state` MCP self-check now reports bounded scenario metadata and
  validates scenario records plus missing/cyclic branch ancestry alongside heuristics and immutable
  history. Scenario background, turn content, and revision bodies remain excluded, and the route
  remains read-only; this improves live harness coverage without claiming scenario UI or mutation.
- Collaborative scenario voting now uses immutable, attributed vote events in peer-specific
  namespaced discussion buckets. Replay is idempotent, re-votes/withdrawals retain history,
  disconnected first votes and concurrent same-participant re-votes converge across eighty seeded
  deliveries, and conflicting event IDs or orphan targets fail closed. MCP inspection exposes only
  aggregate counts and event totals. Product vote/withdraw controls disclose that identity is unauthenticated.
- Collaborative flags and notes now use their own versioned discussion namespace and immutable
  parent-linked lifecycle events. Edit, resolve, and reopen retain historical attribution; stale
  writes reject; disconnected creation and concurrent edit-versus-resolve converge across eighty
  seeded deliveries; collisions and orphan scenario/turn targets surface in MCP integrity metadata.
  This closes P-20 domain evidence, not annotation UI, moderation, or authenticated identity.
- Collaborative context labels now use immutable create/rename and scenario add/remove events in
  separate settings namespaces. Exact-current guards reject stale writes; disconnected assignments
  and concurrent rename branches converge across eighty duplicate/reordered deliveries; filtering,
  collision, and orphan checks fail closed. This closes P-21 domain evidence, not label UI,
  authentication, moderation, MCP mutation, or remote transport.
- MCP now advertises a fifteenth semantic tool, `create_scenario`. Research inspection returns a
  monotonic Yjs revision and rejects a read that changes during validation; scenario creation
  requires that exact revision and live project identity. Pure tests prove stale zero-write and
  branch creation, while Rust/stdio/live harnesses lock the route. Turn mutation, generation, and
  turn revision editing and scenario generation remain unavailable.
- The MCP scenario surface now has seventeenth-tool coverage: `add_scenario_turn` stores one
  explicit role/content turn and `revise_scenario_turn` retains attributed immutable revisions.
  Each mutation consumes the exact research revision from inspection or the prior mutation; stale
  add/revise tests leave turn history unchanged. The live harness chains create→add→revise and
  verifies turn/revision counts through inspection without invoking a model.
- The MCP scenario surface now includes an eighteenth tool, `cast_scenario_vote`. It chains the
  exact research revision, retains support/re-vote/withdrawal history, returns aggregate counts,
  and rejects stale calls without adding events. Identity remains unauthenticated and no UI or
  evaluation claim follows from the automation route.
- Three annotation tools bring MCP discovery to twenty-one. They create scenario/turn flags or
  notes, edit bodies, and resolve/reopen while retaining immutable lifecycle history. Edit and
  status changes require both the current research revision and exact annotation event; stale
  project or lifecycle calls add nothing. Bodies remain omitted from MCP readback and no UI,
  moderation, or authenticated-identity claim is made.
- Three shared-label tools bring MCP discovery to twenty-four. They create and rename labels, then
  assign or remove them from scenarios. Every call consumes the exact research revision; rename
  and follow-up assignment also consume their exact current event. Stale project or lifecycle
  calls add nothing. Event bodies remain omitted and no label UI, moderation, or authenticated-
  identity claim is made.
- MCP now advertises a twenty-fifth semantic tool, `restore_active_policy_version`. It requires
  the exact inspected target version, live document revision, and current immutable head, then
  reuses the product's rollback-aware restore transaction to replace exact semantic blocks and
  append a new child head. The packaged live harness checkpoints a temporary divergence, restores
  the earlier checkpoint, proves exact readback and healthy bounded inspection, and proves stale
  document/head calls add no version. P-28 stays `implemented_unverified`: this is one Windows
  profile with caller-supplied attribution, not authenticated identity, crash injection,
  Drive/WebSocket convergence, or two-install evidence.
- A clean-room public literature pass now constrains the adversarial-panel roadmap: preserve
  independent/minority artifacts, blind route identity, reverse judge order, audit frozen sources,
  compare against an equal-call baseline, and never treat agreement as truth. The source list,
  derived requirements, and falsification gates are in
  `docs/audits/LITERATURE-NOTES-2026-07-15.md`; it is requirements evidence, not a quality claim.

- The LAN MCP control plane development slice keeps every GUI automation listener on loopback and
  adds a packaged outbound `Syzygy --lan-agent`, an authenticated encrypted coordinator, a stdio
  MCP host wrapper, and bounded two-node harnesses. Node and Rust tests prove challenge binding,
  directional session keys, AES-GCM tamper/replay rejection, wrong-key rejection, per-node routing,
  disconnect cleanup, and cross-language discovery of all twenty-five native tools. This is S-07
  `implemented_unverified`: the decisive two-physical-install private-LAN run is still required, and
  the control plane does not claim Yjs/IndexedDB project synchronization.

## Current completion snapshot

The machine-readable end-goal ledger currently contains **42 capabilities**: **26 are
`implemented_unverified`, 16 are `planned`, and 0 are `verified`**. MCP onboarding improves
operability and automated testing but does not close a research-workflow capability by itself.
The next product-critical gaps remain the custom editor/domain nodes, remaining crash/recovery local
lifecycle, Drive-backed Yjs convergence, optional presence, scenarios, local-AI review tools, and versioned
evaluation. The definitive contracts and gates remain in `END-GOAL-PLAN.md` and
`docs/audits/CAPABILITIES.json`.

## Next (in intended order)

Shared-folder Ask now uses remote-first Drive retrieval, including native Google
Docs/Sheets/Slides export. The local mirror remains available through explicit Sync so
collaborators are not required to download large project folders.

1. **Close the second-install Drive gate** — run the passing `npm run test:drive-live` proof from a
   second account/install and attach that evidence to S-01.
2. **Continue the Penumbra collaborative editor independently**:
   - Exact-version Lexical/Yjs packages and the initial provenance gate are now in place; continue
     authoring every node, plugin, command, schema, test, and UI here.
   - Keep domain and provider interfaces independent from editor, Drive, and AI vendors.
   - Design target: the "research editor" panel of the approved mockup (version rail,
     evaluation panel, mono metadata stamps).
3. **Certify the open research platform boundary** — the first OpenAI fake-server/key-canary
   request/stream/control gates, Windows credential-vault canary, and native one-shot disclosure
   command have landed; next build the provider settings/task workflow and streaming event bridge.
   Build the adversarial benchmark before
   claiming panel quality; implement a no-authority WASI host before loading third-party code.
4. **Real collaboration on the folder** — Yjs doc persisted in the synced folder;
   merge-on-sync instead of last-write-wins; presence later. Drive is transport #1;
   self-hosted y-websocket-compatible and P2P transports are siblings behind the same abstraction.
5. **Independent research workflows on top** — scenarios, structured policy blocks,
   heuristics, evaluation, versions, and review, designed and prompted from scratch for
   Syzygy's local model.

## Backlog (unordered)

- Sync watcher/interval instead of manual+event sync.
- Per-project Drive folders (folder picker instead of fixed "Syzygy").
- Settings surface for the updater channel / release notes display.
- macOS/Linux smoke testing (CI builds them; nobody has run them).
- Code-signing certificate (kills the "Windows protected your PC" interstitial) — cost.
- Re-link UX when Google tokens are revoked server-side.
- Trim `VisionEngine` plumbing if vision is ever dropped (currently kept + used).

## Decision log (the why behind the shape)

| Decision | Why |
|---|---|
| Fork Aphelion's shell instead of wrapping the Next app | Installer/updater/engine/file-access already proven; no mandatory Penumbra backend fits the product; optional self-hosted collaboration remains possible. |
| Penumbra-original editor | No Tiptap or PolicyPad implementation material enters Syzygy; exact-version MIT Lexical/Yjs packages are the baseline candidate and all product code is authored here. |
| Shared-folder collab before CRDT | A folder is comprehensible, debuggable, and useful alone (docs + knowledge); CRDT rides on top later. |
| Remote-first shared-folder reads + optional mirror | Collaborators avoid mandatory large local copies; explicit sync still supports offline/local workflows. |
| Google creds injected at build time | Public repo + push protection; binaries may carry them (Google: non-confidential for installed apps), plaintext repos shouldn't. |
| New Syzygy signing key (not Aphelion's) | Separate products, separate trust roots; Aphelion's private key wasn't on this machine anyway. |

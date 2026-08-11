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
- The post-0.1.10 provider/extension foundation now includes provider-neutral descriptors,
  strict plugin/proposal schemas, the public adversarial record, native content-bound
  multi-provider execution, and three resumable MCP job tools. The execution path is loopback
  conformance-tested and remains non-mutating/pending-human-review; live-provider compatibility,
  durable run UI/history, benchmark quality, persistent plugin package lifecycle, and capability-
  bearing plugin hosts remain open. The zero-import runtime now has explicit session loading,
  product/MCP execution, and shared non-applying review.
  Evidence and
  falsifiers are in `RESEARCH-EXTENSIONS.md`; APIs are in `ADVERSARIAL-API.md`,
  `PROVIDER-API.md`, and `PLUGIN-API.md`.
- The same slice adds a provider-neutral collaboration lifecycle and a deterministic two-editor
  Memory transport. Its headless suite proves bidirectional live document/domain updates,
  partition isolation, offline edits, reconnect merging, awareness cleanup, and identical final
  state. Drive adds append-only selected-workspace updates; WebSocket now adds live awareness, a
  persisted legacy or role-specific bearer-invite product binding, and an app-managed private-LAN
  relay with bounded native lifecycle, recovery storage, digest-only member capabilities, enforced
  viewer/editor/admin writes, device-bound role enrollment, and signed remote room administration.
  Successful remote mutations can now add a bounded, convergent, capability-free installation-signed
  decision to shared project history; contradictory revision claims are retained and block extension.
  This is explicitly not a relay receipt or directory-granted role. A five-client partition/reconnect
  soak now passes. A separately enrolled surviving admin can recover a lost admin member onto a
  replacement installation without private-key export/escrow; the old capability/key is denied and
  the replacement can administer. Authenticated human identity,
  recovery with no surviving admin or relay host, and packaged multi-install proof remain open.
  A bounded capability-free signed approval ledger now supplies the shared-directory prerequisite:
  registered devices can converge exact action/revision approvals, while expiry, mutation, unknown
  signers, and same-signer equivocation fail closed. The host can now install a bounded exact signer
  set and threshold. The exact relay binary refuses protected remote mutations without a valid
  project/room/revision/action-bound quorum, preserves no-policy compatibility, and rejects eight
  adversarial bundle classes plus stale replay. Product controls select registered installation
  keys, publish partial approvals into shared Yjs state, and automatically submit a completed
  quorum. Shared research-state inspection reports that host policy state is not part of the
  project rather than falsely attesting it; separate host-only MCP tools now inspect the fresh local
  room report and install/remove policy under the exact registry revision without returning member
  IDs, capabilities, public keys, storage paths, or research bodies. Packaged physical two-install
  interaction remains open.
- The first original product node is now implemented but not yet interaction-verified: a Lexical
  `PolicyBlockNode` with stable
  identity, editable text, draft/review/approved state, strict JSON import, theme-token UI, and a
  semantic MCP round-trip that preserves identity/state. The headless fixture covers add, edit,
  reorder, serialize, restore, malformed identity, partitioned concurrent edits, and connected
  reorder convergence. The first apparent reorder failure was a harness defect: it compared
  Lexical node-map enumeration rather than root document order. The corrected oracle passes and
  is documented in the run evidence. P-03 is `implemented_unverified`. The product now has one
  semantic reorder command shared by pointer controls and Alt+Shift+Arrow shortcuts, plus a live
  heading-derived outline and formatting fixtures. Policy content, inline marks/embeds, and review
  state now live in a stable ID-keyed Y.Text independently of root placement. The live bridge
  passes the former move-versus-edit partition case and separate append-only move/edit delivery in
  both orders without projecting remote changes into local undo history. Local documents migrate
  atomically and idempotently; stable Drive documents enable reorder, while checking, malformed,
  or legacy tree-only documents fail visibly closed. P-03/P-09/P-10/P-34 remain
  `implemented_unverified` pending packaged physical Drive interaction and stress/visual gates.
  Evidence: `docs/audits/runs/POLICY-REORDER-SAFETY-2026-07-31.json` and
  `docs/audits/runs/STABLE-POLICY-CONTENT-2026-07-31.json`.
- P-05 now has a Penumbra-original inline `ScenarioReferenceNode`. The toolbar inserts links from
  the live shared scenario list; persisted state contains only the stable scenario ID; current
  titles resolve reactively from the project Y.Doc; missing targets stay visible. JSON reload,
  rename-safe rendering, two-editor Yjs convergence, MCP semantic-marker round-trip, and production
  build gates pass. Immutable checkpoints now retain the reference ID set. Packaged pointer
  interaction remains unverified.
  Evidence: `docs/audits/runs/SCENARIO-REFERENCE-2026-07-17.json`.
- P-06 now has a Penumbra-original block-level `ScenarioSpotlightNode`. The toolbar embeds the
  selected scenario as a live Y.Doc projection and the card collapses back to its stable link.
  Persisted/editor/version state contains only `scenarioId`; automation round-trips the exact
  `[spotlight:<stable-id>]` marker. Undo/redo, two-editor Yjs convergence, immutable restore,
  TSX test discovery, focused suites, and production build pass. Packaged two-install pointer
  interaction remains unverified, so status is `implemented_unverified`.
  Evidence: `docs/audits/runs/SCENARIO-SPOTLIGHT-2026-07-18.json`.
- P-07 now has a Penumbra-original collaborative response-revision domain and visible product
  workspace. Researchers can create manual responses without AI, edit the exact current revision,
  retain human/model attribution and complete immutable lineage, and recover visibly when a shared
  response changes without losing their draft. Product writes and model starts recheck scenario/
  response integrity; stale saves and hostile history write nothing, while generation is refused before
  credential or provider work. Two disconnected product-controller edits survive
  as siblings and converge deterministically. Response cards page at 50 and lineage renders the 50
  most recent revisions while naming the complete retained count. Focused tests and the production
  build pass. Authenticated identity, trusted clocks, explicit sibling resolution, near-limit
  performance, and packaged physical two-client interaction remain open, so P-07 stays
  `implemented_unverified`. Evidence: `docs/audits/runs/SCENARIO-RESPONSE-2026-07-18.json` and
  `docs/audits/runs/SCENARIO-RESPONSE-WORKSPACE-2026-08-01.json`.
- P-08 now has a Penumbra-original collaborative suggestion review surface. Immutable proposals
  retain source revision and human/model provenance; accept/reject decisions retain reviewer
  snapshots and name the exact proposal event. Stale or reused identities fail before mutation,
  disconnected opposite decisions remain visible as a conflict, and proposal/decision writes do
  not apply policy text. The editor, semantic automation, immutable versions, and bounded MCP
  inspection carry only stable identity or content-free metadata. Proposal and decision events now
  have exact retained-event hashes and best-effort installation signatures with explicit unsigned
  fallback in both product and revision-guarded MCP paths; MCP never edits the draft. Focused tests
  and the production build pass. Authenticated human identity, packaged two-client interaction, and model generation
  remain open, so P-08 status is `implemented_unverified`. Evidence:
  `docs/audits/runs/SUGGESTION-DECISIONS-2026-07-18.json` and
  `docs/audits/runs/SIGNED-SUGGESTION-EVENTS-2026-08-11.json`.
- P-24 adds a distinct revision-guarded **Apply to draft** action for accepted, non-conflicted
  suggestions. A deterministic semantic fingerprint excludes review cards but detects any policy
  content change; application also requires the exact proposal, accepted decision, live editor
  revision, one marker, and a free stable policy identity. The existing controller rechecks the
  revision during replacement, and the real Lexical gate proves the card becomes one linked review
  policy block. Authenticated identity, packaged two-client interaction, MCP application, partial
  edit, and semantic-quality claims remain open, so status is `implemented_unverified`. Evidence:
  `docs/audits/runs/SUGGESTION-APPLICATION-2026-07-19.json`.
- P-11 now has a provider-neutral bounded presence model, identity-safe active-provider registry,
  installation-identity Lexical wiring, remote cursor theme, product strip, and content-free MCP
  counts. The Memory provider now exchanges real awareness packets and removal tombstones:
  connected peers disappear immediately, and a partitioned stale peer cannot resurrect presence
  after reconnect. Local and Drive modes are deliberately honest; Drive polling still synchronizes
  edits but does not claim live cursors or online status. Focused tests and the production build
  pass. A live WebSocket provider plus bundled private-LAN relay now exist. Live schema-v2 presence
  is self-signed by an OS-vault Ed25519 installation key and independently verified in WebCrypto;
  legacy, invalid, and unsupported-verifier states remain explicit, and focus changes cannot silently
  discard the proof. This proves only possession of a self-issued device key for the current bounded
  session. Verified fingerprints can now be approved, revoked, and re-approved in a bounded native
  current-state registry scoped to one installation and project. The UI explicitly denies that these
  local labels change relay access. An explicit second signature now publishes a deterministic
  project/participant/key registration into bounded shared Yjs state. Disconnected registrations
  converge and reopen offline; same-key participant conflicts stay visible; Drive/live UI and the
  read-only MCP inspection expose the exact device-only boundary; offline entries can receive local
  approval labels. The app-managed relay now separately binds an operator-issued role to an
  explicitly enrolled installation key, rejects stale/replayed connection proofs, and permits only
  that device-bound admin role to execute one fresh action-bound exact-revision room-management
  request. A repeatable five-client binary soak covers 60 rapid writes, two-client partition/rejoin,
  awareness cleanup/recovery, forced reauthentication, and remote issue/rotate/revoke. All ten
  named durable research-event domains now have exact retained-device attribution, including full
  adversarial archives and decisions, suggestion proposals/decisions, and heuristic definition,
  example, and check-result events plus scenario-rerun definitions, controls, item transitions, and
  completed results. Human identity, shared-directory approval, propagated identity revocation,
  key rotation/recovery, and physical two-install product proof remain
  open, so P-11 remains
  `implemented_unverified`. Evidence:
  `docs/audits/runs/PRESENCE-LIFECYCLE-2026-07-18.json` and
  `docs/audits/runs/SIGNED-DEVICE-PRESENCE-2026-08-11.json` and
  `docs/audits/runs/LOCAL-DEVICE-TRUST-2026-08-11.json` and
  `docs/audits/runs/SIGNED-PROJECT-DEVICE-DIRECTORY-2026-08-11.json`.
  Signed suggestion-event adoption is recorded in
  `docs/audits/runs/SIGNED-SUGGESTION-EVENTS-2026-08-11.json`.
  Signed heuristic definition/example/check-result adoption is recorded in
  `docs/audits/runs/SIGNED-HEURISTIC-EVENTS-2026-08-11.json`.
  Signed scenario-rerun adoption is recorded in
  `docs/audits/runs/SIGNED-SCENARIO-RERUN-EVENTS-2026-08-11.json`.
- P-16 now connects selected scenarios to one bounded provider-neutral response contract. Local
  generation uses the optional loopback model; OpenAI, Anthropic, Gemini, and xAI reuse the native
  Send once boundary. Output enters the existing collaborative response lineage only when the exact
  scenario revision is unchanged. Hostile envelopes, cancellation, local-AI-off behavior, remote
  task construction, separate concurrent variants, focused UI, and production build gates pass.
  Live paid-provider proof, response editing/regeneration, and quality claims remain open, so status
  is `implemented_unverified`. Evidence:
  `docs/audits/runs/SCENARIO-GENERATION-2026-07-18.json`.
- P-17 adds non-destructive regeneration on top of that contract. The exact current response
  revision becomes bounded provider context and the result is appended as its attributed child;
  prior and concurrent sibling variants remain inspectable and converge. Stale response heads and
  cross-scenario parents fail before mutation. The product exposes Regenerate plus complete collapsed
  lineage. Historical-parent selection, sibling conflict resolution, live-provider proof, and quality
  claims remain open, so status is `implemented_unverified`. Evidence:
  `docs/audits/runs/SCENARIO-REGENERATION-2026-07-18.json`.
- P-18 adds collaborative positive and negative examples to the shared heuristic domain. Immutable
  peer-namespaced add/removal events preserve attribution, replay safely, retain concurrent exact-
  parent removals, and converge after disconnected positive/negative additions. Hostile records,
  reused identities, and colliding roots fail closed. The engine-free product surface creates and
  selects heuristics, adds/removes attributed examples, and exposes accessible failure states; MCP
  inspection returns content-free counts and integrity only. Packaged two-install interaction,
  authenticated identity, semantic quality, and evaluation remain open, so status is
  `implemented_unverified`. Evidence: `docs/audits/runs/HEURISTIC-EXAMPLES-2026-07-19.json`.

- P-26 adds a provider-neutral explainable heuristic checker over an exact bounded snapshot of the
  current semantic policy, selected enabled heuristic, and active positive/negative examples. Local
  and four native Send-once API routes share one strict pass/fail/uncertain contract; rationale and
  uncertainty are mandatory, every cited quote/UTF-16 span is verified, malformed output gets one
  repair attempt, and cancellation or stale policy/heuristic/example revisions add nothing. Results
  are immutable, attributed, peer-namespaced collaborative records with provider/model/run/source
  provenance. Product UI shows the complete evidence; MCP inspection returns only counts/integrity.
  Live paid-provider proof, semantic/model quality, authenticated identity, manual verdict override,
  and packaged two-install interaction remain open, so status is `implemented_unverified`. Evidence:
  `docs/audits/runs/HEURISTIC-CHECKER-2026-07-19.json`.

- P-30 adds a persistent versioned scenario-evaluation queue. Each job freezes one verified
  immutable policy version, exact scenario revisions, one provider/model route, unique execution
  identities, and at most 200 items/three attempts under aggregate bounds. Peer-namespaced strict
  events persist begin before provider work, commit result plus completion atomically, reject forks
  and identity reuse, and reopen interrupted attempts without rerunning completed items. The
  sequential runner has 30-second progress heartbeats and a hard two-minute item deadline; pause,
  cancel, explicit retry, local-off behavior, and local/OpenAI/Anthropic/Gemini/xAI routing are
  product-visible. Remote items retain native Send once approval. MCP inspection exposes only
  counts/integrity and omits every research/result body. Live-provider quality, authenticated
  identity, and packaged two-install crash/convergence remain open, so status is
  `implemented_unverified`; portable interchange is proven separately by P-33. Evidence:
  `docs/audits/runs/SCENARIO-RERUN-QUEUE-2026-07-19.json`.

- P-31 adds a deterministic side-by-side comparison over two distinct completed P-30 queues. It
  requires the same project, document, prompt version, scenario IDs, and byte-exact scenario
  revisions, then derives a neutral nine-cell handled/unhandled/uncertain transition matrix without
  claiming improvement or truth. The product shows full response/rationale/uncertainty evidence and
  explicitly saves a bounded open JSON artifact containing both verified policy snapshots, exact
  scenario revisions, model/run/attribution, explicit unavailable seed/sampler/model-hash fields,
  and policy/revision/artifact SHA-256 checks. Strict Draft 2020-12 plus runtime verification rejects
  unknown fields, identity/route mismatch, tampering, noncanonical order, and inconsistent summaries.
  MCP inspection exposes only compatible-pair count. Live-provider reproducibility, authenticated
  identity, semantic-quality judgment, and packaged interaction remain unproven, so status is
  `implemented_unverified`. Evidence: `docs/audits/runs/SCENARIO-COMPARISON-2026-07-19.json`.

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
  The adapter is labeled `request-stream-and-schema-validated-tool-proposal-conformance`; its scoped frontend streaming
  bridge and bounded non-executing custom-function proposal lifecycle have landed. Complete
  proposals now receive safe-subset schema valid/invalid/missing-definition status while domain
  review remains unreviewed and execution remains false. Tool execution,
  slow-consumer stress, and opt-in live-provider proof remain gates before
  broader availability.
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
  `contract-certified`, never runtime-safe; plugin discovery, install, permission-broker product
  persistent lifecycle and capability-bearing interfaces remain open. The zero-authority product
  composition and review surface are described below.
- The non-executing plugin authority broker now enforces explicit grant subsets in 15-minute
  sessions, detached bounded project snapshots, pending revision-guarded proposals, selected-Drive
  identity, granted HTTPS host patterns, and configured model providers. It returns decisions only:
  no package loader, fetch, provider call, Drive call, or mutation is wired. The separate
  zero-import component executor has no route to these decisions; install lifecycle,
  DNS/redirect enforcement, UI, native-MCP hosting, and composition tests remain open.
  Evidence: `docs/audits/runs/PLUGIN-AUTHORITY-BROKER-2026-07-15.json`.
- The public `syzygy:research/plugin@1.0.0` WIT world now has zero host imports and one bounded
  invocation/output surface. Tests reject ambient fields, duplicate sources, cyclic/oversized
  envelopes, direct mutation, and malformed proposals; pinned upstream `wit-parser` resolves one
  zero-import/one-export world. Rust now inspects and instantiates that exact world with an empty
  linker, explicit top-level import denial, 8-MiB component/1-MiB envelope/32-MiB memory limits,
  200-source/32-proposal bounds, fixed fuel, a two-second epoch deadline, and exact output identity/
  revision checks. Every invocation runs in a hidden one-shot child under a five-second parent
  kill-and-reap deadline. The Windows hostile-fuel fixture may abort the worker; the integration
  proof requires the parent and a clean successor to survive. MCP reports
  `zero-import-subprocess-runtime-bounded`. Package discovery/install/upgrade, authority-broker
  product composition, UI, useful third-party artifacts, and every capability-bearing WIT world
  remain open.
  Evidence: `docs/audits/runs/PLUGIN-WIT-CONTRACT-2026-07-15.json` and
  `docs/audits/runs/PLUGIN-ZERO-AUTHORITY-RUNTIME-2026-08-11.json`.
- Researchers can now explicitly select one exact manifest/component pair into a bounded in-memory
  session registry, inspect requested versus active baseline authority, and run a contribution from
  the product or MCP. SHA-256 is recomputed before execution; only project read/propose can activate.
  Valid output becomes one preflighted shared Yjs proposal batch. Human accept/reject decisions
  converge, expose conflicts, and never apply the draft. MCP can inspect metadata and run only an
  already-user-loaded package with exact document/research revisions. Persistent install/upgrade/
  signing, a useful executable example, capability-bearing worlds, decision signatures, and Apply
  remain open. Evidence: `docs/audits/runs/PLUGIN-SHARED-REVIEW-2026-08-11.json`.
- The adversarial protocol now has an executable run-record validator and synthetic benchmark
  fixture. Eight tests enforce blinded artifacts, complete candidates/critiques, claim-level source
  audits, planned reversed judge order, equal actual call budgets, supported-minority retention,
  finite accounting, prohibited hidden reasoning, and revision-guarded human acceptance before
  mutation. This validates evidence structure, not multi-model quality; model-call orchestration,
  real benchmark fixtures, statistics, and any superiority claim remain open.
- Adversarial run record v1 is now a public strict Draft 2020-12 schema, embedded in the headless
  MCP platform contract and checked for drift against the typed valid fixture. Structural schema
  success is explicitly separate from plan-relative semantic validation and any quality claim.
- The adversarial protocol now has a native product executor behind one content-bound batch
  approval. For `N` participants it freezes `N` proposals, `N` cyclic critiques, one audit,
  two reversed-order judgments, and a `2N + 3` call baseline. Exact question/source bytes,
  routes, dependencies, presentation order, timeouts, output ceilings, and budgets are authorized
  together. Rust atomically consumes calls, verifies prior-output hashes, derives prompts, uses the
  OS vault/fixed endpoints, and records only validated outputs as dependencies. Loopback tests prove
  transport, forgery rejection, concurrency, duplicate refusal, malformed-output consumption, and
  secret/content/token exclusion.
- Three MCP tools bring semantic discovery to 32 tools: start returns a revision-guarded job
  immediately from selected live blocks, inspect polls bounded state/result, and cancel reaches the
  native provider call. Jobs heartbeat every 30 seconds, abort at 15 minutes, expire after one hour,
  and never mutate shared work. At that checkpoint durable product history/UI was still open;
  the later collaborative-history and product-workflow slices below close it. Packaged native-dialog
  proof, live provider evidence, public fixtures/statistics, and any superiority claim remain open.
  Evidence: `docs/audits/runs/ADVERSARIAL-NATIVE-EXECUTION-2026-07-29.json`.
- Anthropic Messages now has `request-stream-and-schema-validated-tool-proposal-conformance`. Fake servers prove the
  current `/v1/messages` path, `x-api-key`, pinned API version, system/user mapping, bounds,
  normalized text/cumulative usage, thinking-body non-retention, sanitized failure, timeout,
  cancellation, SSE lifecycle/terminal ordering, partial-JSON tool assembly, exact safe-subset schema validation, and product review
  routing. Tool execution/result continuation, packaged-dialog interaction, and live proof remain open; the shared
  adversarial product workflow continues to route bounded Anthropic calls.
- Gemini Interactions now has stable-v1 `request-stream-and-schema-validated-tool-proposal-conformance`. Fake servers
  prove header auth, storage/background off, thought-summary suppression, system/user mapping,
  output bounds, text-only retention, consistent aggregate usage, sanitized failure, timeout,
  cancellation, indexed SSE step lifecycle, complete function-call proposal normalization/schema validation, and
  product review routing. Tool execution/result continuation,
  thought-signature continuation, packaged-dialog interaction, and live proof remain open.
- xAI Responses now has `request-stream-and-schema-validated-tool-proposal-conformance`. Fake servers prove storage-off/
  no-threading request shape, bearer auth, event-stream negotiation, bounded fragmented delivery,
  terminal ordering, controls, product review routing, documented whole function-call proposals with schema validation, and mandatory
  boolean ZDR attestation before dispatch without confusing standard retention with enterprise ZDR.
  Tool execution/result continuation, encrypted reasoning/WebSocket continuation, packaged-dialog interaction, and live
  policy/rate/cost proof remain open.
- Provider-neutral tool-proposal bounds, cross-provider lifecycle mapping, hostile malformed/
  incomplete fixtures, inspect-only UI, authority exclusions, and explicit non-claims are recorded
  in `docs/audits/runs/PROVIDER-TOOL-PROPOSALS-2026-08-11.json`.
- The safe JSON Schema subset, cross-language valid/invalid/missing-definition results, bounded
  diagnostics, and explicit domain-unreviewed/executable-false state are recorded in
  `docs/audits/runs/PROVIDER-TOOL-SCHEMA-VALIDATION-2026-08-11.json`.
- A strict public provider-run record now captures content-free call provenance, disclosure,
  destination, dated policy, storage/ZDR state, terminal outcome, usage, and cost. Its semantic
  validator and MCP embedding are implemented; the Rust task command now emits authoritative
  records, while workflow persistence and live-provider evidence remain open.
- Custom compatible model adapters now have strict profile/certification schemas, a non-executing
  package runner, hostile profile fixtures, exact endpoint probes, and a documented local-vLLM
  example. Runtime transport and credentials remain `contract-only`.
- The built-in provider task bridge proves vault lookup, fixed-endpoint dispatch, sanitized
  normalized output, disclosure denial without network contact, and Rust-authored content-free
  provenance. Generation always asks through a Rust-owned native **Send once** dialog; approval is
  absent from the request, and denial is proven to avoid both vault reads and network. The public
  request carries a structured question plus labeled source snapshots; Rust derives disclosure
  categories and unique provenance IDs from those same bytes. All four built-in remote providers use
  a scoped ordered Tauri channel, bounded Rust accumulator, shared timeout/cancellation registry, and
  incremental transient workspace result. No result automatically mutates shared work.
  Fake-network, reducer, UI, and non-claim evidence is in
  `docs/audits/runs/REMOTE-PROVIDER-STREAMING-2026-07-20.json`; native disclosure and envelope
  evidence remain in `NATIVE-PROVIDER-DISCLOSURE-2026-07-15.json` and
  `PROVIDER-RESEARCH-ENVELOPE-2026-07-15.json`.
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
  closed. The product panel exposes engine-free create/select/edit/status plus manual ordered-turn
  creation and exact-current revision editing. Stale drafts remain visible but cannot write; sibling
  revisions remain retained and converge deterministically; conversation and lineage views are bounded
  to 50 items. Authenticated identity/time, explicit branch reconciliation, packaged interaction, and
  physical two-install reconnect proof remain open.
- P-33 adds a strict checksummed open scenario-pack codec and product workflow. Selected exports include
  required ancestors and preserve ordered turns plus complete revision/edit attribution; import validates
  the public Draft 2020-12 schema semantics, checksum, canonical history, and closed graph before one
  atomic collision-safe Yjs transaction. Exact duplicates are idempotent. A CC0 sample pack and MCP-
  discoverable schema support independent readers; packaged OS file-dialog and third-party interop remain
  unverified. Evidence: `docs/audits/runs/SCENARIO-PACKS-2026-07-19.json`.
- P-22 now proves the real scenario domain graph—not placeholder objects—survives portable export,
  local import persistence, and disconnected IndexedDB reopen. A root, sibling branches, a nested
  branch, workflow state, ordered turns, and immutable turn/edit attribution round-trip exactly.
  Missing-parent integrity failures also survive instead of being laundered. Packaged two-install
  interaction remains open, so status is `implemented_unverified`. Evidence:
  `docs/audits/runs/SCENARIO-BRANCH-ARCHIVE-2026-07-19.json`.
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
  The product now creates scenario/turn notes or flags, edits open bodies, resolves/reopens lifecycle
  history, pages large projections, and rechecks integrity before each write. Moderation,
  notifications, authenticated identity, trusted clocks, and packaged two-install interaction remain open.
  Evidence: `docs/audits/runs/SCENARIO-COLLABORATION-CONTROLS-2026-07-31.json`.
- Collaborative context labels now use immutable create/rename and scenario add/remove events in
  separate settings namespaces. Exact-current guards reject stale writes; disconnected assignments
  and concurrent rename branches converge across eighty duplicate/reordered deliveries; filtering,
  collision, and orphan checks fail closed. The product now creates and renames project labels and
  assigns/removes them on the selected scenario with exact-parent conflict refusal and bounded paging.
  Authentication, moderation, trusted clocks, and packaged remote interaction remain open.
  Evidence: `docs/audits/runs/SCENARIO-COLLABORATION-CONTROLS-2026-07-31.json`.
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

- The LAN collaboration follow-up makes the outbound agent an opt-in installed-app setting, stores
  only routing metadata/key-file path, restarts it on launch, and reaps it on disable, reconfigure,
  or shutdown. The repository host also supervises its primary packaged agent with bounded backoff.
  Three MCP tools expose exact bounded Drive catalog/share/join actions; share requires the current
  document revision and join refetches exact workspace/project/document identity before registration.
  Two explicit MCP reads now provide a bounded scenario traversal chain while broad inspection stays
  body-free: `read_scenario` returns one background plus ordered turn identity/head/tip metadata,
  then `read_scenario_turn_revision` returns one chosen selected-head, named, or indexed body. The
  two-minute physical harness now requires both nodes and all 46 current tools. It discovers the turn on
  both installations, reads both simultaneous scenario siblings, requires the same head/tip set,
  appends one exact all-parent reconciliation, requires the four-revision merge on both nodes, and
  rejects stale document and scenario writes with boolean-only output. Component, Rust, MCP, and synthetic host gates pass;
  S-07 stays `implemented_unverified` until this build is installed on both profiles and the physical
  harness produces its evidence record. Conflict-safe shared-project rename now appends
  content-addressed parent-linked title events, retains simultaneous siblings, exposes exact product
  and MCP reconciliation, and extends the physical harness with two-way propagation, stale rejection,
  and restoration. Its deterministic gates pass; packaged two-install execution remains open.
  Shared-project catalog refresh is now supervised end-to-end: selected and cross-workspace reads
  cancel after 12 seconds, run at most eight project-detail requests per root, keep roots serial,
  and fail before the 15-second live automation bridge budget. Rust proves cancellation drops stale
  work and the structural audit locks the MCP timeout ordering; real large-account/quota behavior
  remains unverified.
  Presence and non-Drive transports remain open.

- The app-owned LAN developer-host slice removes the primary PowerShell babysitting requirement. A
  Settings toggle now persists and supervises the embedded coordinator, starts it before the local
  outbound agent, and stops the agent before a graceful coordinator drain with a bounded kill-and-reap
  fallback. The coordinator adds a pairing-key-authenticated loopback MCP attachment; the repository
  host attaches to it without binding a duplicate server. A headless lifecycle harness proves wrong-key
  rejection, MCP negotiation, process exit, and release of both listener ports. Physical proof remains
  pending until this build is installed on both office computers.
- The outbound LAN diagnostics slice closes a false-positive status path: a living retry-loop process
  is no longer called connected. Rust consumes bounded sanitized handshake events, reports
  connected/retrying timestamps and counts, supervises crash restart every two seconds, and exposes
  an immediate reconnect command through the single typed frontend boundary. Focused Rust/UI tests
  and the production frontend build pass. The 2026-07-18 physical probe still found only
  `office-primary` on v0.1.19; `office-secondary` and the physical convergence gate remain open.

- S-06 now publishes a strict eight-feature network-boundary manifest, product Settings summary,
  complete production URL-origin classifier, adversarial redaction tests, sanitized proof artifact, and
  MCP discovery. It catches stale local-only copy and any new unclassified literal origin. Runtime packet
  capture, DNS/CDN behavior, SDK internals, and live paid-provider calls remain unproven, so the honest
  status is `implemented_unverified`. Evidence: `docs/audits/runs/NETWORK-BOUNDARIES-2026-07-20.json`.

- The adversarial workflow now has an explicit durable collaboration boundary. Completed jobs
  remain transient until `save_adversarial_review` stores the full canonical question, selected
  source excerpts, results, baselines, and content-free provider provenance in the existing Yjs
  discussions namespace against the exact research revision. `decide_adversarial_review` appends
  immutable exact-parent accept/reject events and never edits policy text. Identical peer archives
  converge; conflicting archives or decision branches remain visible and fail closed; hostile
  records and stale writes add nothing; routine MCP inspection omits all research and note bodies.
  Both archive and decision paths now commit first and then best-effort sign their exact retained
  body under the stored participant's unconflicted registered installation key. Product and MCP
  report signed-device or explicit unsigned attribution; signing failure never rolls back history,
  cross-author claims and changed retained bodies fail verification, and MCP returns the
  post-attribution research revision.
  The product now reuses that exact job and ledger: researchers select exact draft blocks, configure
  two to eight panel routes plus judge/baseline, see the deterministic total call count, cancel the
  bounded job, separately share full content, inspect frozen evidence/provenance/baselines, and append
  accept/reject history. Conflicts stay visible and no action edits the draft. This closes the
  headless plus product workflow implementation slice. Evidence categories now stay out of the
  DOM until opened and advance in deterministic 50-item pages. Remaining gaps include authenticated
  identity, packaged two-install interaction, live-provider proof, near-32-MiB decode/memory and
  usability evidence, benchmark quality, and a separate revision-guarded proposal/apply workflow.
  Evidence: `docs/audits/runs/ADVERSARIAL-PRODUCT-WORKFLOW-2026-07-30.json`,
  `docs/audits/runs/ADVERSARIAL-EVIDENCE-PAGING-2026-07-31.json`, and
  `docs/audits/runs/SIGNED-ADVERSARIAL-REVIEW-EVENTS-2026-08-11.json`.

- Scenario turn history now uses schema v2: every turn persists one selected head, every revision
  persists its parent set and source, and projection derives the complete acyclic tip set. Concurrent
  exact-parent edits remain visible siblings; ordinary edits stop until an exact all-tip merge is
  appended. The engine-free UI exposes explicit sibling selection without deleting alternatives,
  and MCP discovery now exposes 42 tools including `reconcile_scenario_turn`, revision-guarded
  `compact_drive_project`, exact-guard `retain_drive_title_history`, and bounded title-repair jobs. Valid v1 IndexedDB,
  Drive, project-archive, and scenario-pack histories migrate deterministically; malformed/future
  records fail before the first migration write. Headless domain, provider, archive, schema, Rust,
  stdio, and structural gates pass. A packaged physical two-install merge remains unverified and is
  required before this collaboration slice can move beyond `implemented_unverified`.

## Current completion snapshot

The machine-readable end-goal ledger currently contains **42 capabilities**: **42 are
`implemented_unverified`, 0 are `planned`, and 0 are `verified`**. MCP onboarding improves
operability and automated testing but does not close a research-workflow capability by itself.
The next product-critical gaps remain the custom editor/domain nodes, remaining crash/recovery local
lifecycle, Drive-backed Yjs convergence, optional presence, third-party scenario-pack interoperability,
cross-platform packet capture, and live-provider certification. The definitive contracts and gates remain in `END-GOAL-PLAN.md` and
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
   request/stream/control gates, Windows credential-vault canary, native disclosure, provider
   settings/task workflow, scoped OpenAI/Anthropic/Gemini/xAI streaming event bridge, and bounded
   proposal-only tool normalization and safe-subset schema-validation proof have landed; next add
   opt-in live/provider-policy evidence and explicit domain/authority design before any tool-result loop.
   Build the adversarial benchmark before claiming panel quality. The no-authority component host
   now composes user-selected session packages with project-only grants and shared human proposal
   review. Next add persistent signed package install/upgrade/rollback, a useful independently built
   third-party artifact, registered-device review attribution, and a separate revision-guarded Apply
   workflow before introducing any capability-bearing world.
4. **Harden collaboration beyond the first Drive transport** — append-only Yjs Drive sharing,
   share/join UI, deterministic partition convergence, a real Drive canary, persistent outbound LAN
   agents, guarded MCP catalog/share/join tooling, and exact scenario sibling reconciliation have
   landed. Snapshot-first bounded compaction is now an explicit product and MCP action: it archives
   only applied records into a recoverable Drive folder, keeps concurrent/partial records active,
   and has clean-install convergence and retry fixtures. Conflict-safe shared rename has also landed
   as a bounded append-only event graph with visible siblings, stale-draft refusal, exact all-tip
   reconciliation, product/MCP controls, and a two-way physical harness extension. Shared-title
   retention now canonicalizes the complete validated graph into an immutable content-addressed
   snapshot before recoverably archiving observed title events/superseded snapshots; exact guards,
   concurrent children, partial retry, 200-record/eight-request movement, 5,000-event/4-MiB bounds,
   product counts, and a dedicated MCP action are headlessly covered. Retained-title recovery now
   inspects active, archived, and quarantined history under an exact content fingerprint, reconstructs only the
   maximal parent-complete graph, appends its canonical snapshot before any move, quarantines invalid
   active records without deletion, leaves invalid archive/quarantine records untouched while allowing
   later-valid parent-complete quarantine to re-enter a canonical snapshot, and exposes four-slot
   30-second-heartbeat background jobs to MCP so the 15-second live bridge never owns the mutation.
   The first self-hosted non-Drive protocol/provider spine has now landed separately: stable-Yjs-13
   `y-websocket` is composed with local IndexedDB and live awareness behind the provider-neutral
   capability contract. A real two-client loopback harness proves relay restart, partition
   convergence, awareness propagation, stale-presence cleanup, and process reaping without claiming
   relay persistence. Next: run and record the packaged two-install Drive convergence/reconciliation/
   title harness, large-account catalog latency, and real-Drive update/title compaction plus
   interruption repair. WebSocket bindings now persist through store v7; explicit advanced product
   controls create/join/leave bounded v1 legacy, v2 managed-member, v3 expiring/rotatable bearer,
   and v4 device-bound invitations; connection state is visible, offline
   archives redact the live binding, CSP/network copy is activated, and a real relay harness proves
   two provider instances plus one IndexedDB destroy/reopen. The app-managed private-LAN relay is now
   a bundled Syzygy child with saved enable/listen/port settings, supervised restart, graceful
   shutdown plus listener-release verification, and bounded document-sync recovery logs that exclude
   awareness. A native-executable harness proves all-source-client exit, process restart, server-only
   recovery into an empty client, product-provider compatibility, and listener reuse. Managed rooms
   now store only member-capability SHA-256 digests, enforce viewer/editor/admin document writes,
   require exact-revision issue/revoke operations, restart to reauthenticate every connection, and
   leave unregistered rooms in explicit legacy mode. The native harness rejects missing, wrong, and
   revoked credentials, proves viewer updates neither propagate nor persist, and runs the managed
   invitation/provider flow. Managed v3 invitations now add an explicit capability generation and
   optional one-hour/24-hour/seven-day/30-day/operator-unbounded expiry while keeping v2 readable.
   Host-local exact-revision rotation preserves member ID/role, replaces only the digest, restarts
   every connection, and exposes the only replacement invitation once; the native harness proves
   expiry denial, old-capability denial, retained-state recovery, and real v3 provider reopen. A first
   identity foundation now gives each installation an OS-vault Ed25519 key and signs only bounded
   ephemeral presence. Cross-language mutation tests pass, and a local project-scoped registry now
   labels verified fingerprints approved or revoked without changing relay access. Managed member
   credentials can now be bound by the relay operator to an explicit public installation-key
   enrollment. The native relay checks a typed Ed25519 claim over the room/member/capability/
   generation/timestamp/nonce, consumes it once under a one-minute window, and the product creates a
   fresh proof on reconnect. Keys remain self-issued; an explicit signed project directory keeps device registrations available
   offline and exposes participant-claim conflicts, but local decisions are neither shared nor
   authoritative, awareness-proof replay and participant-ID impersonation remain possible. A
   separate bounded exact-hash attestation ledger now signs MCP-created and product-created scenario
   create/edit/status records, turn create/edit/reconciliation, vote, annotation lifecycle, label
   lifecycle/assignment, immutable policy save/restore events, and adversarial archive/decision events
   when the installation is an unconflicted registered device for the participant claim; inspection
   re-resolves the live event hash and retained author, rejecting cross-author claims, and omits proof
   and research bodies or label names. Signing failure is explicitly unsigned and never rolls back
   the mutation or checkpoint. Suggestion, heuristic, and scenario-rerun adoption now complete the
   exact retained-state resolver set for all ten named research-event domains. Device-bound admin credentials now expose a strict reserved
   control channel: the relay consumes the ordinary fresh proof, verifies a second action/revision
   signature, durably mutates/reloads membership, and evicts room peers. The product exposes those
   controls on a remotely hosted project only for the enrolled admin installation. A repeatable exact
   binary soak proves five clients, 60 rapid writes, two-client partition merge, viewer reconnect,
   awareness recovery, replay/stale-revision denial, forced reauthentication, and remote issue/
   rotate/revoke. A surviving-admin recovery gate now rotates the lost original admin onto a
   replacement installation, denies the lost binding, and proves the replacement can administer
   without private-key export or escrow. The shared project now has an exact-revision signed
   approval ledger with convergence/equivocation/expiry gates. A host-installed 1-16 signer policy
   and bounded threshold are persisted in the relay registry; protected remote mutations require
   exact configured proofs, while absent policy remains compatible and the host retains emergency
   local authority. Product controls configure the policy and publish/collect/submit exact
   approvals; the deterministic exact-binary gate covers quorum success, eight adversarial bundle
   rejections, and stale replay. Host-only MCP automation now reads authoritative content-minimized
   policy state and applies an exact-revision install/remove transition using eligible registered
   key IDs. Next: run packaged physical two-install policy interaction, then
   recovery when no admin survives (which still requires the relay host), device-key
   rotation/recovery, trusted time and replacement-invitation
   delivery, public WSS operations, compaction/export/backups
   and broader abuse controls, then run packaged physical two-install gates.
   The v0.1.13 hotfix kept shared-project discovery reachable from every active-project state.
   v0.1.14 added same-name folder codes and the bounded MCP/LAN diagnostic; the two-physical-install
   run then proved the client had no selected workspace rather than a failed project upload.
   v0.1.15 added bounded cross-workspace discovery and exact-parent Join. The current follow-up makes
   Drive setup globally reachable, separates live sharing from offline-copy handoff, and removes
   manual secondary-agent babysitting. Physical Join/convergence still decides the gate. Self-hosted
   y-websocket-compatible and P2P transports remain siblings behind the abstraction.
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

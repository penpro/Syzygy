# Threat model

**Baseline:** 2026-07-14. This is a living Phase 0 inventory, not a completed security claim.

## Assets

Local research, prompts/responses, Drive refresh token, selected workspace content, downloaded
models, collaborative state, participant identity, updater signing trust, and future immutable
versions/evaluation evidence.

## Trust boundaries

1. React webview ↔ typed Tauri commands.
2. Rust core ↔ local filesystem.
3. Webview ↔ loopback llama.cpp.
4. Rust core ↔ Google OAuth/Drive over TLS.
5. Updater ↔ GitHub signed release metadata.
6. Local IndexedDB provider ↔ Yjs/domain state.
7. Future Drive/WebSocket collaboration provider ↔ local Yjs/domain state.
8. Local MCP process ↔ authenticated loopback bridge ↔ live webview state.
9. Future Rust provider adapters ↔ remote model APIs and OS credential storage.
10. Future WASI/native-MCP plugin runtimes ↔ permission broker ↔ project/Drive/model services.

## Current threats and controls

| Threat | Current control | Residual risk / next test |
|---|---|---|
| Webview reads arbitrary local path | Canonical `Granted` allowlist | Junction/symlink race tests needed |
| Webview obtains OAuth token | Token/access exchange remains Rust-only; command removed | Audit every new Drive wrapper |
| Broad Drive token reads outside workspace | Descendant enumeration and selected-folder config | Application boundary can regress; add hostile-ID tests |
| Legacy scope yields empty evidence and model hallucinates | Collaboration access gate; Shared Ask fails closed | Live re-link harness outstanding |
| Malicious Drive text prompt-injects model | Text is labeled evidence; model has no ambient commands | Injection fixture and proposal-only AI contract needed |
| Oversized/nested Drive workspace exhausts resources | 2,000-file and 12-level direct-read bounds | Measure bytes/API calls and add attachment limits |
| Transcript leaks a local conversation | Shared toggle is explicit and UI copy names logging | Per-message inclusion controls are future work |
| Mirror conflict loses edits | Current LWW mirror documented as optional | Never use LWW for CRDT state; Phase 4 convergence tests |
| Corrupt or future local project state loads as trusted content | Manifest parser rejects malformed/unknown schema versions; migrations are idempotent | Fuzz Yjs payloads, archive bombs, unknown node types, and interrupted IndexedDB writes |
| A peer or plugin rewrites an immutable policy checkpoint | Versions are canonical bounded strings keyed by SHA-256; every read reparses, re-canonicalizes, and rehashes, and returns detached data | A malicious peer can make a hash entry unavailable by replacing it; future signed/exported archives and transport recovery must detect and repair denial-of-service without accepting mutation |
| A collaborator's display-name change rewrites historical attribution | Each version hashes both stable participant ID and display-name-at-save into its immutable envelope | Participant identity is caller-supplied and not yet authenticated across installs; Phase 3 identity enrollment remains open |
| Restore rewrites history or a stale client silently replaces a newer head | Restore copies a verified target into a new hash whose parent is the exact expected head; expected head and parent bytes are rechecked before the single Yjs transaction writes version plus head | Concurrent valid commits create branches and one deterministic visible head; product UI must expose/reconcile non-head branches instead of hiding them |
| AI-generated change notes conceal or hallucinate edits | The baseline diff and count note compare verified structured blocks locally with no engine/network dependency | Current non-policy blocks lack stable IDs, so changed prose can appear as remove/add; richer semantic notes must remain optional and cite the deterministic diff |
| Local provider is mistaken for real-time collaboration | UI says local persistence; Drive/presence controls remain disabled | Two-editor and two-install provider-contract gates must pass before collaboration claims |
| Path traversal through Drive filename | Direct reads are in memory; mirror joins remote names | Sanitize/reject separators before mirror writes |
| OAuth token stolen from app data | OS user boundary; no webview exposure | OS credential vault/encryption evaluation needed |
| Malicious update | Tauri updater signature and separate Syzygy key | Protect/back up signing key; clean-machine update tests |
| Diagnostics leak research/token | Typed invoke logger records command/error only | Automated canary/redaction tests needed |
| LAN or website pilots the live app | Ephemeral IPv4 loopback bind, random 256-bit bearer, browser-origin rejection, bounded HTTP parser | Verify OS firewall/listener state and hostile browser preflight on each platform |
| MCP overwrites a collaborator's newer draft | Every document write requires the exact revision from a prior live read | Revision is editor-state optimistic concurrency, not yet an attributed review/approval workflow |
| MCP integrity inspection leaks large research bodies or gains mutation authority | `inspect_research_state` returns at most 200 metadata summaries per collection, omits policy/scenario/guidance/edit/note bodies, routes to a read-only validator, and tests use secret canaries | Titles, scenario status/lineage, participant display names, IDs, and timestamps remain visible metadata to the already-connected local MCP host; response-size and timing budgets need packaged large-project proof |
| MCP inspects a stale or wrong collaboration document | Provider connect/disconnect registers by project and document identity; old strict-mode cleanup cannot remove a newer registration; inspection rechecks metadata project ID | Abrupt webview/provider failure may leave process-local state until teardown; packaged navigation/reopen churn proof remains open |
| MCP checkpoints a stale draft or attaches it to the wrong history head | Save requires the exact live document revision and expected immutable head; editor revision is checked before hashing and again inside the final transaction that also rechecks head/parent bytes | Lexical revision is process-session scoped and the participant identity is caller-supplied; packaged concurrent-edit proof and authenticated cross-install identity remain open |
| MCP creates a scenario from stale research state or in the wrong project | Inspection returns a monotonic Yjs state-vector revision; creation rechecks exact revision and live metadata project ID before one synchronous domain transaction; stale harness asserts zero writes | Participant identity/time are unauthenticated, and future asynchronous/multi-step mutations need transaction-local revision rechecks |
| MCP silently overwrites a collaborator's scenario turn | Add/revise consume the exact monotonic research revision; stale requests fail before mutation; revise appends an immutable attributed alternative instead of replacing history | The deterministic current turn uses caller time/event ID; authenticated identity, trusted clock policy, and branch-reconciliation UI remain open |
| Stale MCP descriptor targets the wrong process | Descriptor includes schema/PID/version; connection and per-process token fail closed; normal shutdown removes it | Abrupt termination leaves a harmless stale descriptor until the next GUI launch; add PID liveness cleanup |
| Same-user malware steals the MCP token | User-local temp ACL (and `0600` on Unix); token rotates every GUI process | Not a same-user sandbox; evaluate OS named pipes/peer credentials before exposing higher-risk tools |
| Generated MCP instructions point to the wrong binary | UI and `syzygy_installation` share Rust `current_exe` discovery; JSON/TOML path-with-spaces tests run against the real binary | Reinstall/move can invalidate configuration; the guide tells users to regenerate it from the running app |
| Contract scaffolding is mistaken for a working feature | MCP separates adapter conformance, `native-disclosure-research-envelope` task runtime, `native-disclosure-command-no-product-ui` aggregate status, and truly `contract-only` runners | The registered command still lacks a product caller and live-provider evidence; update availability only with the named end-to-end evidence |
| Fake-network record falsely names a production destination | Provider-run schema has an explicit `loopback-conformance` marker; semantic validation requires literal loopback in that mode and HTTPS otherwise; Rust→TypeScript harness validates the actual serialized record | Marker establishes test environment only, not live compatibility or provider policy behavior |
| Remote provider key leaks into webview/project/log/MCP | Masked uncontrolled input, immediate field clearing, no React/store persistence, redacted zeroizing Rust secret, OS-vault tests/live Windows canary, no key-return command, and runtime fixture scanning serialized output for the secret | A JavaScript string and DOM value exist transiently during entry; add DOM/heap/log/export/crash canaries and macOS/Linux live-vault proof before release |
| Provider caller forges, downgrades, or bypasses human disclosure | Public request has no approval/category/detached-source-ID fields; Rust derives categories and unique provenance from the same structured payload it serializes, then always opens a native dialog; denial test proves no vault read or network; transport still requires matching one-use approval | Product orchestration still chooses which frozen snapshots enter the envelope; bind that selection to the editor/domain revision and exercise the real packaged OS dialog before availability |
| Remote provider silently stores research or transmits to an unsafe endpoint | OpenAI, Gemini, and xAI request fixtures force `store:false`; every implemented remote request requires matching content disclosure and accepts only HTTPS or literal loopback HTTP | Provider-specific streaming/tools plus custom adapters need equivalent wire inspection; every provider policy must be rechecked at release |
| Anthropic adapter sends the wrong role/header shape or retains thinking content | Fake `/v1/messages` server checks `x-api-key`, pinned API version, system/user separation, `stream:false`, bounded response, text-only retention, usage overflow, sanitized failure, timeout, and cancellation | Streaming events, tool/thinking signatures, beta headers, request IDs, product workflow UI, and live policy evidence remain open |
| Gemini adapter stores research by default, drifts to preview, or retains thought output | Stable `/v1/interactions` fake server checks `x-goog-api-key`, `store:false`, `background:false`, `stream:false`, `thinking_summaries:none`, text-only retention, usage consistency, sanitized failure, timeout, and cancellation; `/v1beta` is rejected | Streaming, tools/thought signatures, structured output, product workflow UI, and live policy evidence remain open |
| xAI Responses compatibility hides different retention semantics | Fake `/v1/responses` server checks `store:false`, no thread/cache identifier, bearer auth, bounded controls, and a mandatory boolean `x-zero-data-retention` response header preserved in the typed result | Standard API traffic may still have 30-day retention when the header is false; streaming/WebSocket, tools, encrypted reasoning, UI disclosure, and live evidence remain open |
| Fragmented or future provider stream corrupts research evidence | Incremental OpenAI decoder tests split UTF-8 at every byte, join multiline data, surface unknown types, order usage before finish, sanitize errors, and fail malformed/mismatched/oversized/truncated frames; fake HTTP streaming now proves media type, real chunk dispatch, terminal order, aggregate bounds, distinct sanitized provider failure, timeout, and cancellation between events | Frontend event-bridge backpressure, retry/duplicate semantics, tool arguments, and adversarial long-stream fuzzing remain open |
| Remote provider retains or trains on unexpected data | Provider profile separates state/training/ZDR and task disclosure is required | Policies change; re-check primary terms at adapter release and record policy date |
| Multi-model panel creates false confidence | Blind proposals, evidence pass, reversed judge order, minority report, compute-matched baseline | Protocol execution and domain benchmark are not implemented; no quality claim yet |
| Adversarial run record hides unfavorable evidence or spends more compute than its baseline | Public strict Draft 2020-12 schema rejects unknown/identity/reasoning fields and unsafe shapes; the plan-relative typed validator requires every claim audit, known source snapshots, both planned judge orders, supported-minority retention, equal actual calls, finite accounting, and human acceptance before mutation | Schema validity alone cannot prove plan-relative semantics; real orchestration, failure/cancellation accounting, corpus scoring, and statistical review remain open |
| Plugin manifest grants itself authority | Manifests are requests; broker grants and rechecks permissions | Runtime broker not implemented; hostile permission suite required |
| Plugin package escapes its folder or fakes certification with only happy-path fixtures | Certifier resolves real paths, rejects traversal/symlink escape and unknown fields, requires valid+invalid proposal fixtures and at least one denied-authority probe | Runtime artifact parsing/signature, archive extraction, TOCTOU, install lifecycle, and actual denied-operation tests remain open |
| Native plugin escapes product controls | Native MCP is labeled an advanced unsandboxed process; WASI is preferred | Same-user native code retains OS authority; hashes/signatures do not make it a sandbox |
| Plugin overwrites newer or unreviewed work | Plugin mutations use bounded revision-guarded proposals plus human acceptance | Drive-specific proposal schemas and runtime acceptance UI remain open |
| A collaboration test mistakes internal node-map enumeration for visible document order | Policy-block convergence assertions traverse ordered root children; the false-positive failure and corrected oracle are recorded in run evidence | Add pointer/keyboard interaction, randomized ordering, and concurrent move-vs-edit partition cases before claiming P-10 |
| Concurrent scenario work silently overwrites turns or creates corrupt branch history | Scenarios use nested field/turn/revision CRDTs and explicit ordered keys; peer-specific internal keys retain colliding public IDs so reads fail closed; graph inspection detects invalid records and missing/cyclic parents | Turn winner uses caller-supplied timestamp/edit identity; authenticated identity/clock policy, move/reorder, remote-provider proof, and recovery UI remain open |
| Concurrent or replayed scenario votes double-count participants or overwrite dissent | Immutable events live in peer-specific versioned buckets; exact replay deduplicates; per-participant current projection retains every re-vote/withdrawal; conflicting event identities and orphan targets fail closed | Participant ID/display name/time are caller-supplied; authentication, trusted clock policy, moderation, recovery UI, and remote-provider proof remain open |
| Concurrent flag/note actions erase another researcher's edit or resolution | Immutable events name an exact parent; product operations require the current event; concurrent children remain in history and deterministic projection is delivery-order independent; collisions/orphan targets fail closed | Projection winner still uses caller time/event ID; authenticated identity/clock policy, branch reconciliation UI, moderation, and remote-provider proof remain open |

## Release blockers

- A path traversal or selected-workspace escape is high severity.
- Returning Drive tokens to the webview is high severity.
- Any AI action that mutates shared state without human acceptance is high severity.
- Any MCP addition that bypasses semantic domain/editor contracts or grants ambient Drive/filesystem/model authority is high severity.
- Any remote adapter that exposes a key to the webview or transmits before disclosure is high severity.
- Any plugin path that directly mutates project/Drive state or gains undeclared network/model authority is high severity.
- The plugin authority broker is an in-process decision layer, not a sandbox or operation host. It
  copies bounded snapshots, requires explicit grant subsets, returns pending proposals, and marks
  network/model/Drive decisions for downstream recheck. A future network host must resolve and
  reject local/private/link-local destinations and revalidate every redirect after the broker's
  hostname decision; a future loader must not treat a session ID as an OS security boundary.
- The injected adversarial runner stores provider/model routing only in its separate execution
  ledger and omits it from judge/baseline payloads. A future executor must not copy route identity
  into prompts, outputs, or public records and must preserve native disclosure and provider-run
  provenance per call or authorized batch. The runner itself has no product executor and cannot
  mutate shared state.
- The native batch authorizer accepts the real question/source scope so Rust, rather than a
  caller-authored category list, derives what the dialog says. It binds exact remote routes and
  budgets, expires after 30 minutes, and supports status/revocation. Its random capability currently
  has no consumer. The private reservation function now proves atomic route and total decrements,
  one-use call IDs, exact run/source-ID/route checks, and expiry cleanup under concurrency. Before
  consumption ships, tests must bind actual question/source/task/artifact bytes to the approved
  scope, recheck expiry/revocation immediately before vault/network access, preserve per-call
  provenance, and fail closed under parallel calls.
- A WIT file is not a sandbox by itself. The published plugin baseline has no imports and bounded
  typed input/output validators, which prevents the contract from naming filesystem, network,
  environment, clock, randomness, Drive, model, or mutation authority. A future host must still
  reject components with unexpected imports, enforce memory/fuel/wall-time/output ceilings,
  contain traps, and pass the plugin output through the authority broker. Until then the status is
  `published-zero-imports-no-runtime`.
- Collaborative heuristics treat peer CRDT data as untrusted. Reads accept only the current schema,
  bounded stable IDs/text, known priorities, booleans, finite timestamps, and a complete valid edit
  map. Within a replica, update IDs are one-use: identical replay is idempotent and conflicting
  replay fails before mutation. Peer-specific internal storage keys keep independently created
  colliding edit IDs from overwriting one another; the validated projection detects the duplicate
  and fails closed after merge. Histories above 10,000 events are also rejected. The convergence
  harness fixes delete-versus-concurrent-edit semantics as deletion with no resurrection. This does
  not authorize a heuristic to run a model or mutate policy text.
- Claiming S-01 verified before the live Drive→local-model harness passes is a documentation defect.

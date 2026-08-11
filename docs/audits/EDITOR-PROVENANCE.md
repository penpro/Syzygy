# Editor provenance ledger

**Status:** First clean-room editor vertical slice landed; dependency and source-file gate active.

## Rules

- PolicyPad and Tiptap code, packages, prompts, schemas, fixtures, assets, templates, tests, and
  UI are prohibited implementation inputs.
- Every future editor source file must be added to the file ledger in the same commit.
- Third-party packages require an exact locked version, upstream source URL, package-level
  license evidence, and shipped-license/SBOM evidence before use.
- Example/playground UI from an editor dependency is not an approved product source.

## Current file ledger

| Path/pattern | Classification | Evidence |
|---|---|---|
| `frontend/src/components/AskView.tsx` and current shell components | Penumbra original / inherited MIT Syzygy shell | Repository history and MIT license |
| `frontend/src/driveContext.ts` | Penumbra original | Added with direct Drive evidence tests |
| `frontend/src-tauri/src/google_*.rs` | Penumbra original | OAuth/Drive implementation and ADR-0001 |
| `frontend/src/workspace/schema.ts` | Penumbra original | Versioned project-manifest contract and fail-closed validator |
| `frontend/src/workspace/projectModel.ts` | Penumbra original | Provider-neutral Yjs shared-type names and update helpers |
| `frontend/src/workspace/projectArchive.ts` | Penumbra original | Checksummed, size-bounded manifest plus exact-Yjs-state archive with identity validation, collision refusal, migration-before-fingerprint local rebinding, IndexedDB orphan-state protection, and exact scenario-graph retention |
| `frontend/src/workspace/ProjectArchiveControls.tsx` | Penumbra original | Accessible engine-free project import/export controls with live-document readiness, file-size gating, and explicit status/error states |
| `frontend/src/workspace/heuristicsModel.ts` | Penumbra original | Typed collaborative heuristic records with nested CRDT fields, bounded validation, per-edit attribution, replay rejection, and deterministic read projection |
| `frontend/src/workspace/heuristicExampleModel.ts` | Penumbra original | Immutable peer-namespaced positive/negative example and exact-parent removal events with replay safety, hostile-input bounds, collision detection, and deterministic convergence |
| `frontend/src/workspace/HeuristicWorkspace.tsx` | Penumbra original | Engine-free live-Y.Doc heuristic and attributed positive/negative example controls with explicit retained-history removal and accessible states |
| `frontend/src/workspace/heuristicCheck.ts` | Penumbra original | Exact bounded policy/heuristic/example snapshot, route-bound strict result schema, verified UTF-16 citation spans, cancellation, and one-repair ceiling |
| `frontend/src/workspace/heuristicCheckRuntime.ts` | Penumbra original | Tool-free local and native Send-once remote adapters with untrusted-source labeling, strict JSON parsing, and provider/model provenance binding |
| `frontend/src/workspace/heuristicCheckResultModel.ts` | Penumbra original | Immutable peer-namespaced attributed check results with replay/collision/integrity handling and exact project/policy/heuristic/example commit guards |
| `frontend/src/workspace/scenarioEvaluation.ts` | Penumbra original | Exact immutable policy-version/scenario-revision request and strict route-owned handled/unhandled/uncertain result contract |
| `frontend/src/workspace/scenarioEvaluationRuntime.ts` | Penumbra original | Tool-free local and native Send-once evaluation adapters with exact-source disclosure and provider/model provenance binding |
| `frontend/src/workspace/scenarioRerunQueue.ts` | Penumbra original | Bounded peer-namespaced queue/control/item/result records with begin-before-send, atomic completion, crash resume, replay safety, and fail-closed projection |
| `frontend/src/workspace/scenarioRerunRunner.ts` | Penumbra original | Sequential supervised executor with duplicate-run prevention, 30-second progress heartbeat, two-minute item deadline, pause cancellation, retry-safe failure, and completed-item deduplication |
| `frontend/src/workspace/ScenarioRerunQueuePanel.tsx` | Penumbra original | Exact-version multi-scenario queue creation, local/API route controls, creator-only pause/resume/cancel/retry, shared result presentation, and local crash continuation |
| `frontend/src/workspace/scenarioComparison.ts` | Penumbra original | Deterministic exact-revision two-queue comparison, neutral outcome-transition matrix, verified policy/result joins, bounded canonical JSON, SHA-256 checksums, and strict decode |
| `frontend/src/workspace/ScenarioComparisonPanel.tsx` | Penumbra original | Completed-queue selection, fail-closed compatibility preview, responsive side-by-side evidence, explicit content disclosure, and native verifiable-JSON save |
| `frontend/src/workspace/HeuristicChecker.tsx` | Penumbra original | Manual-safe explainable-check controls with preflight integrity, local/API selection, cancellation/retry, verified citations, uncertainty, attribution, and shared provenance |
| `frontend/src/workspace/scenarioModel.ts` | Penumbra original | Stable lifecycle scenarios, ordered multi-turn CRDT content, acyclic immutable revision DAGs with durable heads/complete tips, exact all-parent reconciliation, deterministic zero-write v1 migration, branch inspection, fail-closed peer-collision handling, and atomic lossless snapshot import |
| `frontend/src/workspace/scenarioPack.ts` | Penumbra original | Strict bounded open v2 scenario-pack codec with durable heads/parents, checksummed v1 compatibility migration, ancestor closure, canonical SHA-256, complete authoring-history verification, import planning, idempotency, and atomic collision refusal |
| `frontend/src/workspace/ScenarioWorkspace.tsx` | Penumbra original | Live-Y.Doc scenario gallery, stale-detail guard, integrity-read-only state, delegated editable turn workspace, attributed voting, and injected optional response generation |
| `frontend/src/workspace/ScenarioTurnWorkspace.tsx` | Penumbra original | Manual no-AI ordered-turn creation, exact-current immutable revision editing, visible stale-draft recovery, accessible sibling conflict/all-parent reconciliation, integrity lockout, and bounded conversation/lineage rendering |
| `frontend/src/workspace/ScenarioTurnWorkspace.ui.test.tsx` | Penumbra original | Headless product contract for attribution, idempotence, stale and hostile zero-write behavior, disconnected sibling convergence/reconciliation, accessible state, and paging bounds |
| `frontend/src/workspace/ScenarioCollaborationPanel.tsx` | Penumbra original | Shared scenario/turn note and flag lifecycle plus project-label assignment UI with exact-parent conflict refusal, write-time integrity checks, bounded paging, and post-commit signed/unsigned device attribution |
| `frontend/src/workspace/ScenarioCollaborationPanel.ui.test.tsx` | Penumbra original | Headless product contract for annotation lifecycle, label assignment/rename, integrity lockout, signed/unsigned device-only attribution, and paging |
| `frontend/src/workspace/ScenarioPackControls.tsx` | Penumbra original | Explicit selected/all pack export plus validate-preview-confirm import with included/excluded-data disclosure and no model/network dependency |
| `frontend/src/workspace/scenarioVoteModel.ts` | Penumbra original | Namespaced immutable scenario vote events, idempotent replay, attributed re-vote/withdrawal history, deterministic participant projection, and orphan/collision inspection |
| `frontend/src/workspace/scenarioAnnotationModel.ts` | Penumbra original | Namespaced immutable flag/note lifecycle events, exact-parent revision guards, canonical exact-event hashing/readback, concurrent branch retention, resolve/reopen attribution, and orphan/collision inspection |
| `frontend/src/workspace/scenarioLabelModel.ts` | Penumbra original | Namespaced immutable label and scenario-assignment events, exact-parent guards, deterministic concurrent rename projection, filtering, and orphan/collision inspection |
| `frontend/src/workspace/scenarioAutomation.ts` | Penumbra original | Live-project identity, graph validation, bounded scenario background/head/tip discovery, single selected/named/indexed revision body readback, and exact research/head/tip guards for MCP scenario mutation and reconciliation |
| `frontend/src/workspace/policyVersionModel.ts` | Penumbra original | Canonical SHA-256-addressed immutable policy envelopes, parent validation, detached readback, and historical attribution snapshots |
| `frontend/src/workspace/policyVersionHistory.ts` | Penumbra original | Exact-head commits, restore-as-new-child history, concurrent branch retention, and deterministic engine-free structured diffs |
| `frontend/src/workspace/localProvider.ts` | Penumbra original | Local IndexedDB provider implementing the Lexical/Yjs boundary with migration-before-automation reopen |
| `frontend/src/workspace/driveProjectProvider.ts` | Penumbra original | Immutable-update Drive-backed Yjs provider with IndexedDB durability, partition/reconnect merge, post-pull migration, shared-title pull/projection/exact-guard append, and final-sync snapshot-first compaction |
| `frontend/src/workspace/websocketProjectProvider.ts` | Penumbra original | Stable-Yjs-13 y-websocket provider composed with local IndexedDB, live awareness, bounded initial readiness, strict endpoint/room validation, and fresh native-signed device-bound reconnect authorization |
| `frontend/src/workspace/relayRemoteAdmin.ts` | Penumbra original | Strict bounded project/room-bound remote relay-administration client with separately signed action claims, exact registry revisions, one-message WebSocket control exchange, and fail-closed response normalization |
| `frontend/src/workspace/projectRelayAdminDecision.ts` | Penumbra original | Strict capability-free installation-signed post-mutation decision records with exact action/result binding, verified-directory signer policy, bounded cryptographic inspection, convergent conflict retention, and fail-closed publication |
| `frontend/src/workspace/projectRelayAdminApproval.ts` | Penumbra original | Strict capability-free registered-installation pre-mutation approvals with exact action/revision/expiry binding, bounded cryptographic inspection, disconnected convergence, duplicate-signer deduplication, deterministic equivocation exclusion, and explicit non-enforcement state |
| `frontend/src/workspace/websocketProjectProvider.test.ts` | Penumbra original | Hostile endpoint/room validation and exact provider-capability non-claim fixtures |
| `frontend/src/workspace/websocketProjectBinding.ts` | Penumbra original | Canonical WS/WSS endpoint boundary, private-plaintext enforcement, 256-bit room generation, and strict legacy/managed/device-bound access shapes |
| `frontend/src/workspace/relayDeviceEnrollment.ts` | Penumbra original | Strict public Ed25519 installation enrollment codec with canonical key-ID validation and no private material |
| `frontend/src/workspace/websocketProjectInvite.ts` | Penumbra original | Strict bounded versioned invitation codec for exact project, relay member, expiry/generation, and enrolled installation-key identity |
| `frontend/src/workspace/websocketProjectInvite.test.ts` | Penumbra original | Unicode round-trip, detached decode, unsupported-field, size, and inactive-transport denial fixtures |
| `frontend/src/workspace/websocketProjectStatus.ts` | Penumbra original | Detached live connection status with stale-provider teardown protection |
| `frontend/src/workspace/websocketProjectStatus.test.ts` | Penumbra original | Status replacement ownership and detached-read fixtures |
| `frontend/src/workspace/websocketProjectStore.test.ts` | Penumbra original | Persisted bind/join/leave state, collision, normalization, and transport-authority fixtures |
| `frontend/src/workspace/SelfHostedProjectControls.tsx` | Penumbra original | Explicit advanced create/join/leave controls plus host-local or device-bound remote membership administration, surviving-admin replacement-device recovery copy, exact-revision refresh, shared signed-decision inspection, forced-reauthentication disclosure, and bearer/non-backup warnings |
| `frontend/src/workspace/websocketProjectProductFlow.integration.test.ts` | Penumbra original | Real-relay invite, two-provider, separate-IndexedDB, destroy/reopen, and return-sync product fixture |
| `frontend/src/components/CollaborationRelaySettings.tsx` | Penumbra original | App-managed private relay lifecycle, endpoint, process/storage status, and exact bearer/persistence/public-hosting disclosures |
| `frontend/src/components/CollaborationRelaySettings.ui.test.tsx` | Penumbra original | Headless separation of lifecycle, bounded persistence, awareness, identity, and backup claims |
| `frontend/src-tauri/src/collaboration_relay_runtime.rs` | Penumbra original | Saved private-listener configuration, same-executable child supervision, bounded restart/shutdown, reaping, and port-release verification |
| `frontend/src-tauri/src/collaboration_relay_server.rs` | Penumbra original | Bounded y-websocket relay with document-only deduplicated append log, role enforcement, awareness recovery, partial-tail repair, and separately signed exact-revision remote membership administration |
| `frontend/src-tauri/src/bin/collaboration-relay.rs` | Penumbra original | Headless entrypoint for exercising the exact bundled relay server without a webview |
| `scripts/bundled-collaboration-relay-harness.mjs` | Penumbra original | Native process lifecycle, all-source-client exit, server-only recovery, awareness exclusion, listener release, and exact product-provider proof |
| `scripts/relay-remote-admin-soak.mjs` | Penumbra original | Five-client rapid-write/partition/awareness soak plus fresh-proof retry, exact-revision remote issue/rotate/revoke, replay denial, peer eviction, and digest-only capability-storage proof |
| `frontend/src/workspace/driveTitleRepairJobs.ts` | Penumbra original | Content-minimized bounded background jobs for exact-inventory Drive shared-title inspection and recoverable repair, with 30-second heartbeats and one-hour terminal retention |
| `frontend/src/workspace/driveProjectMaintenanceRegistry.ts` | Penumbra original | Identity-safe lifecycle registry exposing explicit compaction/title maintenance only for the currently ready Drive provider without stale-disconnect teardown |
| `frontend/src/workspace/driveProjectActions.ts` | Penumbra original | Exact-revision Drive publish and refetched exact-identity Join actions shared by product UI and MCP automation |
| `frontend/src/workspace/driveProjectStatus.ts` | Penumbra original | Content-free per-project Drive transport lifecycle registry for honest product status |
| `frontend/src/workspace/driveProjectDiscovery.ts` | Penumbra original | Selected-workspace folder-code labeling, explicit refresh outcomes, and bounded content-free MCP/LAN project identity diagnostics |
| `frontend/src/workspace/driveProjectTitleStatus.ts` | Penumbra original | Identity-safe source-owned publication/subscription for bounded shared-title state and sibling tips |
| `frontend/src/workspace/SharedProjectTitleControl.tsx` | Penumbra original | Exact-captured-guard rename draft, stale refusal, visible sibling choices, and explicit all-tip reconciliation UI |
| `frontend/src/workspace/DriveProjectControls.tsx` | Penumbra original | Explicit share/Join catalog with title-conflict disclosure plus honest snapshot-first, concurrent-retaining Drive-history maintenance controls |
| `frontend/src-tauri/src/drive_projects.rs` | Penumbra original | Strict selected-workspace manifest/update transport, content-addressed bounded title-event graph, ordered eight-request/12-second cancellation-bounded app-root catalog, and recoverable snapshot-first update archival |
| `frontend/src/workspace/collaborationProvider.ts` | Penumbra original | Provider-neutral lifecycle shared by local and test/future transports |
| `frontend/src/workspace/memoryProvider.ts` | Penumbra original | Deterministic two-editor live/partition convergence transport used only by the headless contract suite |
| `frontend/src/workspace/presenceModel.ts` | Penumbra original | Bounded fail-closed projection of schema-versioned ephemeral researcher awareness metadata |
| `frontend/src/workspace/presenceRegistry.ts` | Penumbra original | Identity-safe active-provider presence lifecycle plus content-free MCP session-count inspection |
| `frontend/src/workspace/deviceIdentity.ts` | Penumbra original | Strict canonical Ed25519 presence and durable project-registration parsers/verifiers with separate domains, exact context binding, fingerprint recomputation, and explicit unsupported-verifier state |
| `frontend/src/workspace/projectDeviceDirectory.ts` | Penumbra original | Bounded independently verified Yjs project-device registration set with exact storage identity, disconnected convergence, conflict retention, and fail-closed mutation gate |
| `frontend/src/workspace/ResearchPresence.tsx` | Penumbra original | Accessible transport-honest local/Drive/live presence, explicit correlation-disclosed durable device registration, offline directory inspection, and serialized local-only fingerprint approval/revocation controls |
| `frontend/src/components/CollaborationIdentitySettings.tsx` | Penumbra original | Public installation fingerprint/status with OS-vault, self-issued-device, and no-human-verification disclosure |
| `frontend/src-tauri/src/collaboration_identity.rs` | Penumbra original | OS-vault Ed25519 installation key plus separately domain-scoped canonical live-presence, project-registration, relay-access/admin, post-mutation decision, and pre-mutation shared-approval signing surfaces with zeroized private material |
| `frontend/src-tauri/src/collaboration_device_trust.rs` | Penumbra original | Bounded per-installation/project device-fingerprint current-state registry with exact-state transitions and crash-recoverable native persistence |
| `frontend/src-tauri/src/bin/collaboration-identity-harness.rs` and `scripts/collaboration-identity-interop.mjs` | Penumbra original | Bounded same-key Rust-to-WebCrypto presence/registration/relay decision/relay approval signatures, cross-domain mutation rejection, and private-material-absence proof |
| `frontend/src/workspace/nodes/PolicyBlockNode.ts` | Penumbra original | Stable-identity policy placement/projection node with review state and strict JSON round-trip |
| `frontend/src/workspace/policyContentModel.ts` | Penumbra original | Bounded deterministic policy-ID Y.Text content/status record with character/format/embed merge operations |
| `frontend/src/workspace/policyContentLexical.ts` | Penumbra original | Strict bidirectional adapter between supported Lexical inline children and stable policy-content deltas |
| `frontend/src/workspace/policyContentBridge.ts` | Penumbra original | Local-edit canonicalization plus skip-writeback remote projection across root placement changes |
| `frontend/src/workspace/PolicyContentBridgeProvider.tsx` | Penumbra original | Provider-lifecycle wiring, legacy/invalid disclosure, and Drive reorder-readiness context |
| `frontend/src/workspace/nodes/ScenarioReferenceNode.tsx` | Penumbra original | Inline stable-ID scenario link with strict JSON/Yjs round-trip and live-title decorator |
| `frontend/src/workspace/nodes/ScenarioSpotlightNode.tsx` | Penumbra original | Block-level stable-ID scenario projection with live content, shared embed/collapse, and exact semantic/version round-trip |
| `frontend/src/workspace/scenarioResponseModel.ts` | Penumbra original | Versioned peer-namespaced response revisions with human/model provenance, exact-parent edits, and collision-safe projection |
| `frontend/src/workspace/ScenarioResponseWorkspace.tsx` | Penumbra original | Manual no-AI response authoring, exact-parent editing, stale-draft recovery, integrity gating, and bounded lineage/product paging |
| `frontend/src/workspace/scenarioGeneration.ts` | Penumbra original | Bounded provider-neutral selected-scenario request/output contract with route binding and exact-source commit guard |
| `frontend/src/workspace/scenarioGenerationRuntime.ts` | Penumbra original | Optional local-stream and native-approved remote-provider adapters for the shared generation contract |
| `frontend/src/workspace/ScenarioGenerator.tsx` | Penumbra original | Local/API generation controls and non-destructive regeneration delegated into the shared editable response workspace |
| `frontend/src/workspace/suggestionModel.ts` | Penumbra original | Immutable peer-namespaced proposal/decision ledger with exact-proposal guards, replay safety, model provenance, and explicit concurrent decision conflicts |
| `frontend/src/workspace/suggestionApplication.ts` | Penumbra original | Deterministic suggestion-excluding policy fingerprint plus exact proposal/decision/editor-revision and marker-identity guards for linked review-policy application |
| `frontend/src/workspace/SuggestionContext.tsx` | Penumbra original | Live project-Y.Doc suggestion projection and attributed human proposal/decision actions |
| `frontend/src/workspace/nodes/SuggestionNode.tsx` | Penumbra original | Stable-ID-only live suggestion preview with explicit accept/reject, missing-target, decided, and conflict states |
| `frontend/src/workspace/ScenarioReferenceContext.tsx` | Penumbra original | Live project-Y.Doc scenario projection used by the editor toolbar and rename-safe reference rendering |
| `frontend/src/workspace/ResearchEditor.tsx` | Penumbra original | Original Syzygy editor composition, formatting toolbar, and local provider wiring |
| `frontend/src/workspace/editorStructure.ts` | Penumbra original | Live heading projection plus shared pointer/keyboard policy-reorder command and availability guards |
| `frontend/src/workspace/ResearchTableOfContents.tsx` | Penumbra original | Accessible navigation derived from live editor headings without duplicate state |
| `frontend/src/workspace/WorkspaceView.tsx` | Penumbra original | Original three-column research workspace scaffold |
| `frontend/src/workspace/PolicyVersionRail.tsx` | Penumbra original | Live-document subscribed exact-revision checkpoint UI, historical metadata rail, and deterministic engine-free parent-diff presentation |
| `frontend/src/workspace/RemoteResearchReview.tsx` | Penumbra original | Optional single-provider review UI with native disclosure, cancellation, and non-mutating result presentation |
| `frontend/src/workspace/AdversarialReviewWorkspace.tsx` | Penumbra original | Exact-block and route configuration over the bounded native job registry, explicit full-content collaborative archive action, complete evidence/conflict history, and immutable no-draft-mutation human decisions |
| `frontend/src/workspace/AdversarialEvidenceView.tsx` | Penumbra original | Lazy evidence categories and deterministic 50-artifact progressive pages that avoid eager DOM materialization while retaining explicit access to every stored artifact |
| `frontend/src/workspace/AdversarialReviewWorkspace.ui.test.tsx` | Penumbra original | Headless product contract for source/call bounds, safety disclosure, evidence/provenance rendering, and absence of implicit Apply authority |
| `frontend/src/workspace/remoteResearchTask.ts` | Penumbra original | Exact-draft content-addressed remote review envelope with editable current provider model defaults |
| `frontend/src/workspace/editorAutomation.ts` | Penumbra original | Semantic live-editor controller, deterministic text-block adapter, and optimistic revision guard |
| `frontend/src/workspace/editorAutomationRegistry.ts` | Penumbra original | Lightweight active-editor capability registry that preserves lazy workspace loading |
| `frontend/src/workspace/workspaceAutomationRegistry.ts` | Penumbra original | Identity-safe lifecycle registry exposing only the active collaboration document to internal semantic automation |
| `frontend/src/workspace/researchStateInspection.ts` | Penumbra original | Bounded content-minimized heuristic/example/scenario/version/head/lineage plus non-enforcing relay-approval integrity projection for read-only MCP inspection |
| `frontend/src/workspace/projectResearchEventAttestation.ts` | Penumbra original | Bounded parallel Yjs ledger for exact-hash registered-installation research-event signatures with a closed event-kind vocabulary, live-event resolver validation, convergence, replay, and content-minimized inspection |
| `frontend/src/workspace/researchEventAttribution.ts` | Penumbra original | Vote and annotation adoption layer that locates/hashes exact committed product/MCP events, publishes best-effort registered-device attribution, and reports explicit unsigned fallback without rolling back research state |
| `frontend/src/workspace/relayPolicyAutomation.ts` | Penumbra original | Host-only semantic adapter for authoritative content-minimized relay-policy inspection and exact-revision install/remove using eligible registered installation key IDs with internal public-key resolution and exact returned-transition verification |
| `frontend/src/workspace/versionAutomation.ts` | Penumbra original | Exact semantic-editor snapshot adapter with document/head concurrency guards and immutable checkpoint output |
| `frontend/src/workspace/*.test.ts` and `frontend/src/migrations.test.ts` | Penumbra original | Schema, migration, convergence, duplicate/reorder, and reopen harnesses |
| `frontend/src/automationBridge.ts` and `frontend/src-tauri/src/{automation,mcp}.rs` | Penumbra original | Live semantic dispatcher, authenticated loopback bridge, bounded explicit scenario-index and selected-revision content reads, exact sibling-reconciliation route, and stdio MCP protocol implementation |
| `frontend/src/extensions/*.ts` | Penumbra original | Provider, adversarial-run, and researcher-plugin contracts and tests authored for Syzygy |
| `frontend/src-tauri/src/platform_contracts.rs` and `docs/schemas/*.json` | Penumbra original | Strict extension schemas and truthful MCP self-description authored for Syzygy |

| `frontend/src/networkBoundaries.ts` | Penumbra original | Plain-language catalog of local, remote-provider, Drive, download/update, crash-report, MCP, and private-LAN network boundaries |
| `frontend/src/components/NetworkBoundarySummary.tsx` | Penumbra original | Settings disclosure that distinguishes default state, activation, destination, and transmitted data for every network-active feature |

## Approved exact dependencies

All product dependencies below are exact-pinned in both `package.json` and `package-lock.json`.
Integrity values are npm registry `dist.integrity` values captured before installation. The root
Lexical repository and packages are MIT; Yjs, y-indexeddb, y-protocols, and y-websocket are MIT. The test-only
fake IndexedDB implementation is Apache-2.0. No example/playground source or UI was copied.

| Package | Version | License/source evidence | npm integrity |
|---|---:|---|---|
| `lexical` | 0.47.0 | MIT; <https://github.com/facebook/lexical> | `sha512-ZKsxsk3jUpXsRtG20EBq42z2bq8A20UHtjqvVT/kIxfsaiXwaRFBBcLSFxPa77j+hXkBF5w96C3/imwtmLoRdg==` |
| `@lexical/react` | 0.47.0 | MIT; same monorepo | `sha512-4y2iEKghKcYcJ8+GoO8pqyvwjJFVDWR71Ezm37lLQGmSTFKY50miTJmgKI12GeL4hLWQjePpB3eVdmSQHG1b7g==` |
| `@lexical/rich-text` | 0.47.0 | MIT; same monorepo | `sha512-GtRH7KNW7fVJzd3Xftdr/EPXaMqHt2xCIO/eJtf17Yrs7vlVOljM0xMcDoj4QOY2Gp4p3CheLlwBbcO96YYV0A==` |
| `@lexical/selection` | 0.47.0 | MIT; same monorepo | `sha512-/q+eXnryZxCeqeWAODhTRlJL+jGa6/vIhE/bh+KvHmLbZJM8qfwa0qzt4rb3g+L1/CbjcowS/Xwv2ha1OmjBFQ==` |
| `@lexical/yjs` | 0.47.0 | MIT; same monorepo | `sha512-EKw1df2cmUTQrfSp1EnXqsHtNjwgxS973CRor0W4GWmIQJyKdmf6cmA7cct3flkyH5tE/xDnpr8sy38U4R2hlQ==` |
| `yjs` | 13.6.31 | MIT; <https://github.com/yjs/yjs> | `sha512-Eq+5BRfbeGyqGVrTJL3bEcr8gKkxPuyuoHmAwpk52fDb8kOVMrfVSTRPd6yiGgX5Fskb96qCRjzjbRjrL4YEnw==` |
| `y-indexeddb` | 9.0.12 | MIT; <https://github.com/yjs/y-indexeddb> | `sha512-9oCFRSPPzBK7/w5vOkJBaVCQZKHXB/v6SIT+WYhnJxlEC61juqG0hBrAf+y3gmSMLFLwICNH9nQ53uscuse6Hg==` |
| `y-protocols` | 1.0.7 | MIT; <https://github.com/yjs/y-protocols> | `sha512-YSVsLoXxO67J6eE/nV4AtFtT3QEotZf5sK5BHxFBXso7VDUT3Tx07IfA6hsu5Q5OmBdMkQVmFZ9QOA7fikWvnw==` |
| `y-websocket` | 3.0.0 | MIT; <https://github.com/yjs/y-websocket> | `sha512-mUHy7AzkOZ834T/7piqtlA8Yk6AchqKqcrCXjKW8J1w2lPtRDjz8W5/CvXz9higKAHgKRKqpI3T33YkRFLkPtg==` |
| `@y/websocket-server` | 0.1.1 (test only) | MIT; <https://github.com/yjs/y-websocket-server> | `sha512-pPtXm5Ceqs4orhXXHwm2I+u1mKNBDNzlrwNiI7OMwM7PlVS4WCMpiIuSB8WsYeSuISbvpXPNvaj6H1MoQBbE+g==` |
| `fake-indexeddb` (test only) | 6.2.5 | Apache-2.0; <https://github.com/dumbmatter/fakeIndexedDB> | `sha512-CGnyrvbhPlWYMngksqrSSUT1BAVP49dZocrHuK0SvtR0D5TMs5wP0o3j7jexDJW01KSadjBp1M/71o/KR3nD1w==` |

The generated full SBOM/license inventory remains an open Phase 0 gate; this ledger approves only
the dependencies introduced by the first editor slice.

The signed-device slice directly pins `ring` 0.17.14, already present transitively in the locked
Rust graph, for Ed25519 generation/signing/verification. Upstream is
<https://github.com/briansmith/ring>; the crate ships its permissive `LICENSE`, BoringSSL,
other-bits, Apache-2.0, and MIT license files. This direct use does not import editor or PolicyPad
implementation material.

The CI audit currently fails if Tiptap, Firebase, or PolicyPad packages/imports enter the source
tree. It is a guardrail, not proof of clean-room authorship; human and adversarial review remain
mandatory.

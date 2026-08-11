# Live Syzygy MCP

Syzygy's installed application binary is also a local MCP server. Launching it with `--mcp`
starts a stdio MCP process; launching it normally starts the desktop UI. The MCP does not open a
second project database or scrape pixels. It sends semantic operations to the running Syzygy
window, which remains the owner of project navigation, Lexical editor state, Yjs, and IndexedDB.

This is an automation and interoperability surface, not ambient authority. Most tools remain
semantic read/revision-guarded mutation operations. Adversarial review is the sole MCP model
workflow: it uses exact selected blocks from the live revision, one native disclosure, built-in
provider routes, resumable polling/cancellation, an explicit shared-archive step, and a separate
immutable human decision. No step edits the draft automatically. Real-time
presence and live-provider compatibility must still be reported honestly.

## Connect an MCP host

The streamlined path is **Syzygy → Settings → Connect an LLM → MCP setup guide**. The running app
detects its exact executable and install folder, then generates JSON-host configuration, Codex
TOML, a connection prompt, and a safe first task. Use those generated values because install paths
vary across computers.

To configure a host manually, use a local stdio server with the full path to the installed Syzygy
executable:

```json
{
  "servers": {
    "syzygy-live": {
      "type": "stdio",
      "command": "C:\\full\\path\\to\\Syzygy.exe",
      "args": ["--mcp"]
    }
  }
}
```

Use the equivalent stdio-server shape for hosts that use TOML or another configuration format.
The executable path must be absolute. The MCP can call `launch_syzygy` when the GUI is closed;
otherwise open Syzygy normally before using the other tools.

Recommended first instruction to an MCP-capable model:

> Use the Syzygy tools to inspect the live workspace, run the workspace walkthrough, explain the
> current project to me, and offer one concrete demonstration edit. Read before writing.

## Tool contract

| Tool | Mutation | Contract |
|---|---:|---|
| `syzygy_status` | no | Running version/view, active project, editor readiness, honest capability report |
| `launch_syzygy` | launches app | Starts the GUI from the same installed executable and waits for readiness |
| `syzygy_installation` | no | Exact executable/install folder, protocol, JSON/TOML configuration, connection prompt, and starter prompt; works without the GUI |
| `syzygy_platform_contracts` | no | Provider-run, custom-adapter, public adversarial-run, portable scenario-pack, and plugin schemas, honest runtime status, and self-check commands; works without the GUI |
| `workspace_walkthrough` | no | State-aware explanation of the current use case and next step |
| `list_projects` | no | Stable IDs, titles, archive state, transport, active project |
| `inspect_drive_project_discovery` | no | Explicitly refreshes selected-workspace shared-project metadata; returns short folder code, bounded project/document identities, count, truncation, and time without tokens, Drive file IDs, titles, or document content |
| `list_shared_projects` | no | Refetches the bounded cross-workspace Drive project catalog and returns only join identities plus parent folder label/code |
| `share_active_project` | Drive project state | Publishes the exact active local Yjs state only when `expectedDocumentRevision` still matches, then binds only the returned exact identities |
| `join_shared_project` | local workspace/project registration | Refetches and joins one exact workspace/project/document identity, rejects local collisions, and waits for the Drive-backed editor |
| `compact_drive_project` | Drive maintenance | After a final sync and exact `expectedDocumentRevision` plus `expectedResearchRevision` checks, appends a complete snapshot and recoverably archives only applied update records; reports partial/concurrent counts and returns no Drive file IDs |
| `retain_drive_title_history` | Drive title maintenance | Requires the complete exact `sharedTitle.revisionGuards`, snapshots the complete validated title graph before recoverably archiving observed active records, preserves concurrent children, and returns counts without Drive file IDs |
| `start_drive_title_repair_inspection` | no | Starts a bounded background inventory of active, recoverable archived, and quarantined title records; returns a job immediately and never returns titles, authors, filenames, Drive file IDs, or snapshot bodies |
| `inspect_drive_title_repair_job` | no | Polls a title inspection/repair job with a 30-second heartbeat; terminal count-only results expire after one hour |
| `start_drive_title_repair` | recoverable Drive title maintenance | Requires the exact inspection revision, appends the maximal complete validated recovery snapshot before any move, quarantines invalid active records, re-archives valid active records, deletes nothing, and returns immediately with a job ID |
| `create_project` | yes | Creates and opens a local project with a non-empty title |
| `open_project` | navigation | Opens a non-archived project by stable ID |
| `rename_project` | local metadata or Drive title event | Local projects change local metadata. Drive projects require the complete exact `sharedTitle.revisionGuards`; stale calls fail, simultaneous siblings remain visible, and an all-tip rename reconciles without deleting history |
| `read_active_project` | no | Returns the manifest plus structured blocks, plain text, and a revision; Drive projects also return bounded shared-title tips and exact rename guards |
| `inspect_research_state` | no | Validates bounded signed project-device registrations, exact-hash installation attestations for scenario lifecycle, turn, vote, annotation, label, suggestion, policy-version, and adversarial archive/decision events, and relay-approval intent metadata plus live scenario/vote/flag/note/label/suggestion/heuristic/adversarial-review/version/head/lineage state; omits proof bodies, private keys, member capabilities, and research bodies; shared state explicitly cannot attest the relay host's current policy and grants no human identity, role, revocation, relay, or mutation authority |
| `inspect_relay_approval_policy` | no | On a project hosted by this running Syzygy relay only, reads the authoritative registry revision, aggregate member counts, configured signer key IDs/quorum, and eligible registered installation key IDs; omits member IDs, public keys, capabilities, storage paths, and research bodies |
| `configure_relay_approval_policy` | hosted relay policy | Under the exact inspected registry revision, installs/updates a 1-16-key policy with a bounded quorum or removes it; every selected key must be an exact healthy project registration and the returned revision and policy must prove the requested transition |
| `read_scenario` | explicit scenario content | Reads one validated scenario background plus at most 1,000 ordered turn identities, roles, immutable-revision counts, selected heads, complete tip sets, and reconciliation state; turn bodies remain omitted |
| `read_scenario_turn_revision` | explicit scenario content | Reads exactly one selected-head, named, or zero-based indexed immutable turn revision body plus bounded head/tip metadata and the current research revision; no mutation or model authority |
| `start_adversarial_review` | remote model job | Freezes selected block indexes from the exact live document revision, complete built-in-provider call graph, and limits; returns a job immediately before one native batch disclosure |
| `inspect_adversarial_review` | no | Returns bounded lifecycle/heartbeat metadata while running and the validated pending-human-review result after completion |
| `cancel_adversarial_review` | cancels model job | Aborts the shared job signal and active native provider call without changing project content |
| `save_adversarial_review` | shared research history | Explicitly stores the completed full question, selected excerpts, results, baselines, and content-free provenance in the collaborative project against the exact research revision, then reports exact-archive signed-device or explicit unsigned attribution plus the post-attribution revision; Drive-backed projects can synchronize it |
| `decide_adversarial_review` | decision event | Appends an immutable accept/reject event against the exact project revision, archive hash, and prior decision, then reports exact-decision signed-device or explicit unsigned attribution plus the post-attribution revision; never edits the draft |
| `create_scenario` | scenario metadata | Creates one scenario/branch only when `expectedResearchRevision` exactly matches, retains its immutable creation edit, then reports signed-device or explicit unsigned exact-edit attribution and the post-attribution revision; signing failure never rolls back the scenario and no model runs |
| `add_scenario_turn` | scenario content | Adds one system/user/assistant turn against the exact current research revision, then reports signed-device or explicit unsigned exact-revision attribution and the post-attribution research revision; signing failure never rolls back the turn and no model runs |
| `revise_scenario_turn` | scenario content | Adds an immutable revision to an existing single-tip turn against the exact current research revision, then reports signed-device or explicit unsigned exact-revision attribution and the post-attribution research revision; sibling conflicts fail closed |
| `reconcile_scenario_turn` | scenario content | Resolves visible sibling tips only against the exact research revision, selected head, and complete tip set by appending an all-parent merge revision, then reports signed-device or explicit unsigned exact-revision attribution and the post-attribution research revision; no sibling is deleted and no model runs |
| `cast_scenario_vote` | vote event | Casts support/oppose/abstain/withdrawn against the exact current research revision, retains re-vote history, and best-effort publishes an exact-event-hash installation signature when the caller key is an unconflicted registered project device; the response explicitly reports signed-device or unsigned |
| `create_scenario_annotation` | annotation event | Creates a scenario- or turn-level flag/note against the exact research revision; stores but does not return its body |
| `update_scenario_annotation` | annotation event | Appends a body revision only when both research revision and current annotation event match; prior bodies remain in history and readback omits them |
| `set_scenario_annotation_resolution` | annotation event | Resolves or reopens by appending an event under both revision guards |
| `create_scenario_label` | label event | Creates a shared context label against the exact current research revision; event bodies remain omitted |
| `rename_scenario_label` | label event | Appends a rename only when both research revision and current label event match |
| `set_scenario_label_assignment` | assignment event | Assigns/removes a label under the research guard; follow-up events also require the exact assignment event |
| `create_suggestion` | proposal event | Stores one human/model proposal against exact research and source-document revisions without editing the draft, then reports exact-event signed-device or explicit unsigned attribution and the post-attribution revision; model provenance is mandatory for model sources |
| `decide_suggestion` | decision event | Appends an accept/reject event against the exact research revision and immutable proposal, never edits the draft, and reports exact-event signed-device or explicit unsigned attribution plus the post-attribution revision |
| `save_active_policy_version` | version metadata | Saves the exact active semantic draft as a new immutable head under both document-revision and expected-head guards, then reports signed-device or explicit unsigned exact-envelope attribution and the post-attribution research revision; signing failure does not roll back the checkpoint |
| `restore_active_policy_version` | document + version metadata | Restores one inspected immutable version into the live semantic draft and appends it as a new head under exact target, document-revision, and expected-head guards, then reports signed-device or explicit unsigned exact-envelope attribution and the post-attribution research revision; never rewrites history |
| `replace_active_document` | yes | Replaces the document only when `expectedRevision` still matches |
| `append_active_document` | yes | Appends blocks only when `expectedRevision` still matches |

Automation document text has a deliberately small, deterministic format: `# ` for heading 1,
`## ` for heading 2, `> ` for a quotation, `[policy:stable-id:draft|review|approved] statement`
for a policy block, and other lines for paragraphs. Structured reads also return the policy ID and
status. It does not pretend to round-trip editor features Syzygy has not implemented.

Every document write requires the exact revision returned by the latest read. If the user or a
collaborator changes the live draft between read and write, the tool fails with a revision
conflict. The caller must read again and reconcile; there is no blind last-writer-wins overwrite.
Revisions combine a controller-session nonce, monotonic live-editor generation, and deterministic
content fingerprint, so a draft that changes away and back to identical content still rejects an
older read (the ABA case).
Drive compaction additionally requires the exact research revision returned by
`inspect_research_state`. Both guards are checked after the provider's final pull and before snapshot
encoding/upload. Compaction does not change project content: the snapshot is appended first, unknown
concurrent records remain active, and interrupted archive moves are safe to retry.
For Drive-shared titles, callers must pass the complete `sharedTitle.revisionGuards` returned by
`read_active_project`. The guard array is unique and bounded to 20. A stale set writes nothing; a
simultaneous append can still create visible siblings; one later call naming all current tips appends
an attributed merge event. The MCP response includes bounded title/tip metadata but no Drive file IDs.
`retain_drive_title_history` uses the same exact guard set but does not rename or reconcile. It first
appends a canonical content-addressed snapshot of the complete validated graph, rechecks the tips,
then moves at most 200 observed records into a recoverable folder. A stale pre-move set writes no
archive moves; concurrent children remain active; partial moves are reported and safe to retry.
Title repair is inspect-first and asynchronous because bounded Drive recovery can outlive the
15-second live bridge request. The inspection hashes the exact active/archive/quarantine inventory and returns
only counts plus `repairRevision`. `start_drive_title_repair` must present that exact hash; Rust
rechecks it before writing, appends or reuses the canonical recovery snapshot, re-reads the inventory,
and permits no move if anything except that snapshot changed. Invalid active records move to
`quarantined-title-history/`; valid active records move back to `compacted-title-history/`. Archived
invalid records remain untouched. Later inspection may recover a now-valid parent-complete
quarantined record into a new snapshot, while malformed quarantine remains untouched. Each job
reports a content-minimized heartbeat every 30 seconds,
the native operation has a 120-second absolute deadline, each request retains its 30-second deadline,
and at most 200 moves run per repair with eight in flight. There is no delete or conflict-adjudication
authority. Once started, a title-repair job cannot be cancelled through MCP because the underlying
Tauri invocation has no cancellation channel; the native 120-second deadline remains authoritative.
Closing the app terminates the process, but is not a transactional rollback: the recovery snapshot is
written first, moves are recoverable, and the caller must inspect again before retrying.

## Local bridge and security boundary

```text
MCP host
  `- spawns `Syzygy --mcp` over stdio
       `- authenticated POST to ephemeral 127.0.0.1 port
            `- Rust emits semantic request to main webview
                 `- live Zustand + Lexical/Yjs operation
                      `- typed response follows the same path back
```

- The GUI binds an ephemeral IPv4 loopback port; it never listens on the LAN.
- Each GUI process creates a random 256-bit bearer token and a small descriptor at
  `${temp}/syzygy-automation-v1.json`. On Unix the descriptor is set to mode `0600`; Windows
  relies on the current user's temp-directory ACL.
- Browser-origin requests are rejected even when they somehow know the token. Requests and
  headers are bounded; live operations time out after 15 seconds.
- The descriptor contains only schema version, port, token, process ID, and app version. It has
  no OAuth credential, prompt, project content, or model secret and is removed during normal GUI
  shutdown.
- Research content is not added to the diagnostic log. Backend failures record only the command
  name and error, following the existing typed `tauri.ts` boundary.
- This protects against remote/LAN callers and blind browser requests. It is not a sandbox from
  malware already executing as the same OS user; such a process can already access the user's
  local app data and input devices.
- MCP tools do not receive ambient filesystem or local-model authority. Drive access is absent unless
  the caller explicitly invokes one of the named Drive-project tools. Catalog reads return bounded
  identity metadata without OAuth tokens, Drive file IDs, or document content. Share requires the
  exact active document revision and publishes only a local project's captured Yjs state. Join
  refetches and matches exact workspace/project/document identity before local registration. These
  calls do not grant general Drive file, filesystem, credential, or model access. Broader actions need
  their own typed proposal/confirmation contracts.
- `inspect_research_state` is read-only and content-minimized. It checks the same live Y.Doc owned
  by the editor/local provider, caps returned items, and has no scenario/label/heuristic/version/document mutation
  path. Titles, attribution, IDs, counts, and timestamps are metadata and may be returned; policy
  text, scenario backgrounds/turn content/revision, annotation, voter, and label-event bodies,
  heuristic guidance and edit values, and version notes are deliberately omitted. Scenario branch
  ancestry plus vote/annotation/label targets are checked; peer-colliding public identities or
  events fail closed. Aggregate vote counts, annotation lifecycle/event totals, and label names/
  assignments are metadata returned to the connected host. Explicit signed device registrations add
  stable public fingerprints, self-reported participant IDs, conflict state, and integrity counts.
  Those entries are durable shared project metadata and can correlate an installation across projects;
  bounded relay-approval projection adds only action kind, expected revision, counts, and integrity
  state. `relay-policy-state-not-part-of-shared-project` means a fresh relay room report is required
  to know whether the host currently enforces a signer quorum. Inspection omits approval action
  bodies, keys, signatures, participant IDs, and expiry timestamps and cannot register, sign,
  approve, configure policy, revoke, authenticate, assign a role, or change relay access.
- `inspect_relay_approval_policy` is a separate authoritative host-local read. It works only when the
  active WebSocket project's exact endpoint and room belong to the relay running in this Syzygy
  process. It returns aggregate member counts, current policy key IDs/quorum, and healthy project-
  directory key IDs without member IDs, capabilities, signer public keys, relay paths, or research
  bodies. `configure_relay_approval_policy` requires that inspection's exact registry revision and
  either a unique 1-16-key eligible signer set plus bounded quorum or an explicit policy removal with
  no hidden signer fields. It fails before mutation for a remote relay, stale revision, unhealthy
  directory, conflicting/unknown key, or malformed set, and it accepts success only when the native
  response proves the exact +1 revision and requested policy. The relay host remains emergency local
  authority. Installation keys are not authenticated people, organizations, or legal consent.
- Adversarial start requires the exact live document revision and 1–200 block indexes. Sources
  are derived from those blocks rather than accepted as arbitrary MCP text. Only built-in remote
  provider IDs are accepted. Start returns immediately; at most eight jobs run; heartbeats are 30
  seconds; the absolute deadline is 15 minutes; terminal results expire after one hour.
  Cancellation reaches the native provider registry. Completion remains transient and pending
  human review. `save_adversarial_review` is the explicit boundary that makes the full question,
  selected excerpts, and result shared project content; on Drive-backed projects it can therefore
  synchronize to collaborators. `decide_adversarial_review` stores only an immutable decision
  event. Both require the exact research revision and neither edits the document.
- `create_scenario` requires the exact monotonic Yjs research revision returned by
  `inspect_research_state`. A stale revision fails before mutation; the frontend domain harness and
  packaged live harness assert zero stale writes. After commit, Syzygy resolves the exact retained
  creation edit and best-effort signs its canonical hash under a length-prefixed scenario/edit
  locator. The response returns signed-device or explicit unsigned attribution and recomputes the
  research revision after publication, so it can safely guard the next call. Signing failure leaves
  the scenario committed. Participant identity/time remain caller/process supplied, and the tool
  does not generate turns.
- `add_scenario_turn` and `revise_scenario_turn` use the same guard. Chain the returned research
  revision into the next mutation. Revision retains earlier turn bodies and attribution; stale
  calls fail before mutation. Ordinary revision also fails while a turn has multiple tips.
  `reconcile_scenario_turn` then requires the exact selected head and the complete sorted tip set
  returned by the latest scenario read. It appends one new revision whose parents are every sibling;
  an incomplete/stale set writes nothing, and a later sibling reopens reconciliation. These tools
  store explicit caller content and never contact a model.
- `read_scenario` is the deliberate discovery boundary missing from broad inspection. It validates
  exact project/scenario identity, discloses one scenario background, and returns the ordered IDs,
  roles, revision counts, selected heads, complete tip sets, and reconciliation state for at most
  1,000 turns. It omits every turn body and performs no Yjs write.
- `read_scenario_turn_revision` then reads one chosen body. It requires exact scenario/turn identity
  and accepts either one immutable edit ID or one zero-based revision index, validates the live graph,
  returns at most one 200,000-character body, and performs no Yjs write. Omitting both selectors reads
  the persisted selected-head revision. The returned research revision can be chained into a later
  guarded mutation after the researcher reviews the disclosed content.
- `cast_scenario_vote` uses the same guard and retains each attributed vote/re-vote/withdrawal as
  an immutable event. After that mutation commits, Syzygy best-effort signs a canonical hash of the
  exact vote event and publishes a parallel bounded attestation only when the same installation key
  is an unconflicted registration for the claimed participant. Signing failure never rolls back or
  disguises the already-committed vote: the response says `unsigned` with a bounded reason. Research
  inspection returns event/key/participant/hash metadata but omits public keys, signatures, display
  names, and vote bodies. A stale call fails before adding an event. Installation signatures improve
  attribution continuity but are self-issued device claims, so the tool is not an authenticated
  election, person/organization identity, or Sybil-resistant consensus. Eight of ten named event
  kinds now have production resolvers; heuristic and scenario-rerun remain unsigned
  until their domain and product/MCP mutation paths adopt the same ledger. Suggestion proposal and
  decision tools now follow the same commit-first exact-retained-event pattern.
- Scenario-turn add, revise, and reconcile retain an exact immutable revision before best-effort
  registered-device signing. The canonical hash binds edit ID, role, body, participant, caller time,
  complete parent set, and create/edit/reconcile source; a length-prefixed locator binds the scenario
  and turn identities. Cross-author claims and changed retained bodies fail verification. Signing
  failure leaves the turn committed and explicit unsigned, inspection omits turn/proof bodies, and
  every response returns the post-attribution research revision. The signature proves only
  installation-key possession.
- Annotation create uses the research revision guard. Edit/resolve/reopen additionally require the
  exact `currentEventId` returned by the preceding mutation or inspection. Both stale-research and
  stale-lifecycle conflicts fail before an event is added. Bodies are accepted for create/edit and
  retained locally in immutable history, but mutation responses and inspection return only IDs,
  kind/status, target, timestamps, and event counts. After commit, all four lifecycle operations
  best-effort sign the exact retained event under the same registered-device rules as votes; the
  response says `signed-device` or `unsigned`, and inspection omits proof, display-name, and body
  fields. Identity/time remain caller/process supplied and a signature does not authenticate them.
- Label create uses the research revision guard. Rename additionally requires the exact label
  `currentEventId`; an assignment's first event requires no event parent and every follow-up add/
  remove requires its exact assignment `currentEventId`. Stale research or event parents add no
  event. Each operation retains the exact event first, then best-effort signs a strict label- or
  assignment-event hash with the registered installation key. Responses include signed-device or
  explicit unsigned attribution; signing failure never rolls back the mutation. Inspection returns
  only bounded key/event/hash metadata and omits label names, proof bodies, and signatures. Caller
  identity/time remain unauthenticated and a device signature does not authenticate a person. The
  returned `researchRevision` is recomputed after any attestation publication, so it is the guard
  for the next MCP mutation rather than the pre-signature project revision.
- `save_adversarial_review` validates and commits the complete content-addressed archive before
  best-effort signing its exact strict envelope. `decide_adversarial_review` commits one immutable
  exact-parent decision before signing a canonical body that includes its archive hash, participant,
  display name, notes, and timestamp. Separate archive and length-prefixed decision locators prevent
  identity ambiguity; retained-author re-resolution rejects correctly signed cross-author claims,
  and changed stored archive or decision bodies stop verification. Signing failure leaves either
  record committed and explicitly unsigned. Product and MCP return the post-attribution research
  revision, while inspection omits archive, decision-note, display-name, public-key, signature, and
  proof bodies. These are installation-key continuity claims, not authenticated human judgments.
- `save_active_policy_version` requires `expectedDocumentRevision` from `read_active_project` and,
  when non-null, `expectedHeadVersionId` from `inspect_research_state`. The live editor revision is
  checked once before hashing and again inside the final Yjs head transaction; the existing head
  and parent bytes are rechecked there too. A conflict inserts no record in the committed harness.
  After commit, the tool best-effort signs the exact content-addressed version envelope. The result
  is explicitly signed-device or unsigned and includes the post-attribution `researchRevision`;
  signing failure never rolls back the checkpoint. Participant ID/display name are caller-supplied
  historical attribution, and an installation signature does not authenticate a person.
- `restore_active_policy_version` requires `targetVersionId` from bounded version inspection,
  `expectedDocumentRevision` from `read_active_project`, and the exact non-null
  `expectedHeadVersionId` from `inspect_research_state`. The existing restore transaction
  validates target lineage/project identity, rechecks document and head, replaces exact semantic
  blocks, and appends a new immutable child. A stale document or head adds no version, and a
  synthetic editor failure restores the prior draft/head. Participant ID/display name remain
  unauthenticated. The appended child is then attributed under the same exact-envelope,
  explicit-unsigned, no-rollback contract as save, and the returned research revision includes any
  attestation publication.
- `syzygy_installation` discloses the executable and parent-folder paths to the already-connected
  local MCP host. These paths are local machine metadata, contain no OAuth token or research
  content, and are also visible to the user in Settings.
- `syzygy_platform_contracts` embeds the public schemas and truthful implementation states.
  It reports ordinary remote execution separately from live-provider proof; adversarial execution
  is `native-multi-provider-executor-resumable-mcp-pending-human-review`, authorization is
  `native-content-bound-call-graph-authorizer`, and reservation/execution is
  `native-atomic-dependency-bound-executor`. Plugin loading and custom-adapter execution remain
  `contract-only`. The platform-contract response contains no provider key, account, project
  content, Drive credential, prompt, or model output.

## Private-LAN multi-install control

The development LAN control plane lets one MCP host drive multiple installed Syzygy applications
without exposing their GUI bridges. The primary installed app can own and supervise the coordinator
from its Settings host toggle; `scripts/lan-mcp-host.mjs` authenticates to that loopback attachment
instead of opening a duplicate listener. If app host mode is absent, the wrapper retains a diagnostic
self-owned fallback. Every installation joins through its packaged `Syzygy --lan-agent` mode. The coordinator exposes
`lan_nodes`, `lan_node_tools`, `lan_call`, and read-only `lan_probe`. Calls retain the selected
installation's native tool schemas, revision conflicts, disclosure prompts, and mutation guards.

The LAN stream is pairing-key authenticated and encrypted; it has 15-second heartbeats, 45-second
stale eviction, replay counters, bounded frames, and a one-minute absolute operation ceiling. It
must bind one explicit private address and must never be router-forwarded or exposed publicly. The
GUI automation descriptor and bearer listener remain in the local user's temp directory and on
`127.0.0.1` respectively.

This is a control-plane claim, not a project-convergence claim. See `LAN-MCP.md` for setup, threat
model, commands, and current non-claims.

## Executable evidence

Run the cross-layer headless contract harness:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:mcp
# packaged binary self-description/protocol proof, without launching the GUI
node ..\scripts\mcp-harness.mjs --executable <absolute-Syzygy.exe>
```

It fails unless:

1. live Lexical reads return structured blocks and stable revisions;
2. replace/append operations change the same editor and reject a stale revision;
3. the loopback parser accepts an authenticated request and rejects browser origins;
4. MCP initialization negotiates the current `2025-11-25` protocol revision;
5. all thirty-nine semantic tools are discoverable and route to their intended live operation, including bounded Drive project catalog/share/join, exact shared-title rename/retention guards, exact scenario sibling reconciliation, and adversarial archive/decision actions;
6. self-description returns absolute paths and copy-ready configuration without a GUI;
7. platform contracts parse, keep provider-run/adversarial/plugin schemas strict, and do not
   overstate unimplemented runtimes; and
8. the actual compiled application binary speaks newline-delimited JSON-RPC over stdio without
   contaminating stdout.
9. research-state inspection rejects tampered hashes/lineage and omits synthetic secret bodies; and
10. `syzygy_platform_contracts` returns the strict S-06 network-boundary manifest and its headless self-check command without research content.

The harness uses a fake semantic live responder for protocol routing and the real Lexical editor
for mutation behavior. A packaged-app live smoke proof remains a separate release check because
it opens the user's actual WebView profile.

The 0.1.10 onboarding/self-description run is recorded in
`docs/audits/runs/MCP-SETUP-2026-07-14.json`, including the packaged executable path, tool count,
installer size, compile marker, and explicit test limitations.

For an explicit end-to-end proof against the current user's real app profile, build the app and
run `npm run test:mcp:live`. It launches the GUI if needed, creates a visible `MCP pilot` project,
replaces/appends its document, creates a scenario, adds/revises a turn, support/re-votes, runs a
flag/note create→edit→resolve→reopen lifecycle, deliberately attempts stale writes at every layer,
and reads bounded state back. Because this is a real mutation, it is deliberately excluded from CI
and must not be run without intending to keep the demonstration project.

## Design sources

The protocol behavior follows the public MCP specification and is implemented in Penumbra-owned
Rust/TypeScript code. No PolicyPad or Tiptap code, prompts, schemas, fixtures, UI, or automation
material is used. Protocol references checked 2026-07-14:

- <https://modelcontextprotocol.io/specification/2025-11-25>
- <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
- <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>

## Network-boundary contract

`syzygy_platform_contracts` embeds `docs/audits/NETWORK-BOUNDARIES.json`. An external reviewer can enumerate each feature’s default state, activation, service origins/routes, payload classes, credential handling, source/copy anchors, evidence, and explicit limitations without opening the GUI. Run `npm run test:network-boundaries` to verify the checked-in manifest and scan every production URL literal. The returned contract is public metadata; it contains no credential, account, project, prompt, response, or file body.

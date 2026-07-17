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

Long unattended goals use the complete
[worker/supervisor framework](UNATTENDED-GOAL-FRAMEWORK.md), not the command watchdog alone. Start
from the checked-in goal and supervisor templates; the independent supervisor stays read-only,
recovers after two silent one-minute checks, resumes from the last verified Git checkpoint, and
removes itself when the goal finishes.

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
It does **not** yet prove two-machine rich text convergence or Drive transport; those
remain separate capability gates.

Portable archives are covered by `projectArchive.test.ts` and
`ProjectArchiveControls.ui.test.ts`. The domain fixture exports the exact Yjs state, reopens every
reserved shared collection through IndexedDB without a network provider, and rejects corrupted
hashes, future schemas, unknown envelope/manifest fields, project/document collisions, identity
mismatch, oversized input, and different orphaned local state. The server-rendered UI contract
requires import with no current project, disables export before the live document is ready, and
announces errors. This is engine-free, fake-IndexedDB evidence; S-04 remains
`implemented_unverified` until a packaged archive is exported on one clean installation and
imported offline on a second clean installation.

The editor structure slice is covered by `ResearchEditorFormatting.test.ts`,
`editorStructure.test.ts`, `ResearchTableOfContents.ui.test.ts`, and `PolicyBlockNode.test.ts`.
The first three prove supported heading/quote/mark structure, a shared pointer/keyboard reorder
command, and a live-derived accessible outline. The policy fixture intentionally includes one
`it.fails` partition case: moving a block on one peer while another peer edits that same block can
lose the edit in Lexical's Yjs root delete/insert representation. That expected failure is a
release gate for remote collaboration, not a passing convergence claim.

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
round-trip, attributed immutable turn revisions, branch lineage, independent concurrent field and
turn additions, delete-versus-nested-edit, peer-colliding public scenario/turn IDs, exact record
shapes, malformed order, and missing-parent inspection. Eighty seeded duplicate/reordered delivery
checks must converge. `ScenarioWorkspace.ui.test.ts` adds an engine-free product contract for
loading/empty/error states, create/select/detail controls, ordered turn addition, vote controls,
the unauthenticated-identity disclosure, deterministic stale-detail detection, and read-only
integrity failure. This does not prove turn revision editing, generation, evaluation, annotations,
labels, scenario packs, packaged pointer/focus behavior, or a remote collaboration provider.

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
`2025-11-25`, discovers its twenty-five tools, checks notification framing and ping, calls a typed live
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
background/turn/revision/voter bodies, heuristic guidance/edit values, and notes. Rust tests require the
thirteenth `inspect_research_state` tool to route only to this read operation. The mutation-capable
live harness checks it when explicitly run; CI does not claim a packaged GUI proof.

`scenarioAutomation.test.ts` is the MCP scenario-mutation gate. Inspection returns a monotonic Yjs
state-vector revision and rejects an internally inconsistent read if state changes during its
asynchronous hash checks. Creation requires that exact revision, rechecks project identity, and
mutates the registered live Y.Doc synchronously. Add-turn and revise-turn require the revision from
inspection or the immediately preceding mutation; revisions retain both authors and bodies. Stale
tests prove zero scenario/turn writes. Rust routing and the packaged live harness cover the
fifteenth through twenty-fourth tools. The voting gate chains support, re-vote, and withdrawal events,
then proves a stale call adds no vote event; MCP output exposes aggregate counts, not voter bodies.
The annotation gate chains create, edit, resolve, and reopen under both project-research and exact-
current-event guards, then proves both conflict classes add no lifecycle event. MCP output and
inspection omit every annotation body. The label gate chains create, rename, assign, and remove;
rename/follow-up assignment require both research and exact-current-event guards, and both stale
conflict classes add no event. This grants direct scenario content editing, attributed voting,
annotation lifecycle, and shared-label mutation—not model generation, authenticated identity, or
gallery UI.

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

The same command certifies the unwired Anthropic Messages one-shot boundary. Its fake server checks
`POST /v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`, developer-to-system and user-to-
message mapping, `max_tokens`, `stream:false`, normalized text/usage, unknown thinking-block
non-retention, error-body redaction, timeout, and cancellation. This does not prove Anthropic SSE,
tools, a live credential, or product availability.

It also certifies the stable-v1 Gemini Interactions one-shot boundary. The fake server checks
`POST /v1/interactions`, `x-goog-api-key`, `store:false`, `background:false`, `stream:false`,
`thinking_summaries:none`, system/user mapping, output bounds, text-only normalization, aggregate
usage consistency, sanitized failures, timeout, and cancellation. The test rejects `/v1beta`
instead of silently drifting API versions. Gemini SSE, tools/thought-signature continuation, a live
credential, streamed product delivery, and product availability remain open.

The xAI Responses one-shot boundary uses the Responses shape without assuming OpenAI's privacy
semantics. The fake server checks bearer auth, `store:false`, no previous-response/cache identifier,
bounded normalization, timeout/cancellation, and a mandatory boolean `x-zero-data-retention`
response header. The result preserves that ZDR attestation for later disclosure. xAI streaming,
tools/reasoning continuation, streamed product delivery, and live proof remain open.

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
`ProviderResearchTaskRequest` carries a question, optional task instructions, and labeled source
snapshots; Rust serializes the actual payload, derives the categories and unique provenance IDs,
then validates bounds before opening the native dialog.
Evidence and remaining domain/live-provider gaps are recorded in
`docs/audits/runs/PROVIDER-RESEARCH-ENVELOPE-2026-07-15.json`.
The evidence and explicit limitations are recorded in
`docs/audits/runs/NATIVE-PROVIDER-DISCLOSURE-2026-07-15.json`.

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

`npm run test:provider-streams` separately feeds the OpenAI decoder byte-by-byte and with
multiline, unknown, malformed, mismatched, oversized, and truncated SSE fixtures. It proves parser
normalization in isolation. `test:providers` separately proves the parser is fed through fake HTTP
streaming and that the same controls wrap both one-shot and streamed transport.

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

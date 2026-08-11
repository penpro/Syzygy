# Syzygy Design System

> Paper & ink research aesthetic. Sister app to Aphelion (dark void / corona glow) —
> deliberately its visual opposite, the way the names are astronomical opposites.

## Name & mark

- **Syzygy** (n.) — an alignment of celestial bodies. Aphelion = the farthest orbital
  point (solitary, offline AI); Syzygy = alignment (people and documents converging).
- **The mark**: three bodies on a horizontal orbital axis — two ink satellites flanking
  an Observatory-Blue primary (`SyzygyMark.tsx`). The animated splash version
  (`SyzygySplashMark`) drifts the satellites in from off-axis and fires a **small,
  thin-rayed ochre glint just off the primary's upper-right limb** at the moment of
  alignment (the Penumbra flair — subtle, never an emoji-style star). Its **resting
  (unanimated) state is perfect alignment**, so reduced-motion shows a clean static mark.
- **Wordmark**: `SYZYGY` letterspaced (`.brand-word` / `.splash-title`: IBM Plex Mono,
  700, tracking ~0.32–0.42em).

### Shipping identity assets

- `frontend/src-tauri/syzygy-icon.svg` is the single OS icon source. Tauri derives Windows,
  macOS, Linux, iOS, Android, and Store sizes from it.
- `scripts/generate-brand-assets.ps1` regenerates the platform icon set plus the NSIS header and
  sidebar bitmaps. Installer artwork is committed so release builds are reproducible.
- The audit fails if installer copy returns to Aphelion or the old app-data identifier.

## Palette

| Token | Hex | Use |
|---|---|---|
| Warm Paper | `#F6F2E7` | app background (`--bg`) |
| Panel Paper | `#FBF8F0` | cards/panels (`--panel`) |
| Research Ink | `#0B1D2A` | text (`--text`), borders (ink-mix, not accent-mix) |
| Observatory Blue | `#2E5C8A` | primary accent (`--accent`) — buttons, active states |
| Muted Teal | `#4C7F7A` | secondary accent (`--accent-2`) — success-ish notes |
| Oxidized Copper | `#B26D4A` | warnings (`--magenta`/`--warn` slot) |
| Ochre | `#D6A24C` | sparkle/highlights (`--violet` slot) |
| Danger | `#B3382E` | destructive |

## Typography

**IBM Plex** family, bundled via `@fontsource` (offline — never a CDN):
- **Plex Sans** — everything human (body, headings).
- **Plex Mono** — "machine" type: labels, data, metadata stamps, the wordmark.
  Section labels render as mono small-caps (`.side-head span`, field labels — 10.5px,
  letterspaced, uppercase).
- **Plex Serif** — installed for future document-editor surfaces (mockup uses it for
  editorial headings); largely unused today.

## How theming works (don't fight it)

Three layers, all CSS:
1. `brand-tokens.css` — the Penumbra brand constants (Aphelion's palette lives here).
2. `styles.css :root` — app tokens (`--accent`, `--bg`, `--panel`, `--text`, `--border`,
   `--font`…) aliased to brand tokens; borders/glows **derive** from `--accent` via
   `color-mix`.
3. `[data-theme='…']` presets — override accent + surfaces (+ for the light `syzygy`
   theme: text, borders as **ink**-mix, flat shadows instead of glows, IBM Plex fonts,
   tighter radii). `App.tsx` stamps `data-theme` on `<html>` from settings.

**Rules:**
- **Never hard-code a color in a component.** Use tokens (`var(--accent)` etc.). The
  paper theme exposed every hard-coded dark hex as a bug (SetupWizard had ~8).
- `syzygy` is the default theme; the dark presets (penumbra/synthwave/cyber/ember/
  bloodmoon) remain selectable, so styles must work on paper *and* void → always pair
  colored backgrounds with token text colors.
- Paper is **flat**: no glow, no starfield. `[data-theme='syzygy'] body` kills the
  Aphelion background stack.

## Motion

- Subtle and purposeful; the splash alignment loop (4.6s) is the ceiling for flourish.
- Respect reduced motion: `a11y.css` globally freezes animations when
  `html[data-reduce-motion='true']`; design animated elements so their **base state is
  the finished state** (see the splash mark).

## Voice (copy rules)

- **Local-first, not offline-absolute.** Local inference needs no paid API and stays on this
  computer. The app also supports explicitly approved remote-provider calls, model downloads,
  update checks, and Google Drive. Absolute claims like "nothing ever leaves this PC" are
  **Aphelion's** hallmark and are now false here; they were audited out — don't
  reintroduce them.
- Plain, concrete, a little warm. Explain what a thing does and where files land
  (real paths beat abstractions: "Documents\Syzygy, synced with Drive").
- Errors: say what failed, why, and the one action that fixes it (see the consent-
  checkbox helper modal for tone).

Local inference is a reversible resource choice, not an onboarding requirement. First run offers
**Continue without local AI** alongside model download. The title bar places a labeled, accessible
switch beside VRAM; off means the model is unloaded and the Ask composer explains that projects
and configured remote-provider reviews remain available. Turning it on with no downloaded model
opens model setup. Never describe an API-only or no-AI session as degraded.

## Reference

The approved mockup (brand sheet: logo variants, research-editor concept, design tokens,
applications) lives in the project chat history; palette + type above are its canonical
extraction. The **research editor** panel of that mockup is the design target for the
future collaborative workspace view (version rail, scenario/evaluate panels, metadata
stamps in mono small-caps).

## Research workspace slice

The first workspace implementation follows the approved structure without reproducing another
product's interface: a narrow version rail, a centered paper document, and a private scenario/
evaluation panel. Versioning is live: the rail provides a compact optional note, an explicit
**Save current draft** action, current-head marking, historical author/time/hash stamps, and a
bounded block-change list. Saving and diffing require no model. The researcher display name is
editable in Settings and old attribution remains visually historical.

The optional **Remote perspective** advanced tool panel accepts only the documented bounded schema
subset. A returned function call is always labeled **inspect only · not executed**. Each call shows
one separate structural state—schema pending, matches, mismatch, or definition missing—alongside
**domain unreviewed · not executable**. Validation failures may show bounded path/keyword codes but
never an execution affordance. A green structural match must not look like approval, truth, safety,
or permission; domain review and any future authority grant are distinct later actions.

Restore is a deliberate two-step action on a non-head checkpoint. **Prepare restore** reveals the
exact short checkpoint ID, a cancel action, and **Restore as new version**. The copy states that the
live draft is replaced, a new child is created on the current head, and existing versions remain.
The UI identifies local versus Drive-shared projects precisely. Scenario response generation, versioned scenario-rerun evaluation, and exact baseline comparison/export are available; installed-network real-time presence remains unclaimed.

Portable project movement is available from both the empty workspace and an open project. **Export
offline copy** stays disabled until the live collaboration document is ready; **Import offline
copy** remains available with no project open. Archives use the visible `.syzygy-project.json` suffix, report
cancel/success/failure in accessible live text, and open imports locally after validating identity,
checksums, size, and existing-install collisions. Copy must not imply that an imported archive is
still connected to another researcher's Drive folder or that credentials/model settings moved with it.
The project sharing strip explicitly says offline copies do not keep syncing.


Drive connection belongs to the research workspace as well as Ask. The sidebar keeps a permanent
**Drive** destination plus **Drive & shared projects** in the project list; both switch to the
project/collaboration home without archiving, deleting, or changing an existing project. That home
shows account link, exact folder selection, optional mirror Sync, offline import, and shared-project
discovery together.

Drive sharing is an explicit project action. Every open local project shows a persistent
**Project sharing** strip that distinguishes ongoing Drive collaboration from an independent offline
copy. **Share this project** is disabled until the live local document is ready, publishes its exact Yjs state into the selected workspace, and then remounts the
same project identity on the Drive provider. With no project open, **Shared Drive projects** explicitly
searches bounded Syzygy-owned roots visible to the connected Google account; it must work before a
workspace has been selected locally. Each row shows the exact parent folder name and short code and
offers **Join** unless the project/document identity already exists. Join validates and selects that
exact folder before adding the project. Every refresh reports check time, project/folder counts, skipped
ambiguous or unreadable roots, or a visible sanitized error; an empty list may never look like a button
that did nothing. The header reports connecting, synced time, error, or offline-copy state. A ready
Drive-shared project offers **Compact Drive history** as an explicit maintenance action. Its tooltip
states that a complete snapshot is appended before only already-applied records are archived, while
concurrent records remain active. Success and partial results report archived, remaining, and
concurrent counts; a partial run is safe to repeat and is never described as data deletion. Shared
titles use an explicit **Rename shared project** action. The field becomes editable only after the
current title state is loaded. Editing captures the exact shared revision guards at that moment;
an incoming rename leaves the draft visible but makes the save fail stale instead of silently
overwriting the peer. Simultaneous renames display every current title and author in an accessible
alert. **Reconcile shared title** requires choosing or editing a title against the complete current
tip set, while copy states that every competing title remains in history. The deterministic title
shown while conflicted is a stable projection, not an adjudication. **Retain title history** is a
separate maintenance action: it reports retained/active/snapshot counts, creates a complete immutable
snapshot before recoverable archival, and reports partial work as safely retryable. It must never
suggest that retention resolved a title conflict or authenticated its authors. Researcher names and
timestamps remain self-reported; 200 active event files stop new renames and require retention
(reads tolerate a bounded 400-file concurrency overflow), and the retained graph
still fails closed at its explicit 5,000-event/4-MiB bounds rather than hiding history.
**Check title recovery** remains available even while normal shared-title loading is blocked. It is
an inspect-first maintenance flow, not an automatic repair banner: the first action reports only
recoverable/active/archive/quarantine counts. When repair is required, the confirmation states that
a complete validated snapshot is appended before any move, invalid active records go to a
recoverable quarantine folder, invalid archived records remain untouched, and nothing is deleted.
**Repair from retained history** consumes the exact inspection revision; stale inventory fails with
an instruction to inspect again. Partial work reports the remaining count and requires another
inspection. Successful copy says to reopen a project if the earlier provider initialization was
already blocked. The surface never displays repair record names or Drive IDs, calls quarantined data
trusted, adjudicates title conflicts, or suggests authenticated provenance.
The UI must not describe polling as real-time presence.
A compact **Presence** strip below the editor toolbar always names the actual capability. Local
projects say that no remote editing session is connected. Drive-shared projects say edits sync
but live cursors and online status are unavailable. A future live provider may show bounded
session chips with **this device**, **editing**, or **viewing** state. Invalid/excess peer records
produce an accessible warning rather than rendering attacker-controlled identity data. Live mode
must state that presence is ephemeral and collaborator names are self-reported, not authenticated.
Live offline/LAN project synchronization is not implemented; the portable archive is a handoff that
creates independent local state after import.
The scenario panel is an engine-free shared workspace, not an AI demo. It shows honest loading,
empty, integrity-error, and mutation-error states; creates and selects stable scenarios; edits title,
background, and workflow state; creates ordered role/content turns; and appends attributed immutable
turn revisions. An edit session captures the exact current revision. If a peer advances that turn
or adds a sibling while the selected head remains unchanged, Save is disabled while the unsaved
draft remains visible until Reload shared is chosen. Conversation
pages and visible revision lineage are each bounded to 50 items without deleting shared history.
If disconnected peers create sibling revisions, the turn shows a prominent conflict card with the
complete sibling count, disables ordinary **Edit**, and offers one explicit action per sibling.
Choosing a sibling does not erase the others: the confirmation copy states that every sibling is
recorded as a parent, and the resulting attributed merge revision becomes the new shared head.
Stale or incomplete sibling choices fail visibly without changing history; a later sibling makes
the conflict visible again. This flow performs no model call and never labels a selection correct.
The panel also exposes support, oppose, abstain, and withdraw controls with aggregate counts, shared
scenario/turn notes and flags with edit, resolve, and reopen history, plus project context-label
creation, assignment, removal, and rename. A stale detail, turn, annotation, label, or assignment
write must fail instead of overwriting newer shared history. When scenario, turn, annotation, or
label integrity fails, the affected mutation controls are disabled. Copy states that installation
researcher identity and local time are not authenticated.

**Portable scenario packs** sit inside the scenario workspace and remain usable without AI. New
exports use the strict v2 format with durable turn heads and revision-parent sets; checksummed v1
packs remain importable through deterministic migration. Researchers
can export the selected scenario plus its required ancestors or every scenario, and can set a title,
description, and optional license. Copy names the included authoring history and explicitly excludes
votes, annotations, labels, model outputs, policies, and project files. Import is two-step: choose and
validate the checksum/schema/graph first, then explicitly confirm the collision-free plan. Exact
duplicates are skipped; a same-ID/different-content collision blocks the entire import. Neither path
contacts a model or network. The hidden file input follows the existing portable-archive affordance.

The **Response variants** surface is optional and never blocks manual scenario work. **Write
response** creates a shared human variant without starting a model; **Edit** appends an attributed
revision against the exact displayed parent and retains every earlier model or human version.
Installation-provided researcher identity is explicitly unauthenticated. If the shared current
revision changes during editing, the unsaved draft remains visible, saving is disabled, and **Reload
shared** is the explicit recovery. Invalid scenario or response history pauses manual edits,
**Generate variant**, and **Regenerate** before model, credential, or network work. The surface distinguishes local generation on this computer from API routes that require the native
**Send once** disclosure. With local AI off or unloaded, local generation is disabled while manual
editing and API selection remain available. Provider/model metadata is visible; copy must not imply
that a variant changed the policy draft, was evaluated, or is true. **Regenerate** creates a child of
the exact current revision. It never replaces or hides earlier content. Response lists page at 50;
expanded **Variant lineage** shows at most the 50 most recent revisions while reporting the complete
retained count. If a response changes while a provider runs, the stale result is refused.

The **Shared evaluation examples** surface remains useful with AI disabled. Researchers can create
project heuristics, select required/recommended/watch priority, and attach explicit positive or
negative examples. Every active example shows its polarity and historical display-name attribution;
removal is an explicit action that retains shared history rather than erasing it. Loading and failure
states are accessible, all treatments use theme tokens, and copy states that collaboration identity
is installation-provided rather than authenticated. The surface must not imply that examples have
been scored, validated as true, or applied to policy text.

The selected heuristic includes an **Explainable policy check** below its shared examples. The
provider and model are explicit; local-unavailable copy preserves manual work, while API copy names
the bounded heuristic/examples/current-policy disclosure and native **Send once** approval. A result
must show PASS, FAIL, or UNCERTAIN with rationale, a separate residual-uncertainty statement, exact
expandable policy quotes and offsets, human attribution, provider/model, run, and source revision.
**Run again** creates another immutable shared result; it does not overwrite history or alter the
draft. Cancellation or stale-source failure saves nothing. Copy must not call a model verdict true,
validated, consensus, or a substitute for researcher review.

The **Versioned scenario reruns** surface sits in the shared scenario workspace. It requires a
verified immutable policy head, defaults to ready non-archived scenarios, and creates a paused queue
before any model work. Provider/model and every included scenario are explicit. Local-unavailable
copy preserves queues, results, and manual research; remote copy states that one exact policy version
and one exact scenario revision are prepared for each native **Send once** approval. Creator controls
are **Start / resume**, **Continue queue**, **Pause**, **Cancel**, and bounded **Retry item**. Every
item shows state/attempt, handled/unhandled/uncertain response, rationale, uncertainty, route/model,
attribution, and run identity. Collaborators can inspect results but installation-provided identity
is not authentication. Copy must not imply that evaluation is truth, consensus, a baseline
comparison, or an automatic policy edit.

The nested **Baseline comparison** surface lists completed queues only. **Baseline queue** and
**Candidate queue** remain explicit; **Compare exact runs** fails closed unless project, document,
prompt, scenario IDs, and exact revisions match. The matrix labels baseline rows and candidate
columns and reports only outcome transitions. It never labels a transition improved, regressed,
correct, or true. Each scenario shows responsive side-by-side response, rationale, uncertainty,
model, and run evidence. **Export verifiable JSON** remains disabled until a verified preview exists.
The disclosure states that both policy snapshots, exact scenarios, and all evaluation bodies will be
written, names the unavailable seed/sampler/model-hash fields, and asks the researcher to review the
destination. The comparison requires no AI, provider key, or network.

The editor uses Plex Serif for document content and Plex Mono metadata stamps, with every surface,
border, status, and selection derived from theme tokens.

The first original research node is a **policy block**: an editable statement with a stable ID and
`draft`, `review`, or `approved` state. Its paper treatment uses a quiet token-derived tint, ink
border, colored left rule, and mono status stamp. The status is descriptive, not a truth claim or
access-control decision. A toolbar action adds a block; later review controls and keyboard/pointer
reordering must preserve the same node contract. The toolbar exposes matching Move up/down
buttons and Alt+Shift+Arrow shortcuts, with unavailable directions disabled. Local projects
idempotently backfill stable content records. A Drive-shared project enables the commands only
after its live bridge reports every policy block has stable content and review-state identity;
while checking, unhealthy, or carrying legacy tree-only blocks, both controls stay disabled and
show the exact reason. A compact horizontal
outline derives from the live Heading 1/2 nodes, announces its empty state, scrolls on narrow
surfaces, and focuses the selected heading. All outline states use theme tokens.

A **scenario link** is inserted from a labeled toolbar selector and rendered as a compact inline
chip. The chip stores no title snapshot: it resolves the current title from the shared project and
shows a token-derived danger treatment plus stable ID when the target is missing. Renaming a
scenario therefore updates every open chip without changing document history. The control is
disabled while scenario data is loading or empty.

**Spotlight scenario** uses the same labeled selection and inserts a full-width paper card showing
the live scenario title, state, background, and turns. The card uses theme-token borders and quiet
panel tints, preserves long content, exposes its stable ID, and shows the same danger treatment for
a missing target. **Collapse to scenario link** changes presentation without copying scenario
content; the action is collaborative and undoable. The card must never imply that its projection is
an independent scenario copy.

A **suggestion** begins in the labeled **Proposed policy text** composer and is inserted as a
full-width review card. The card previews the shared proposal, its source revision, author or model
provenance, and stable ID without copying proposal text into the policy draft. Pending cards expose
explicit **Accept** and **Reject** actions. Decided cards show reviewer attribution and history;
opposite disconnected decisions show a prominent conflict state rather than silently choosing one.
Missing or invalid suggestions remain visible and fail closed. **Accept** records the human review
decision without changing the draft. An accepted, non-conflicted card separately exposes **Apply to
draft**, with copy that it replaces only that card with a `review` policy block and only when the
semantic policy content is unchanged. Stale policy content, stale editor revisions, missing/duplicate
cards, and policy-identity collisions stay visible as errors and leave the draft untouched. Rejected
or conflicted suggestions never expose Apply.

## MCP connection guide

Settings includes a **Connect an LLM** guide for people who should not need to understand MCP
internals. The flow is numbered and concrete: show the detected executable/install folder, copy
host configuration, copy a connection prompt, then copy a safe first task. Paths and generated
text come from the running Rust executable, not UI constants. Technical values use Plex Mono;
explanations stay in plain Plex Sans. Copy success is expressed in text, errors say what failed,
and all cards, borders, states, and narrow-layout behavior use theme tokens.

The copy must distinguish configuration from capability. A successful setup does not imply that
unfinished evaluation or presence features are available. Drive project sharing is controlled in the Workspace UI and is not ambient MCP authority.
It must also say that MCP does not automatically gain Drive, filesystem, or local-model authority.

Settings also includes **Private LAN test connection** as an opt-in advanced control. It asks for
a plain-language computer label, one explicit private coordinator address and port, and a pairing-
key file chosen through the native file picker. The status distinguishes saved configuration, a
running outbound agent, a running app-owned host, recovery, and actionable failure.
The UI must not infer connectivity from a child PID. It reports authenticated only after the
encrypted handshake event, otherwise shows starting, retrying, recovering, or stopped; it also exposes
the last successful handshake, retry count, sanitized failure, and an explicit **Reconnect now**
control.

The default client state says that the installation makes an outbound encrypted connection and opens
no LAN listener. The optional **Host the collaboration developer network on this computer** toggle says
that the primary opens one encrypted private listener and one authenticated loopback MCP attachment,
requires Node.js, starts and supervises the server with Syzygy, and stops/reaps it during shutdown.
PowerShell is explicitly diagnostic-only. Both modes must say that the control network does not itself
synchronize research data. Disabling or reconfiguring stops the old process before reporting new state;
app shutdown stops the outbound agent before the host coordinator.

## Future provider, panel, and plugin surfaces

Remote models are opt-in additions to a local-first product. Before first transmission, show the
provider, exact content categories, provider storage/training profile, and estimated call count.
Never collapse this into an unexplained "cloud mode," imply that every zero-retention option is
available, or place API keys in a web field that persists to app state.
The UI supplies structured question, task-instruction, and labeled-source fields; Rust derives the
human-readable categories. A component must never author a free-form category list that can
misdescribe what will be transmitted.

Provider key entry lives in a collapsed advanced Settings section so the local path stays primary.
Each row names the provider, uses a masked non-autofill field, reports only stored/not-stored, and
offers explicit replace/remove actions. The field clears immediately after a save attempt. Copy
must say that saving a key sends no research and that every remote task still gets a native
**Send once** disclosure. Status and errors use theme tokens and remain legible on paper and dark
themes.
Browser-only design previews show a neutral **Available in the installed app** state rather than a
false credential failure; the installed Tauri webview performs the real vault presence check.

The **Adversarial review** surface is a distinct, optional workflow below the single-provider
perspective. It lets the researcher select 1–200 exact non-empty draft blocks, configure two to
eight independent perspectives plus a blinded judge and compute-matched baseline, and see the exact
total remote-call count before native batch approval. Provider-key preflight reveals only
stored/not-stored state. The native dialog remains authoritative for exact bytes, routes, call graph,
limits, and budget.

While running, the product polls the same resumable registry exposed to MCP, reports its 30-second
heartbeat and absolute deadline, and offers cancellation. A completed result remains transient until
**Share full review with project** explicitly discloses that question, excerpts, outputs, baselines,
and provenance enter shared Yjs history and may sync through Drive. The history view exposes the
frozen question/sources, blinded proposals, cross-critiques, claim audit, minority findings,
order-swapped judgment evidence, compute-matched baseline, separate route provenance, token/cost
accounting, and immutable decision history. Conflicting archives or decision branches remain visible
with no selected winner. Evidence categories start closed so large bodies are not eagerly materialized;
opening one renders at most 50 artifacts per list, including nested proposal claims, with an explicit
bounded **Show next** control until every stored item is reachable. The synthesis and safety warning remain immediately visible.

Call the result "review" or "panel," never consensus or truth. **Record accepted** and **Record
rejected** append exact-parent human judgment only. Neither action changes, replaces, proposes, or
applies policy text. Any later apply workflow must be a separate revision-guarded proposal and diff.
Installation researcher names and timestamps remain self-reported, not authenticated.

Plugin permission screens use plain verbs and concrete scope: "Read this project," "Propose a
change," "Fetch from doi.org," or "Use the configured local model." Native MCP plugins carry a
stronger trust warning than capability-sandboxed WASI plugins. Advanced controls may be tucked
away, but requested authority and remote transmission are never hidden there.

## Network-boundary copy

Settings must expose one expandable **What can use the network** summary. It distinguishes the bundled loopback model, one-use remote-provider sends, selected-workspace Google access, manual model/update downloads, off-by-default crash reporting, and local/private-LAN automation. Each item names when it activates, where it connects, and the data class involved.

Do not say that the whole AI loop or the whole application “never phones home.” The accurate claim is narrower: the bundled local-model path stays on this computer; remote providers receive the disclosed request only after **Send once**; every other network feature follows the user action stated in the summary. Advanced placement may reduce clutter but must not hide authority or transmission.

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

- **Local-first, not offline-absolute.** The AI loop is 100% local — say that. The app
  as a whole touches the internet for explicitly invoked features (model downloads,
  update checks, Google Drive). Absolute claims like "nothing ever leaves this PC" are
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

Restore is a deliberate two-step action on a non-head checkpoint. **Prepare restore** reveals the
exact short checkpoint ID, a cancel action, and **Restore as new version**. The copy states that the
live draft is replaced, a new child is created on the current head, and existing versions remain.
The UI identifies local versus Drive-shared projects precisely; scenario generation/evaluation and real-time presence remain unclaimed.

Portable project movement is available from both the empty workspace and an open project. **Export
project** stays disabled until the live collaboration document is ready; **Import project** remains
available with no project open. Archives use the visible `.syzygy-project.json` suffix, report
cancel/success/failure in accessible live text, and open imports locally after validating identity,
checksums, size, and existing-install collisions. Copy must not imply that an imported archive is
still connected to another researcher's Drive folder or that credentials/model settings moved with it.


Drive sharing is an explicit project action. **Share to Drive** is disabled until the live local
document is ready, publishes its exact Yjs state into the selected workspace, and then remounts the
same project identity on the Drive provider. With no project open, **Shared Drive projects** lists
published manifests and offers **Join** unless the project/document identity already exists. The
header reports connecting, synced time, error, or offline-copy state. Shared titles are read-only in
this first transport slice because manifest rename has not been given a conflict-safe contract.
The UI must not describe polling as real-time presence.

The scenario panel is an engine-free shared workspace, not an AI demo. It shows honest loading,
empty, integrity-error, and mutation-error states; creates and selects stable scenarios; edits title,
background, and workflow state; appends ordered role/content turns; and exposes support, oppose,
abstain, and withdraw controls with aggregate counts. A stale detail form must reload instead of
overwriting a newer shared scenario edit. When graph integrity fails, all mutation controls are
disabled. Copy states that the installation researcher identity is not authenticated.

The editor uses Plex Serif for document content and Plex Mono metadata stamps, with every surface,
border, status, and selection derived from theme tokens so retained

The first original research node is a **policy block**: an editable statement with a stable ID and
`draft`, `review`, or `approved` state. Its paper treatment uses a quiet token-derived tint, ink
border, colored left rule, and mono status stamp. The status is descriptive, not a truth claim or
access-control decision. A toolbar action adds a block; later review controls and keyboard/pointer
reordering must preserve the same node contract. The toolbar now exposes matching Move up/down
buttons and Alt+Shift+Arrow shortcuts, with unavailable directions disabled. A compact horizontal
outline derives from the live Heading 1/2 nodes, announces its empty state, scrolls on narrow
surfaces, and focuses the selected heading. All outline states use theme tokens.

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

An adversarial review panel shows candidates blinded during judgment, source support, disagreement,
minority findings, order-swap instability, the compute-matched baseline, latency, and cost. Call it
"review" or "panel," not consensus or truth. Nothing enters the shared draft until the person sees
a diff and accepts it.

Plugin permission screens use plain verbs and concrete scope: "Read this project," "Propose a
change," "Fetch from doi.org," or "Use the configured local model." Native MCP plugins carry a
stronger trust warning than capability-sandboxed WASI plugins. Advanced controls may be tucked
away, but requested authority and remote transmission are never hidden there.

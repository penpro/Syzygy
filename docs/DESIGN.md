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

## Reference

The approved mockup (brand sheet: logo variants, research-editor concept, design tokens,
applications) lives in the project chat history; palette + type above are its canonical
extraction. The **research editor** panel of that mockup is the design target for the
future collaborative workspace view (version rail, scenario/evaluate panels, metadata
stamps in mono small-caps).

## Research workspace slice

The first workspace implementation follows the approved structure without reproducing another
product's interface: a narrow version rail, a centered paper document, and a private scenario/
evaluation panel. Incomplete controls are visibly disabled and described as upcoming; the UI must
not imply that versioning, Drive CRDT transport, scenarios, or real-time presence already work.
The editor uses Plex Serif for document content and Plex Mono metadata stamps, with every surface,
border, status, and selection derived from theme tokens so retained dark themes remain usable.

# Roadmap & History

> Where Syzygy came from, what's done, and what's next — so decisions don't get re-made.

## Lineage

1. **PolicyPad** (`kjfeng/policypad`, CHI 2026) — collaborative LLM-policy prototyping.
   Great ideas, but locked to paid services: Tiptap Pro ($59/mo registry), Tiptap Collab
   Cloud, Firebase, OpenAI + Together APIs. Reference clone: `D:\PolicyPad\policypad`.
2. **syzygy-web** (`D:\PolicyPad\syzygy-web`) — our Next.js fork that de-paywalled it:
   - Tiptap v2 → **v3** migration (the pro extensions went MIT in v3) — editor runs free.
   - Pluggable AI backend (`resolveProvider('reason'|'chat')`), local-first default
     `127.0.0.1:11435/v1`, cloud opt-in via env.
   Kept as the **porting source** for the collaborative editor.
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

## Next (in intended order)

1. **Prove the two-machine loop** — same Google account or a shared folder on two
   installs: document generated on A appears on B after sync; knowledge dropped on B
   answers questions on A. This validates the transport before any CRDT work.
2. **Port the collaborative editor** (task: syzygy-web → workspace view):
   - Transplant the Tiptap-v3 editor + custom extensions from syzygy-web into a
     `workspace` view beside Ask (state-driven, no router).
   - Replace Next-isms (next/image, cookies, server actions) with plain equivalents;
     AI calls go straight to the local engine.
   - Design target: the "research editor" panel of the approved mockup (version rail,
     evaluation panel, mono metadata stamps).
3. **Real collaboration on the folder** — Yjs doc persisted in the synced folder;
   merge-on-sync instead of last-write-wins; presence later. Drive is transport #1;
   self-hosted (Hocuspocus) and P2P are siblings behind the same abstraction.
4. **PolicyPad-class features on top** — scenarios, policy blocks, heuristics checks —
   powered by the local model (the syzygy-web `backend-utils` prompts are the port
   source; they're provider-agnostic already).

## Backlog (unordered)

- Sync watcher/interval instead of manual+event sync.
- Per-project Drive folders (folder picker instead of fixed "Syzygy").
- Settings surface for the updater channel / release notes display.
- macOS/Linux smoke testing (CI builds them; nobody has run them).
- Code-signing certificate (kills the "Windows protected your PC" interstitial) — cost.
- Re-link UX when Google tokens are revoked server-side.
- syzygy-web: ~22 non-blocking TS errors to clear before it's a clean port source.
- Trim `VisionEngine` plumbing if vision is ever dropped (currently kept + used).

## Decision log (the why behind the shape)

| Decision | Why |
|---|---|
| Fork Aphelion's shell instead of wrapping the Next app | Installer/updater/engine/file-access already proven; no server fits the product; Next's server layer only existed to hide API keys we don't have. |
| Compose (editor ported into shell) over merge | Reuses the hard parts of both codebases; the web editor is framework-portable React. |
| Shared-folder collab before CRDT | A folder is comprehensible, debuggable, and useful alone (docs + knowledge); CRDT rides on top later. |
| Local mirror instead of per-subsystem Drive APIs | One sync chokepoint; every local-folder feature gains Drive for free; offline-tolerant by construction. |
| Google creds injected at build time | Public repo + push protection; binaries may carry them (Google: non-confidential for installed apps), plaintext repos shouldn't. |
| New Syzygy signing key (not Aphelion's) | Separate products, separate trust roots; Aphelion's private key wasn't on this machine anyway. |

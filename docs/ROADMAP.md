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
  plugin/proposal schemas; and a twelfth headless MCP inspection tool. Remote adapters,
  adversarial execution, and plugin loading remain explicitly `contract-only`. The evidence and
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
  is documented in the run evidence. P-03 is `implemented_unverified`; P-10 still requires real
  pointer and keyboard controls plus interaction testing.
- The first remote-model execution boundary is now headlessly testable but not product-enabled.
  Rust constructs and normalizes an OpenAI Responses one-shot request, requires matching content
  disclosure, forces `store:false`, accepts only HTTPS or literal loopback test endpoints, bounds
  the response, and sanitizes failures. A fake server captures the real wire request and six tests
  cover secret redaction, unsafe endpoints, disclosure, response parsing, and malformed/error
  responses. The adapter is labeled `request-conformance`; credential storage, streaming,
  cancellation, tools, UI disclosure, and live opt-in proof remain gates before availability.
- The provider credential vault is now implemented but not product-wired. Its provider-neutral
  trait passes an in-memory set/read/delete/error-redaction suite; secret strings zeroize on drop;
  and a Windows Credential Manager harness created, read, deleted, and independently proved absence
  of a random canary without printing it. Native macOS Keychain and persistent Linux backend builds
  are configured, but their live canaries and the user-facing key/disclosure flow remain open.

## Current completion snapshot

The machine-readable end-goal ledger currently contains **41 capabilities**: **10 are
`implemented_unverified`, 31 are `planned`, and 0 are `verified`**. MCP onboarding improves
operability and automated testing but does not close a research-workflow capability by itself.
The next product-critical gaps remain the custom editor/domain nodes, portable local lifecycle,
Drive-backed Yjs convergence, optional presence, scenarios, local-AI review tools, and versioned
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
   request gate and Windows credential-vault canary have landed; next implement
   streaming/cancellation and explicit disclosure UI before availability. Build the adversarial benchmark before
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

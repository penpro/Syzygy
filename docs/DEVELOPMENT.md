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
npm run test:contracts     # public provider-run/adversarial/plugin schemas and semantic validators
npm run test:provider-streams # fragmented/multiline/unknown/malformed SSE conformance
npm run test:credentials   # memory-backed credential-vault contract; no OS store mutation
npm run test:plugin-sdk    # non-executing package/schema/path/authority certification
cargo fmt --all -- --check # Rust formatting
```

## Headless workspace proof

Run the editor/project scaffold without opening a webview:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:workspace
```

This fails unless project manifests reject malformed/future schemas, old persisted stores migrate
idempotently, duplicate/out-of-order Yjs updates converge, concurrent offline collections survive,
and acknowledged project state reopens from IndexedDB. It does **not** yet prove two-machine rich
text convergence or Drive transport; those remain separate capability gates.

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
`2025-11-25`, discovers its twelve tools, checks notification framing and ping, calls a typed live
status result, then calls `syzygy_installation` without a GUI. That self-description must contain
absolute executable/install-folder paths plus configuration and a connection prompt derived from
the executable. Separate frontend tests prove structured Lexical reads, replace/append behavior,
and stale-revision rejection; Rust tests prove authenticated loopback parsing, browser-origin
rejection, and correct JSON/TOML generation for executable paths with spaces. See `MCP.md` for the
security and tool contract.

The packaged UI exposes the same Rust-generated values under **Settings → Connect an LLM → MCP
setup guide**. Do not hard-code an installer location in React or documentation; installed paths
vary by OS, installer choice, and portable/dev execution.

## Headless remote-provider boundary proof

Run the unwired remote-provider transport checks without a real API key or internet access:

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
availability; product credential integration, the frontend event bridge, UI disclosure, and an
opt-in live canary are separate gates.

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
credential, frontend disclosure, and product availability remain open.

The xAI Responses one-shot boundary uses the Responses shape without assuming OpenAI's privacy
semantics. The fake server checks bearer auth, `store:false`, no previous-response/cache identifier,
bounded normalization, timeout/cancellation, and a mandatory boolean `x-zero-data-retention`
response header. The result preserves that ZDR attestation for later disclosure. xAI streaming,
tools/reasoning continuation, UI, and live proof remain open.

`npm run test:contracts` also validates the public content-free provider-run record. It rejects
undisclosed remote transmission, non-HTTPS remote destinations, contradictory retention
attestation, raw prompts/outputs/credentials, invalid terminal state, inconsistent token totals,
and duplicate or malformed provenance. This proves the record and validator, not that the unwired
provider boundary emits one in product execution.

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
npm run certify:plugin -- ..\examples\plugins\citation-auditor
```

The first command tests schema rejection, real-path containment, wildcard-domain semantics, and
undeclared-authority denial. The second emits a JSON certification report for the interface-only
example. Neither command executes plugin code; runtime/WASI certification remains a separate gate.

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

# Syzygy — project instructions

**Read `docs/ARCHITECTURE.md` before changing structure, `docs/DESIGN.md` before touching
UI/copy, `docs/DEVELOPMENT.md` before building/releasing, `docs/GOOGLE-DRIVE.md` before
touching anything Google, `docs/ROADMAP.md` before proposing direction.** They are the
source of truth and must be updated in the same commit as the change they describe.

Hard rules (full context in the docs):
- `frontend/src/tauri.ts` is the only place `invoke` is called; add typed wrappers there.
- No hard-coded colors — theme tokens only (light `syzygy` paper theme is default; dark
  presets must keep working).
- Copy voice is **local-first**, never absolute-offline ("nothing ever leaves this PC"
  is Aphelion's claim, not ours — Drive exists).
- Save-shape changes go through `frontend/src/migrations.ts` (idempotent backfills).
- OAuth creds: `frontend/.env.local` + Actions secrets only. Never in source — push
  protection will block it.
- Close the running Syzygy app before `tauri build` (binary lock).
- `npm run fetch-engine` from PowerShell, not Git Bash.
- Versions bump via `npm run bump patch` (five files in lockstep); release = push + tag
  `v*` → CI signs and publishes; users update in-app.
- Removed Aphelion features come back from `D:\LocalLLM`, not git archaeology.
- Verify by running the app, not by exit codes: a frontend-only change must show
  `Compiling app` in the build log (asset re-embed) or the exe ships the old UI.

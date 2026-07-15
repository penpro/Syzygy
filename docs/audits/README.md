# Audit index

These artifacts separate product claims from implementation evidence.

- `CAPABILITIES.json` — machine-readable status for all 41 end-goal capabilities.
- `EDITOR-PROVENANCE.md` — clean-room/editor source ledger and dependency gate.
- `DATA-FLOW.md` — trigger, source, destination, persistence, and guard for each data flow.
- `THREAT-MODEL.md` — assets, trust boundaries, controls, residual risks, and blockers.
- `DECISIONS/` — architecture decisions with rejected alternatives and falsification tests.

## Reproduce the current automated claims

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run audit
npx tsc -b --force
npx vitest run
cd src-tauri
cargo fmt --all -- --check
cargo test
```

The live Drive capability is separate because it needs the user's stored OAuth grant and a loaded
local model:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:drive-live
```

Do not convert `implemented_unverified` or `blocked_external` to `verified` because unit tests pass.
The decisive environment gate named by the capability must pass and its evidence must be attached.

## Adversarial review request

Ask a separate model/reviewer to report only falsifiable findings in this shape:

```text
claim | contradictory evidence | file/line or command output | severity | smallest resolving test
```

At minimum, challenge the selected Drive boundary under a broad token, whether Shared Ask can ever
call the model after Drive failure, whether installer assets are regenerated in release builds,
whether the live harness reuses production retrieval code, and whether any capability status is
stronger than its evidence.

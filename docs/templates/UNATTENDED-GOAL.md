# Unattended goal: <short name>

## Objective

<One concrete outcome.>

## Non-goals

- <Explicitly excluded outcome.>

## Authority boundary

- Repository/files in scope: <paths>
- External systems in scope: <systems or none>
- Allowed mutations: <build, test, commit, push, release, live profile, and so on>
- Actions requiring new user authority: <list>

## Acceptance criteria

- [ ] <Falsifiable product or implementation outcome>
- [ ] <Focused headless gate>
- [ ] <Packaged, visual, external, or multi-install gate when the claim requires it>
- [ ] Documentation and machine-readable evidence updated
- [ ] No relevant processes or temporary artifacts remain

## Checkpoints

| Slice | Required evidence | Deadline | Status | Commit |
|---|---|---:|---|---|
| 1. <small coherent slice> | <test/readback> | <minutes> | pending | — |
| 2. <next slice> | <test/readback> | <minutes> | pending | — |

Only one slice may be in progress. A checkpoint becomes verified only when its required evidence
passes.

## Operation budget

| Operation | Command | Absolute deadline | Heartbeat |
|---|---|---:|---:|
| <test/build/harness> | `node ..\scripts\run-with-heartbeat.mjs ...` | <seconds> | 30 seconds |

One long operation per tool call. Put the watchdog at the outermost command boundary and poll its
yielded session directly. Never place long commands inside a grouped/parallel wait.
## Recovery note

- Last verified Git checkpoint: <commit and evidence>
- Current unfinished gate: <one gate>
- Active command/PID: <when applicable>
- First recovery action: <bounded and non-destructive>

## Completion record

- Final commit: <hash>
- Evidence artifact: <path>
- Remaining non-claims: <list>
- Supervisor removed: yes/no

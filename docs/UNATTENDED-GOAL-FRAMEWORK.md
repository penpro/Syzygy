# Unattended goal execution framework

This protocol turns a long Syzygy objective into supervised, recoverable work without requiring a
person to watch terminal output. It separates the worker that changes the repository from a
read-only supervisor that detects silence and restarts progress from evidence.

The command watchdog, goal record, Git checkpoints, supervisor, and audit evidence are one system.
Using only one of them does not provide unattended reliability.

## Roles

### Worker

The worker owns repository changes and must:

1. define a concrete objective, non-goals, authority limits, and falsifiable acceptance criteria;
2. keep one plan step in progress at a time;
3. run every long operation through `scripts/run-with-heartbeat.mjs` with a 30-second heartbeat
   and an operation-specific absolute deadline;
4. run exactly one long operation per orchestration/tool call, with the watchdog as the
   outermost child and its yielded session polled directly;
5. inspect or poll a running operation at least once per minute;
6. create small verified Git checkpoints after coherent slices;
6. record commands, results, proved claims, and explicit non-claims in an audit-run artifact; and
7. mark completion only after the acceptance criteria pass and no required work remains.

The worker must not treat a process exit code alone as product evidence when the gate requires a
packaged app, external account, second installation, visual interaction, or live readback.

### Supervisor

The supervisor performs no repository work concurrently. On each one-minute check it inspects:

- the current goal and whether it is running, paused, complete, or blocked;
- recent thread activity for tool output, a watchdog heartbeat, a checkpoint, or another concrete
  progress signal;
- the attached terminal, if any; and
- only the process state relevant to the active operation.

If the user is interacting and the goal is paused, the supervisor does nothing.

Two consecutive checks without concrete progress trigger recovery. The supervisor inspects the
terminal, interrupts or terminates only the stale active operation when safe, and sends a recovery
continuation that resumes from the last verified Git checkpoint. It never kills unrelated
processes and never rewinds user-owned changes.

An unattended permission request is not a reason to wait forever. The supervisor skips that
operation, records the missing authority, and tells the worker to continue independent work. A
genuine block is reported only after the same blocking condition has repeated with evidence and no
safe independent work remains.

The supervisor notifies the user only when recovery occurred, the goal genuinely blocked, or the
goal completed. Routine healthy checks stay quiet. The supervisor automation is deleted when the
goal is complete or no longer worth monitoring.

## State machine

| State | Entry condition | Required action | Exit condition |
|---|---|---|---|
| Draft | Objective exists but gates are not fixed | Fill the goal template and identify the first checkpoint | Acceptance criteria and authority boundary are explicit |
| Running | One plan item is active | Work in bounded slices; emit tool output, heartbeat, or checkpoint | Slice verifies, operation fails, user pauses, or silence threshold fires |
| Recovering | Two supervisor checks found no concrete progress | Inspect exact process, stop only the stale operation, preserve worktree, resume from last verified checkpoint | A bounded replacement operation starts or a repeated blocker is proven |
| Verifying | Implementation slices are present | Run proportionate headless, packaged, and live gates; write evidence | All acceptance gates pass or a concrete gap returns to Running |
| Paused | User interaction temporarily owns the thread | Make no autonomous intervention | User resumes the goal |
| Blocked | The same external/authority block repeats and no independent work remains | Record evidence and exact unblocking action | User/external state changes |
| Complete | Objective and every required gate are satisfied | Record final status, ensure no stale process, remove supervisor | Terminal state |

## Command contract

Use the repository runner from the working directory appropriate to the command:

```powershell
node ..\scripts\run-with-heartbeat.mjs --timeout-seconds <deadline> --heartbeat-seconds 30 -- <command> <arguments>
```

Never group long operations behind `Promise.all`, a parallel orchestration wrapper, or another outer wait. That hides child heartbeats from the supervisor. Parallel calls are allowed only for fast operations whose complete group has a short bounded return. Long commands each get one tool call and one directly polled session.

Every planned operation names its deadline before it starts. A heartbeat interval above 60 seconds
is forbidden by the runner. A timeout terminates the child process tree and returns exit code 124;
it does not authorize an infinite retry. After two materially identical failures, change the
method, reduce the slice, or record a blocker.

Suggested starting ceilings—not promises—are:

| Operation | Initial deadline |
|---|---:|
| Focused unit or contract test | 5 minutes |
| Frontend/Rust compile | 10 minutes |
| Full test or audit suite | 15 minutes |
| Packaged desktop build | 20 minutes |
| Opt-in external/live harness | 10 minutes |

Adjust a ceiling from measured evidence, never by replacing it with an unbounded wait.

## Checkpoint contract

A recoverable checkpoint contains:

- a narrow coherent change;
- its focused tests;
- updated source-of-truth documentation;
- `git diff --check`;
- a commit whose message states what and why; and
- no unrelated or user-owned file.

The phrase **last verified Git checkpoint** means the newest commit for which the recorded focused
gate passed. Recovery begins there conceptually; it does not use destructive reset commands.
Uncommitted work is inspected and preserved unless it is proven to be a disposable partial output
from the stale operation.

## Recovery algorithm

1. Confirm two consecutive supervisor checks lack concrete progress.
2. Read the active terminal and identify the exact command, PID, child tree, deadline, and last
   output time.
3. Check whether the operation is merely quiet but still emitting watchdog heartbeats.
4. If stale, interrupt the command through its existing session or terminate only its process tree.
5. Inspect `git status`, the latest commit, and any partial artifacts without modifying them.
6. Restate the last verified checkpoint and the smallest unfinished acceptance gate.
7. Resume with a narrower bounded command or a different method.
8. If authority is unavailable, record and skip that operation while continuing independent work.
9. Notify the user that recovery occurred; remain quiet for routine healthy progress.

## Completion checklist

- The goal objective is actually satisfied.
- Required headless, packaged, visual, external, or multi-install gates passed.
- Documentation and machine-readable evidence match the implementation.
- `git diff --check`, formatting, focused tests, build, and structural audit pass as applicable.
- No relevant application, model server, test helper, or build process remains.
- The final commit is pushed when publishing was in scope.
- The goal is marked complete.
- The supervisor automation is removed.

Start new work from [the goal template](templates/UNATTENDED-GOAL.md) and attach
[the supervisor prompt](templates/GOAL-SUPERVISOR-PROMPT.md) as a thread heartbeat.

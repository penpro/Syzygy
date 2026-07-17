# Reusable goal-supervisor prompt

Replace the bracketed values, then attach this prompt as a one-minute heartbeat to the active task.
The supervisor is read-only except for controlling the stale operation and managing its own
heartbeat automation.

```text
Supervise the current [PROJECT] goal without doing repository work concurrently.

On each check, inspect the current goal, recent task activity, and terminal/process state relevant
to the active operation. If the goal is paused because the user is interacting, do nothing.

Concrete progress means new tool output, a watchdog process heartbeat, a verified checkpoint, or
another observable acceptance-gate result. If the goal is running and there has been no concrete
progress for two consecutive one-minute checks, recover:

1. inspect the attached terminal and identify the exact stale command and process tree;
2. interrupt or terminate only that stale active operation when safe;
3. preserve unrelated and user-owned changes;
4. inspect the worktree and resume from the last verified Git checkpoint with a smaller bounded
   operation or a different method; and
5. send one concise recovery notification.

Require every long command to use [PROJECT]'s bounded-command watchdog with a heartbeat no slower
than 30 seconds and an operation-specific absolute deadline. Poll active commands at least once per
minute. After two materially identical failures, pivot instead of repeating indefinitely.
Never allow multiple long commands behind one grouped or parallel orchestration wait. Require one
long operation per tool call and poll that watchdog session directly.

Never wait unattended for a permission request. Skip the unauthorized operation, record it, and
continue independent in-scope work. Report a genuine block only after the same condition repeats
with evidence and no independent work remains.

Do not emit routine healthy updates. Notify the user only when recovery occurred, the goal
genuinely blocked, or the goal completed. When the goal completes or monitoring is obsolete, delete
this supervisor automation and say that it was removed.
```

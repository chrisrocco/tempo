# Task Execution & Concurrency

> **⚠ Implementation status (read [`PROJECT.md` §4](../../PROJECT.md)):** this describes the original
> **Phase-0 in-process model** and is now **superseded**. `drive` and `pump` no
> longer exist as such: the runtime is a **poll/respond** model
> (`server_core.buildWorkflowTask` / `applyWorkflowTaskResult`), and `pump`'s two
> jobs (mutual exclusion + wake-coalescing) now live in the **workflow-task queue**
> (`server/memory/memory_workflow_task_queue.ts`), with leasing added for crash
> tolerance. Read this doc for the *why* — the two concrete bugs `pump` prevents
> still apply, they're just enforced by the queue now. Also note: every dispatched
> op now records a marker event and *parks* (dispatch-and-park), rather than
> `executeCommand` running it inline.

The non-deterministic half. Where the core's commands get executed and where
concurrency is controlled. In the distributed system these responsibilities move
to the server and workers (see [distribution](distribution.md)); this doc describes the in-process form.

## The execution record

Each running workflow is an `Execution`: its id, workflow name, args, the mutable
`history`, a `status` (`running | completed | failed`), a `resultPromise` (plus its
resolver/rejecter), and two concurrency flags used by `pump`: `running` and
`rerun`. In the in-memory runtime these live in an `executions` map; that map is
the thing that becomes a persisted `HistoryStore` later.

## `drive`: the task-by-task progress loop

`drive(exec)` runs one workflow task after another until the workflow is done,
failed, or genuinely parked:

1. Build a fresh context from `exec.history` and `replay` the workflow.
2. If done/failed → settle the result promise and stop.
3. If it produced **no** new commands → it's parked waiting on external input
   (a signal); return.
4. Otherwise execute each command (appending completion events) and loop — the
   new events let the next iteration make more progress.

Its inner `for(;;)` loops on the workflow's *own* forward progress.

## `executeCommand`: the only code that touches the world

This is where determinism ends. `executeCommand` is the single place that runs an
activity function, fires a timer, or starts a child. Two halves are worth naming
because they separate in the distributed system:

- **Dispatch** — turning a `scheduleActivity` command into work. (Stays on the
  server later.)
- **Execution** — actually running the activity function. (Moves to activity
  workers later.)

Today activities run inline (`await fn(...)`), timers fire immediately, and
children are **blocking** (`executeChild` starts a child and awaits its result).
Fire-and-forget children + cancellation were deferred at this phase; both are
built now (see [`PROJECT.md` §1](../../PROJECT.md)).

## `pump`: the concurrency guard

`pump` is a per-execution mutex plus a coalescing "run again" flag. It's called to
kick an execution (on start) and every time a signal is appended. It does two
jobs, each preventing a concrete bug that falls out of how `drive` works (`drive`
interleaves at every `await`, and it reads history via a point-in-time `.slice()`
snapshot):

### Job 1 — mutual exclusion

If `signal()` called `drive` directly, a signal landing mid-drive would start a
*second* `drive` interleaving with the first over the same `exec`. Both could
reach the live edge for the same command seq — running an activity twice and
settling the result promise twice. `if (running) return` makes a competing drive
impossible.

### Job 2 — no lost wakeups

`drive` works off a history snapshot. If a signal is appended *after* the snapshot
is taken but while the drive is still running, that drive never sees it and parks
— and the workflow would sleep forever despite a pending signal. `pump` closes the
window: a wake arriving while `running` sets `rerun = true`, and the
`do { … } while (rerun)` loop runs `drive` once more against fresh history.

`pump`'s outer `do…while` (re-run on an *external* wake) is not redundant with
`drive`'s inner `for(;;)` (the workflow's *own* progress) — different triggers.

### Scope, and what it becomes

`pump` only serializes within a single execution; different executions run
concurrently (safe only because they share no mutable state). It is the in-memory
stand-in for two distributed mechanisms: a per-workflow single-in-flight task
queue / lease (Job 1) and at-least-once wake delivery (Job 2). The `running`
boolean can't survive across processes, so the durable version replaces it with an
optimistic-locking version check on history append plus a durable task queue
(see [distribution](distribution.md)). In the productionized layout, `pump` is **scoped to the in-process
`LocalService`** and does not exist in the distributed server.

# Replay & Execution Model

How a workflow actually advances, and the mechanics of the core engine.

## Activation vs. replay (they are not the same word)

- An **activation** (workflow task) is one batch of new events the runtime applies
  to move a workflow forward: "a signal arrived," "a timer fired," "an activity
  completed." A signal _causes an activation_.
- **Replay** is rebuilding in-memory state that was lost, by re-running the
  workflow function from the top and re-feeding recorded history.

The crucial correction: **a signal does not cause a replay.** An event causes an
activation; that activation involves replay _only if the worker no longer holds
the execution's live state._

### Warm path (sticky cache)

In steady state the workflow is cached live on a worker — a suspended coroutine
parked at its current `await`. When the next activation arrives, the worker
applies only the new events to that live state and resumes from where it stopped.
**Nothing replays.** This is the common case.

### Cold path (replay)

If the live state is gone — crash, cache eviction, redeploy, a different worker —
the worker has nothing in memory, so before applying the new event it must
reconstruct "where were we" by running the workflow from line one, re-feeding
every recorded event in order, until it catches up. _Then_ it applies the new
activation. Replay would happen for **any** activation on a cold worker,
regardless of what triggered it.

Because any activation might land cold, every suspension point must be
reconstructible identically from history — which is exactly the determinism rule
from [the determinism boundary](determinism-boundary.md).

## The core loop mechanics

The per-run state object (the "context", a.k.a. activator) holds:

- `events` — the recorded history for this run.
- `idx` — how many events have been consumed this task.
- `seq` — the command-id counter. The Nth command a workflow issues is always
  seq N. This determinism is what lets a recorded completion find the right
  promise.
- `isLive` — `false` while replaying recorded history, `true` once caught up.
- `commands` — the **new** commands produced this task (to dispatch).
- `completions` — `seq -> promise resolver`, the parked awaits.

### Commands vs. history events, and the live edge

Each primitive call (`runActivity`, `sleep`, …) allocates a seq, registers a
completion promise, and — **only if `isLive`** — pushes a command. During replay
(`isLive === false`), commands are _suppressed_: they're already durable in
history, so re-emitting them would double-dispatch. The moment the last recorded
event is consumed, `isLive` flips to `true` (**the live edge**), and further calls
push genuinely new commands. So one flag divides "catching up" from "making
progress."

`applyEvent` routes a recorded event back into the parked promise for its seq (or,
for a signal, to its handler). An event referencing an unknown seq is a
**nondeterminism error** — the code no longer matches its own history.

## `settle`: drain + condition unblock

After applying each event, the engine runs `settle`: drain the microtask queue,
then run the **condition unblock pass** to a fixpoint (re-check every blocked
predicate; resolving one may enable another). See [conditions, signals & timers](conditions-signals-timers.md) for the condition
mechanism. `settle` is the atomic "advance the workflow as far as it can go on the
information currently available" step.

## AsyncLocalStorage: context propagation across awaits

Workflow code calls bare `runActivity(...)` with no context argument; the
primitive recovers the context via `AsyncLocalStorage`. The subtle, load-bearing
property: an `await` continuation is bound to the context that was active **when
the await suspended**, not when the promise is resolved. So when the engine
resolves a parked promise from _outside_ the `als.run(...)` scope (in the replay
driver), the workflow's resumed code still re-enters with the correct context.
This is why you don't thread context through every call — and why a naive global
would break the instant two workflows interleave on one worker.

## Observe, don't await, the workflow's own promise

A workflow task must conclude while the workflow function is still suspended
mid-flight (most tasks don't finish the workflow). So the driver never `await`s
the workflow function's promise — that resolves only once, at the very end. It
**observes** it with a `.then(onDone, onFail)` that records the terminal outcome,
and it concludes each task on **quiescence** (the microtask queue drained and the
code parked again), not on completion. A no-await workflow finishes within its
first task via the same machinery; no special case.

## Determinism rules, restated operationally

- Time comes from `sleep`/recorded fire-times, never `Date.now()`.
- seq allocation must be stable across replays — so conditionals that change how
  many commands are issued must themselves be deterministic.
- `condition` predicates must be pure reads of workflow state (no clock, no
  activity calls inside them).

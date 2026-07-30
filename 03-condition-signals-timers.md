# 03 — Condition, Signals & Timers

> **⚠ Implementation note (see `PROJECT.md` §4):** `condition` and signals are as
> described. **Timers have changed**: they are now real wall-clock and durable — a
> `timerStarted{fireAt}` event is recorded in history, a real (unref'd) `setTimeout`
> fires it, and `resume()` re-arms pending timers from history on restart. The
> "fires immediately" caveat below is historical.

The three mechanisms that let a workflow *wait* — and the pattern that started the
whole project.

## `condition`: waiting on state, deterministically

`condition(fn)` suspends the workflow until the predicate `fn` returns true. It is
**event-driven, not polling** — there is no timer and no busy-wait.

### How it works under the hood

`condition` has two halves:

1. **Register.** When called, it checks `fn()` once (eager fast-path — if already
   true, resolve immediately). Otherwise it stores `{ fn, resolve }` in the
   context's `blockedConditions` map, keyed by a **separate** condition counter
   (never the command `seq` — conditions emit no commands and must not perturb
   seq allocation), and returns a pending promise.
2. **Unblock.** `condition` never re-checks `fn` itself. After each activation's
   events are applied and microtasks drain, the engine's unblock pass walks
   `blockedConditions`, calls each predicate, and resolves the ones now true —
   looping to a **fixpoint**, because resolving one condition can run more code
   that makes another true.

The essential line is the registration into `blockedConditions`; the eager check
is only an optimization. A predicate that's false stays parked until *something
wakes the workflow* — a condition cannot spontaneously become true. It can only
flip as a side effect of an activation (a signal, a completion) that runs the
unblock pass. If nothing ever arrives, it waits forever — harmlessly, since a
parked workflow accrues no history and consumes no resources.

### Why not just await a never-resolving promise?

Because a signal doesn't *wake* an await — it only runs a handler. Something must
bridge "handler mutated state" to "the parked promise resolves," and that bridge
is the `blockedConditions` registry plus the unblock pass. `condition` is the
general, replay-safe form of that wiring. (You *can* hand-roll it for one signal
by capturing a `resolve` in the handler — that's just a single-use `condition`.)

## Signals: injecting input from outside

- `defineSignal(name)` names a signal; `setHandler(def, fn)` registers a handler.
- A signal arrives as a **history event with no seq** (it's external, not tied to
  a command). `applyEvent` routes it to the registered handler.
- **Buffering:** if a signal event is applied before its handler is registered,
  it's buffered and delivered when `setHandler` runs. (In practice the workflow
  registers handlers before its first await, so buffering is a safety net.)

### The handler-only-enqueues discipline

Signal handlers should do the minimum: push onto a queue / set a flag. Doing real
work (starting/cancelling children) inside a handler invites races and
unfinished-handler problems at continue-as-new. The main loop drains the queue and
acts. This is the pattern the project began with:

```ts
const diff = defineSignal('diff');
const queue: Diff[] = [];
setHandler(diff, (d) => queue.push(d));   // handler only enqueues
for (;;) {
  await condition(() => queue.length > 0); // park until something changes
  const d = queue.shift()!;
  // ...reconcile...
}
```

The signal that pushes onto `queue` *is* the activation that triggers the unblock
pass, and the handler runs before the pass — so the condition reliably sees the
new item. That ordering guarantee is why the queue pattern never misses a diff.

## Timers

A timer is the **same mechanism as an activity**: `sleep(ms)` allocates a seq,
registers a completion promise, and emits a `startTimer` command. A `timerFired`
history event resolves it. The only difference from an activity is the command
payload and that the "worker" is the runtime's timer service.

### Determinism of time

The timer's fire-time must be **recorded in history**, not read from `Date.now()`
at replay. A workflow's sense of "now" comes from history like everything else.
The current in-memory runtime fires timers immediately; a real one records a
fire-time and sweeps due timers with a crash-tolerant background loop (see `06`
and `ROADMAP.md`).

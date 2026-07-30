# The Determinism Boundary

This is the single most important idea in the system. Every structural decision —
file layout, entrypoints, how features are split across layers, how the thing
scales to many processes — is downstream of it.

## The line

> The **deterministic core** turns a *history* into a set of *commands*. It does
> nothing else: no I/O, no wall-clock reads, no randomness, no access to mutable
> global state. Everything non-deterministic lives on the other side of the line,
> in the **runtime**.

`(history events) -> core -> (commands)`. That's the entire contract. The core
does not know whether history arrived as an in-memory array or an RPC response,
and it does not know who executes the commands it emits.

## Why the line has to exist

Durability is achieved by **replay**: to recover a workflow whose in-memory state
was lost (crash, eviction, a different worker picking up the next task), the
engine re-runs the workflow function from the top against recorded history. For
that reconstruction to be correct, replay must be **reproducible** — the same
history must always drive the function to the same point and produce the same
commands. Any non-determinism inside the workflow breaks this: a `Date.now()`, a
`Math.random()`, a network call, or reads of shared mutable state would make the
replayed run diverge from the original, and the recovered state would be wrong.

So the determinism boundary isn't a style preference — it's the precondition that
makes the whole event-sourcing scheme sound.

## Rules workflow code must obey

Because it lives on the deterministic side, workflow code must not:

- read the wall clock (`Date.now()`, `new Date()`) — use `sleep` / recorded time;
- use randomness;
- do I/O directly — request it via an **activity**;
- depend on mutable state outside its own context;
- `await` anything the engine didn't hand it (a raw `setTimeout`, a bare fetch) —
  only promises the engine resolves are safe, because only those resolve
  identically on replay.

"Current time" and "an external result" must both arrive **through history**, not
be reached for directly.

## What the boundary buys you

- **Testability.** The core is a pure function of its input. It's unit-testable
  with hand-written histories and no infrastructure.
- **Recovery.** Because replay is reproducible, a lost worker costs latency, not
  correctness — the state rebuilds from history.
- **Distribution (the big one).** Since the core commits no external effects,
  running it twice is harmless. That is precisely what makes it safe for two
  workers to replay the same execution in a race and discard the loser's work
  (see [distribution](../architecture/distribution.md)). Distribution is *only*
  tractable because of this boundary.

## How the boundary is enforced (not just documented)

1. **Two entrypoints.** `workflow.ts` re-exports only the deterministic
   primitives an author may call (`runActivity`, `proxyActivities`, `sleep`,
   `condition`, `defineSignal`, `setHandler`, `continueAsNew`). `index.ts`
   exports the host surface (`createRuntime`, handle/runtime types). Workflow code
   imports from `workflow.ts` only.
2. **Dependency direction.** `protocol <- core <- runtime <- entrypoints`. Nothing
   in `core/` may import from the runtime layers. `core/` may import only
   `protocol/` (pure data).
3. **A lint rule (planned).** An import-path lint rule would make the two points
   above mechanical rather than aspirational — a file of workflow code that reaches
   for `Date.now()` or a runtime function would fail the build. It is not yet
   implemented (see [`PROJECT.md` §6](../../PROJECT.md)); today the boundary is
   upheld by the two entrypoints and dependency direction plus discipline.

If you remember one thing from this documentation: **respect the line.** When
deciding where a new feature goes, ask "is this deterministic (history-in,
commands-out) or not?" The answer tells you the layer.

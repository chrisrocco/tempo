# Continue-As-New

`continueAsNew` is the mechanism for a long-running (or infinite) workflow to
avoid unbounded history growth: it ends the current run and starts a fresh one,
carrying forward only the state it needs. It's a good case study in the layer
split, because it spans all three layers and it's easy to put too much of it in
the core.

## Why it's needed

Every workflow execution has a hard history ceiling; a monitor loop that runs
forever would eventually hit it and be terminated. Any unbounded workflow needs
*some* continue-as-new strategy. It's not optional for long-lived workflows.

## `continueAsNewSuggested` — the flag (core-side input)

The server tracks history growth and sets a boolean hint,
`continueAsNewSuggested`, which the workflow reads off its context to decide when
to roll over:

```ts
while (!getContext().continueAsNewSuggested) { /* ...work... */ }
await continueAsNew(carriedState);
```

Key points:
- It's a **server-provided input**, not a command — it flows in via history/context.
- It updates at activation boundaries (each new workflow task re-evaluates it).
- Acting on it is your choice; act at a **clean checkpoint** (state coherent,
  queue drained), never mid-reconciliation.
- It's a *hint*. You can also roll over on your own `historyLength` threshold or a
  cadence; for high-throughput workflows you may want to continue-as-new *earlier*
  than the suggestion.

Its home is `core/context.ts` (the field) and the workflow reads it; the server
populates it.

## `continueAsNew` — the primitive (core-side command)

From the author's side, `continueAsNew(...args)` is another command emitter, with
one wrinkle: it is **terminal**. It emits a `continueAsNew` command carrying the
next run's args and then halts the current run (returns a never-resolving promise
/ throws a sentinel the top-level catches), so no code runs after it and `replay`
sees a terminal command rather than a parked execution.

Home: `core/workflow_api.ts`, beside `runActivity`; re-exported from the
`workflow.ts` author entrypoint. It stays pure.

## Protocol — the vocabulary

`protocol/commands.ts` gains
`ContinueAsNewCommand extends CommandBase { type: 'continueAsNew'; args: unknown[] }`,
added to `Command` and `CommandSpec`. Optionally a `WorkflowContinuedAsNew`
history event so a run records *how* it ended (mirroring completed/failed).

## Server — the actual behavior

This is where `continueAsNew` becomes real, and it must **not** leak into the
core. When the workflow-task handler finds a `continueAsNew` command in a batch,
it performs a distinct terminal disposition, atomically:

1. Close the current run.
2. Start a **new run** of the same workflow — same `workflowId`, new `runId`,
   fresh **empty** history seeded with the carried args — and enqueue a workflow
   task for it.

Two behaviors established earlier live specifically here:

- **Children survive.** Continue-as-new is *not* a real close, so parent-close
  policy must not fire: child workflows (and pollers) carry into the new run. The
  handler's teardown must not cascade cancellation the way a genuine
  completion/termination does. It's a branch in the close logic.
- **History accounting resets.** The new run starts empty (the whole point), and
  the server sets `continueAsNewSuggested` back to false on it.

Home: `server_core.ts` (`applyWorkflowTaskResult`), as a fourth terminal case
alongside completed / failed / (schedule-more-tasks). There is no separate
`workflow_task_handler.ts` file — the disposition lives in `server_core.ts`.

## The rule to hold

Do **not** let `core/replay.ts` "handle" continue-as-new by looping internally or
re-seeding its own context. The core's job ends at *emitting the terminal command
and halting the run*. Starting the next run is a stateful, transactional act only
the server can do atomically (new runId, enqueue, spare children). Keeping that
division is what prevents a genuinely run-spanning mechanism from smuggling
run-spanning state into an engine that should know about exactly one run at a time.

Because it threads through the service seam, local mode gets it for free:
`LocalService`'s in-process handler implements the same close-and-restart logic
against the in-memory store, driven by the in-proc drain loops.

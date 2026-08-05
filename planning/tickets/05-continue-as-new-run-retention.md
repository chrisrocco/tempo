# 05 — A previous run is unreachable after continue-as-new

**Type:** decision (storage + retention) · **Blocks:** run-chain navigation in the
dashboard

## Problem

There is no way to inspect what an execution did before it rolled over, because
the previous run is not kept.

[`resetForContinueAsNew`](../../src/server/memory/memory_history_store.ts) mutates
the **same** record:

```ts
rec.history = [];
rec.args = args;
rec.version = 0;
rec.runId += 1;
```

So there is one `ExecutionRecord` per `workflowId`, and `runId` is a counter on
the surviving record rather than a key. The prior run's events are gone the
moment it continues.

This was found while building the parent link (PR #26), where the original scope
included "first / previous / next run" navigation. That half is not
unimplemented — it is **not buildable on the current storage**, because there is
nothing to navigate to.

Worth noting the fileoverview at
[`server_core.ts`](../../src/server/server_core.ts) describes continue-as-new as
"close the current run, then start a **new run**", which reads as though runs are
separate things. They are not, and that wording is worth revisiting alongside
whatever is decided here.

## Why this is a decision rather than a task

Bounded history is the entire point of continue-as-new —
`DEFAULT_CONTINUE_AS_NEW_SUGGEST_THRESHOLD` is 4096, and a poller rolls over
constantly by design. Retaining every run reintroduces exactly the growth the
feature exists to prevent, on the workflows least able to afford it.

Nothing is broken today. This is only about whether a past run is inspectable
after the fact.

## Options

**A — Leave it.** Document that a run is not recoverable after rollover, and fix
the "new run" wording so nobody expects otherwise. Zero cost, and it keeps the
storage model honest: one id, one record.

**B — Retain the last N runs.** Bounded, but needs a second record kind or a
run-keyed store, and every listing, filter, and count has to decide whether it
means runs or executions. `ExecutionFilter` and `groupExecutions` both currently
assume one row per execution.

**C — Retain a summary per run.** Outcome, event count, duration, args — no
history. Cheap, bounded by run count rather than event count, and probably
answers most of what anyone wants from a chain ("how many times has this rolled
over, and did any of them fail?"). Does not support reading a past run's events.

C looks like the best value for the cost, but the call is whether inspecting a
past run is a real need or a speculative one.

## Acceptance criteria

- [ ] A decision is recorded, including the "leave it" option.
- [ ] The `server_core.ts` fileoverview no longer implies runs are separate
      records, whichever way it goes.
- [ ] If B or C: `ExecutionFilter`, `groupExecutions`, and the dashboard listing
      each state whether they count runs or executions.
- [ ] `npm run typecheck` clean; `npm test` green.

# Authoring Guides

How-to guides for **workflow authors** — writing code against the deterministic
surface (`workflow.ts`). Start with [Getting Started](../getting-started.md) for
the end-to-end tour.

Per the [example-anchor rule](../../contributing/testing-conventions.md#the-example-anchor-rule-for-guides),
each guide below must be backed by a runnable, spec-covered example before it's
written. Today the only such example is
[`bug_hotlist_monitor.ts`](../../../examples/bug_hotlist_monitor.ts); the guides
marked *planned* need a focused example added to [`examples/`](../../../examples/)
first.

## Planned guides

| Guide | Covers | Example anchor |
|-------|--------|----------------|
| Activities & retries | `runActivity`, `proxyActivities`, `RetryPolicy` | *planned* — needs a focused example |
| Signals & conditions | `defineSignal` / `setHandler` / `condition`, handler-only-enqueues | ✅ [`bug_hotlist_monitor.ts`](../../../examples/bug_hotlist_monitor.ts) |
| Children & cancellation | `startChild` / `executeChild`, cancelling via handle, cascade | ✅ [`bug_hotlist_monitor.ts`](../../../examples/bug_hotlist_monitor.ts) |
| Continue-as-new | rolling over at a clean checkpoint; `continueAsNewSuggested` | *planned* — needs a focused example |

Until a guide is written, the [behavior specs](../../behavior/README.md) are the
authoritative reference for each of these, and the concept docs explain the *why*:
[conditions, signals & timers](../../concepts/conditions-signals-timers.md),
[continue-as-new](../../concepts/continue-as-new.md).

# Authoring Guides

How-to guides for **workflow authors** — writing code against the deterministic
surface (`workflow.ts`). Start with the [Quickstart](../quickstart.md) for the
end-to-end tour.

Per the [example-anchor rule](../../contributing/testing-conventions.md#the-example-anchor-rule-for-guides),
each guide below must be backed by a runnable, spec-covered example before it's
written. Today the only such example is
[`greeter.ts`](../../../examples/greeter.ts), which covers activities and the
deployable worker shape but none of the richer primitives; every guide marked
_planned_ needs a focused example added to [`examples/`](../../../examples/) first.

## Planned guides

| Guide                   | Covers                                                             | Example anchor                      |
| ----------------------- | ------------------------------------------------------------------ | ----------------------------------- |
| Activities & retries    | `runActivity`, `proxyActivities`, `RetryPolicy`                    | _planned_ — needs a focused example |
| Signals & conditions    | `defineSignal` / `setHandler` / `condition`, handler-only-enqueues | _planned_ — needs a focused example |
| Children & cancellation | `startChild` / `executeChild`, cancelling via handle, cascade      | _planned_ — needs a focused example |
| Continue-as-new         | rolling over at a clean checkpoint; `continueAsNewSuggested`       | _planned_ — needs a focused example |

Until a guide is written, the [behavior specs](../../behavior/README.md) are the
authoritative reference for each of these, and the concept docs explain the _why_:
[conditions, signals & timers](../../concepts/conditions-signals-timers.md),
[continue-as-new](../../concepts/continue-as-new.md).

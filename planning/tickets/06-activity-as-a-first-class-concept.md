# 06 — "Which activity is failing?" is unanswerable at any layer

**Type:** gap (protocol + storage) · **Relates to:** the retry state landed in
PR #25

## Problem

Activity is the one concept the engine has no aggregate view of. It exists only
as history rows — `activityScheduled` carries a `name`, `activityFailed` carries
an `error` — and nothing groups by either.

[`groupExecutions`](../../src/protocol/service.ts) groups by **task queue** and by
**workflow type** only. So finding a flaky activity means opening executions one
at a time and reading their histories, which is precisely the per-execution scan
that `ExecutionSummary.taskFailures` was added to avoid for wedged executions.

It is one of the first questions a developer asks, and the dashboard cannot ask
it on their behalf.

## What the retry work does _not_ give you

PR #25 added `ActivityRetryState` (`attempts`, `lastError`, `nextAttemptAt`) to
`ExecutionRecord.activityAttempts`. That looks like most of this ticket and is
not:

- It is keyed by **`seq` within a single execution**, so it has no notion of an
  activity _name_ across executions.
- It is **cleared the moment the activity reaches a terminal event**
  ([`history_store.ts`](../../src/server/ports/history_store.ts)), deliberately, so
  it does not grow with history. It therefore holds only what is in flight right
  now and no record of anything that already finished.

Checked explicitly before starting this: one protocol change does not serve both.

## The two real decisions

**1. What shape does the grouping have?** `ExecutionGroup` is built around
execution statuses (`running` / `completed` / `failed` / `terminated` / `stuck`),
none of which apply to an activity. This likely wants its own type rather than a
third `byActivity` field on `ExecutionGroups`.

**2. Where do the counts come from?** These are opposites, and the choice is the
work:

- **Derive from history.** Scan every execution's events for
  `activityScheduled` / `activityFailed` pairs. No new storage, no new invariant —
  but it is a full scan, and the dashboard would poll it. Note the counts strip
  already polls `groupExecutions` at a reduced 10s cadence for exactly this
  reason.
- **Keep durable totals.** Cheap to read, but needs a counter that **outlives an
  activity settling** — the opposite of the rule that keeps `activityAttempts`
  bounded, and therefore a genuinely new thing to maintain and to reconcile after
  a restart.

## Where it would surface

Probably a third table on the queues view, which is already "by task queue" and
"by workflow type", rather than a new nav item. Decide once the data's shape is
known.

## Acceptance criteria

- [ ] A grouping by activity name exists on the protocol, with a shape that does
      not borrow execution statuses.
- [ ] The derive-vs-store decision is recorded with its cost.
- [ ] The dashboard can answer "which activity fails most" without opening an
      execution.
- [ ] Whatever polls it does so at a cadence proportionate to its cost.
- [ ] `npm run typecheck` clean; `npm test` green.

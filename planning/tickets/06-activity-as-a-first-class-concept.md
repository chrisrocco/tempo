# 06 — "Which activity is failing?" is unanswerable at any layer

**Type:** gap (protocol + storage) · **Relates to:** the retry state landed in
PR #25

> **Status: landed, narrowed deliberately.** `ExecutionGroups.retryingActivities`
> groups what is **between attempts right now** by activity name, rendered as a
> third table on the queues view. `activity.settled` now carries the activity
> name, so the log stream can be grouped by activity without a join.
>
> **The derive-vs-store decision below is a false choice, and that is the main
> finding.** It is not a cost tradeoff — it is a capability one. `activityFailed`
> is written only once the retry budget is spent, and `activityAttempts` is
> cleared the moment an activity settles. So an activity that fails four times
> and succeeds on the fifth leaves a history containing `activityScheduled` and
> `activityCompleted` — identical to one that succeeded immediately.
> **Flakiness is not derivable from history at any cost.** "Derive from history"
> would have answered a narrower question than the ticket title implies, and a
> reader would reasonably have assumed otherwise.
>
> Three decisions:
>
> - **Live, not cumulative.** Report what the engine genuinely knows rather than
>   a historical number that is silently blind to every activity that recovered.
>   The heading says "right now" for that reason.
> - **Its own type on the existing call.** `ActivityRetryGroup` borrows none of
>   `ExecutionGroup`'s statuses, which mean nothing for an attempt waiting to run
>   again — but it rides on `groupExecutions` rather than a new RPC, because it
>   answers the same question from the same scan, which is the argument
>   `ExecutionGroups` was already built on.
> - **`ActivityRetryState` gained `name`.** A copy of something history holds,
>   which is normally wrong; it earns its place by keeping the grouping
>   O(executions) instead of O(total events). Without it, resolving a `seq` to a
>   name would mean running `pendingWork` over every execution's full history on
>   a call the dashboard polls — and that cost would grow forever, since settled
>   executions are never deleted (see #33).
>
> **Cumulative failure rates are out of scope, on purpose.** Both
> `activity.settled` and `activity.retry_scheduled` now carry the activity name,
> so the aggregate belongs to a metrics backend consuming the log stream — which
> is where Temporal puts it too (`temporal_activity_type`, aggregated in
> Prometheus; their Web UI has no group-by-activity view). Doing it in the store
> would need a durable counter that outlives settling, which is the inverse of
> the rule keeping `activityAttempts` bounded.

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

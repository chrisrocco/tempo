# Roadmap

What's left to build. For what already works, see [`README.md`](README.md); for
in-flight design work, [`planning/`](planning/).

The guiding strategy, which still applies to everything below: **introduce every
seam as an interface with an in-memory implementation first, keep the suite green,
then swap one implementation at a time.** A process boundary should be a
substitution behind a tested interface, never a rewrite.

## Done

Phases 1–5 built the engine out from an in-process prototype to a distributed
system: the layered split and the two entrypoints; the ports and the
`WorkflowService` seam; the full programming model (activities, retries, real
timers, signals, `condition`, children, `continueAsNew`, cancellation); durable
filesystem persistence with optimistic versioning and crash recovery; and
distribution over HTTP RPC with leasing, expiry-driven redelivery, and the version
check that resolves lease races.

Phase 5's exit criterion passes: a real spawned server process, worker-crash
redelivery, at-least-once activities, and lease-race rejection all hold under
[`spec/integration/distributed.spec.ts`](spec/integration/distributed.spec.ts).

Phase 1's outstanding piece has also landed: the determinism boundary is now
enforced mechanically by [`tools/boundaries.ts`](tools/boundaries.ts) — layering,
core purity, and the author entrypoint — rather than by discipline. It runs as
`npm run lint` and inside the suite, and its exit criterion holds: a deliberately
planted `Date.now()` in a workflow file fails the check.

## Adoption blockers

The phases below are ordered by what depends on what. This table is the same
ground ordered by **how likely each item is to bite someone actually running
workflows on this** — the order that matters when scoping, and the one that drove
the decomposition: blockers 1 and 2 both landing in Phase 6 is why that phase has
the shape it does.

Each row names the phase that owns the fix. The plan lives there; the consequence
and the interim mitigation live here, so neither repeats the other.

| #   | Blocker                              | Consequence                                                                                                                                                                                                                                                                                                                | Mitigation today                                                                      | Fix owned by                     |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | No activity heartbeat                | An activity that sets no `startToCloseTimeoutMs` is still redelivered on lease expiry and runs **concurrently** with the attempt in flight. With one set the engine bounds the attempt, but without heartbeats it still cannot tell a slow worker from a dead one, so a long honest attempt cannot hold its claim.         | Set `startToCloseTimeoutMs` (below `ACTIVITY_LEASE_MS`); keep effects idempotent.     | Phase 6 (timeout landed)         |
| 2   | Nothing alerts on a wedged execution | A replay that throws no longer hides: the failure is counted, backed off, reported by `describe`, fixable by redeploy, and endable with `terminate`. But discovering it still requires someone to look — `getResult` waits indefinitely by design, and no alert fires.                                                     | `tempo describe` / `list`; `terminate` to end one.                                    | Phase 7 (handling landed)        |
| 3   | No workflow versioning               | Deploying changed workflow code while executions are in flight diverges replay from history, which lands in blocker 2.                                                                                                                                                                                                     | Drain in-flight executions before deploying a changed workflow.                       | Unphased (needs design)          |
| 4   | No auth or TLS; single server        | The RPC starts, signals, and cancels arbitrary workflows unauthenticated; the loopback bind is the only thing containing it. The server is also a single point of failure and a single writer.                                                                                                                             | Keep everything on one trusted host; do not widen the bind without a private network. | Unphased (auth) / Phase 9 (HA)   |
| 5   | Nothing aggregates or alerts         | Per-execution state is inspectable (`tempo describe` / `list`) and the server emits structured lifecycle events, but nothing rolls them up or alerts: queue depth is not even measurable yet, since the queues expose no size.                                                                                             | `tempo describe`; pipe the server's JSONL stderr somewhere you can query.             | Phase 7 (instrumentation landed) |
| 6   | ~~Retry state is not durable~~       | **Closed.** Attempts are counted on the execution record and the server decides retries, so the budget holds across worker loss and server restarts, and is applied identically in local and distributed mode.                                                                                                             | —                                                                                     | Done (Phase 7)                   |
| 7   | ~~Generated ids collide on restart~~ | **Closed.** Child ids are derived from lineage (`parent.run.seq`) instead of a counter, so they are stable across restarts and across continue-as-new; the root counter is seeded past existing ids on resume; and a duplicate id is logged rather than escaping as an unhandled rejection, which used to kill the server. | —                                                                                     | Done                             |

Blockers 1, 2, and 6 were one missing capability — **the server kept no account of
attempts** — and building it closed 6 outright and reduced the other two to what
an attempt count cannot supply on its own. Blocker 1 needs a heartbeat, so a long
honest attempt can hold its claim rather than merely being cut off at a deadline.
Blocker 2 is now a question of noticing rather than surviving: the instrumentation
exists, the aggregation does not.

## Phases 6–9

What used to be one "production" phase is four, sequenced by what each one
depends on. The decomposition and the evidence behind it are in
[`planning/sprints/05-phase-6-scope.md`](planning/sprints/05-phase-6-scope.md);
this is the schedule that came out of it. Two things it changed:

- **Phases are scoped by mechanism, not by symptom.** Activity timeouts used to
  sit in "finishing distribution" and poison-task handling in "production", but
  they are one capability — the server keeping a durable account of attempts — so
  they ship together in Phase 6.
- **HA moved behind the store.** A shared multi-writer store is a _prerequisite_
  for HA, not a sibling of it, so it gets its own phase before it.

### Phase 6 — Operability

_An execution can no longer stop making progress silently._ Both ways it can
happen today (a poison task, a hung activity) present identically as silence.

- ~~**Make a poison workflow task loud and bounded**~~ — **landed** (adoption
  blocker 2, less the escape hatch below). A replay that throws is reported via
  `failWorkflowTask` instead of escaping the poll loop unseen; the server counts
  failures on the record (not the queue, which is in-memory and would reset on
  exactly the restart an operator tries), backs off exponentially to a 30s cap,
  and `describe` reports the count and the last reason. The count resets on the
  next success. Pairs with ticket 04: the reason a task is poison is now a
  precise `NondeterminismError` naming both sides of the divergence.

  **The execution is never auto-terminated.** A workflow-task failure is nearly
  always a code bug, and workflow code is redeployable — fix it, roll the workers,
  and the execution replays past the throw and carries on. Terminating would
  destroy recoverable work. This follows Temporal, and the reasoning is in
  [sprint 05](planning/sprints/05-phase-6-scope.md#the-dead-letter-question-settled).

- ~~**`tempo terminate <id>`**~~ — **landed.** Settles the execution _without_
  replaying it, which is exactly why `cancel` could not serve: cancellation is
  cooperative and delivered through replay, so on a wedged execution it is
  recorded and never applied. Confirmed against a real one — `cancel` left it
  `running` with `cancelRequested: true` and the failure count still climbing,
  and `terminate` ended it. `terminated` is its own `ExecutionStatus` rather than
  a flavour of `failed`, so a postmortem can tell "an operator pulled the plug"
  from "your code raised".
- ~~**Per-execution inspection**~~ — **landed.** `tempo describe <id>` and
  `tempo list` over new `describeExecution`/`listExecutions` RPCs, reporting what
  an execution is parked on. Views are derived from history, never stored
  ([`src/server/execution_view.ts`](src/server/execution_view.ts)), over the same
  outstanding-work derivation crash recovery re-dispatches
  ([`src/server/pending_work.ts`](src/server/pending_work.ts)) — so what an
  operator is told and what resume actually does cannot drift. Closes the
  history-inspection half of blocker 5; metrics and tracing remain in Phase 7.
- ~~**Activity start-to-close timeouts**~~ — **landed** (blocker 1). Opt-in via
  `ActivityOptions.startToCloseTimeoutMs`: at the deadline the server fails the
  attempt _and acks the task_, so the lease cannot later redeliver it into a
  second concurrent run — the ack is the half that turns a timeout into a bound.
  A late report from the abandoned worker is dropped by the completion dedup.
  Left unset, the old at-least-once redelivery stands, which is still the right
  default for a crashed worker. **Heartbeats remain unbuilt**, so the server still
  cannot distinguish a slow worker from a dead one; a long, honest attempt has no
  way to keep its claim, which is what a heartbeat would buy.
- **Structured lifecycle log**, replacing ad-hoc stderr writes — no new dependency,
  and it is the source Phase 7 aggregates.

**Exit criterion:** no execution stops making progress silently. A stuck one
reports what it is waiting on, how many times it has tried, and why it last
failed; an operator can end it; and deploying corrected workflow code lets it
finish. Specs prove all three, the attempt count across a server restart.

### Phase 7 — Measurement and control

_You can see what the system is doing, and it can throttle itself._ Everything
here needs Phase 6's durable attempt accounting to build on.

- ~~**Server-decided retry**~~ — **landed** (closes blocker 6). The server counts
  attempts per activity `seq` on the execution record and re-queues with backoff,
  rebuilding the task from its `activityScheduled` marker. Two things this fixed
  beyond durability: `maximumAttempts` was only ever applied by the local drain
  loop, so a **distributed activity worker retried nothing at all** — the same
  workflow behaved differently depending on how it was hosted — and an attempt
  count in worker memory was refreshed by any worker or server restart. Both
  modes now make one attempt per delivery and let the server decide.
- **Metrics and tracing** — queue depth, task latency, history size (blocker 5,
  the rest of it). **Sink decided: plain structured logs.** The instrumentation
  has landed as JSON Lines on stderr — `execution.started` / `.settled`,
  `activity.scheduled` / `.settled` / `.timed_out` / `.duplicate_dropped`,
  `workflow_task.completed` / `.failed` / `.discarded`, `worker.poll_failed` —
  emitted through an injected `Logger` port so a real backend can be swapped in
  later without touching a call site
  ([`src/server/ports/logger.ts`](src/server/ports/logger.ts)). Task latency and
  history size are already derivable from a run's log. **Queue depth is not**: the
  queues expose no size, so that one needs a port addition before anything can
  chart it. Aggregation and alerting remain unbuilt — the log is a source, not a
  dashboard.
- **Retry-storm backpressure.** Genuinely blocked until retry is a server decision:
  you cannot throttle a decision the server does not make.
- **Load and soak tests**, once there is instrumentation to read a run by.

**Exit criterion:** dashboards for queue depth, task latency, and history size —
the last of which is what continue-as-new tuning needs — and a retry storm that
degrades instead of compounding.

### Phase 8 — Durable shared state

_Server state stops being process-local._ Today only the history store is
swappable: `createServerHost` hardcodes the in-memory queues and timer service, so
durability comes from `resume()` replaying history rather than from anything the
queues persist.

- **A multi-writer history store** (SQLite/Postgres-shaped) behind the existing
  port. `FileHistoryStore` is explicitly workstation-scale — it caches every
  execution in memory and rebuilds all of it at boot — and its single-writer
  lockfile forbids a second server by design.
- **Durable task queues** behind `ports/task_queue` and `ports/workflow_task_queue`.
- **Server-side correlation state** (`childrenByParent`, `parentOfChild`) moved out
  of `server_core`'s closure, where two live servers would each hold half of it.

**Exit criterion:** two server processes can point at one store without corrupting
it, even if only one is serving traffic.

### Phase 9 — HA and failover

_Losing the server stops being an outage._ Only reachable once Phase 8 lands.

- **Leader election for the timer sweep.** Timers reconstruct from history on
  resume, but there is no cross-process sweep election — the last piece that
  assumes exactly one server.
- **Failover**, and the operational story around it.

**Exit criterion:** documented, tested behavior under worker loss, server
failover, and store failover.

## Unphased

Real work that does not sequence behind anything, so it is not worth pinning to a
phase.

- **Auth and TLS on the RPC** (blocker 4). Triggered, not scheduled: worthless
  while everything is on one host behind the loopback bind, mandatory the moment
  that bind widens. The trigger is the first worker on another machine — see the
  operational notes in [`bin/server-main.ts`](bin/server-main.ts).
- **Workflow versioning** (blocker 3). No `getVersion`/`patched` primitive, so
  editing a workflow with live executions diverges their replay from history and
  lands in blocker 2; the only safe deploy today is a drained one. This is an
  addition to the author-facing API in [`src/workflow.ts`](src/workflow.ts), so it
  needs design before it can be scheduled at all.
- ~~**Counter-collision on resume**~~ — **landed** (blocker 7). The stated fix,
  seeding the counter past resumed ids, only covered half of it: a caller can
  always pass an explicit `workflowId`, but `startChild` has no such option, so a
  child was stuck with whatever the counter produced. Child ids are now derived
  from lineage — `parent.run.seq`, including the run because continue-as-new
  resets `seq` — which needs no counter and no recovery. The counter that remains
  (client starts with no id) is seeded on resume, and a duplicate id no longer
  escapes as an unhandled rejection.
- **The deployment CLI** — `server install`, `deploy`, `status`, `logs`,
  `rollback`. Surface designed in [`src/cli/cli.ts`](src/cli/cli.ts) and
  [`planning/sprints/01-deployment-api.md`](planning/sprints/01-deployment-api.md).
- **Sticky cache** in the workflow worker — keep warm suspended executions to skip
  cold replay ([`src/worker/workflow_worker.ts`](src/worker/workflow_worker.ts)).
  Pure performance; correctness never depends on it, which is the point.

## Invariants that hold in every phase

1. **The determinism boundary is never crossed.** `core/` stays pure; features are
   placed by asking "deterministic or not?" ([`src/workflow.ts`](src/workflow.ts)).
2. **The suite stays green.** `LocalService` is the always-on fast regression net;
   the remote and distributed specs catch the failure semantics it cannot
   ([`src/services/local_service.ts`](src/services/local_service.ts)).
3. **New seams are interfaces first** — in-memory implementation, then swap.
4. **`protocol/` types are the wire format.** Additions there are additions to a
   durable, serialized contract; treat them with versioning care.

## Out of scope by design

**Exactly-once activity effects.** The framework guarantees at-least-once;
idempotency is the activity author's responsibility. Schema versioning and
migration for persisted `protocol` types is deferred, not rejected.

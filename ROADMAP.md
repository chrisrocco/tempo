# Roadmap

What's left to build. For what already works, see [`README.md`](README.md); for
in-flight design work,
[GitHub issues](https://github.com/chrisrocco/tempo/issues).

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

| #   | Blocker                                   | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Mitigation today                                                                                                        | Fix owned by                                                                 |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | ~~No activity heartbeat~~                 | **Closed.** An attempt can now prove it is alive: `heartbeat()` renews the lease and resets a `heartbeatTimeoutMs` deadline, so unbounded work keeps its claim and a dead worker is caught in one heartbeat interval instead of one lease. An activity that sets neither timeout still redelivers on lease expiry, which remains the right default for a crashed worker.                                                                                                                                                                                                                                                                                            | Set `heartbeatTimeoutMs` for long work, `startToCloseTimeoutMs` for bounded work; keep effects idempotent.              | Done (Phase 6)                                                               |
| 2   | Nothing alerts on a wedged execution      | A replay that throws no longer hides: the failure is counted, backed off, reported by `describe`, fixable by redeploy, and endable with `terminate`. But discovering it still requires someone to look — `getResult` waits indefinitely by design, and no alert fires.                                                                                                                                                                                                                                                                                                                                                                                              | `Client.describe()` / `list()`; `terminate` to end one.                                                                 | Phase 7 (handling landed)                                                    |
| 3   | Workflow versioning, less the engine half | **Half closed.** `patched(id)` / `deprecatePatch(id)` let a workflow's body gain a branch while executions are in flight: the choice is recorded per call site in history, so an execution keeps the branch it already took and one that has not reached the call site adopts the change. What remains is the _engine_ half — a change to replay semantics reaches every workflow at once and no author can wrap it in `patched` (question 4 on [#52](https://github.com/chrisrocco/tempo/issues/52)). Unversioned edits are no longer silent either: a replay that settles an execution while history holds work it never issued is stopped rather than published. | Wrap a change to a live workflow in `patched`. Still drain before changing **replay semantics**, which no patch covers. | Partly done / rest unphased                                                  |
| 4   | No auth or TLS; single server             | The RPC starts, signals, and cancels arbitrary workflows unauthenticated; the loopback bind is the only thing containing it. The server is also a single point of failure and a single writer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Keep everything on one trusted host; do not widen the bind without a private network.                                   | [#149](https://github.com/chrisrocco/tempo/issues/149) (auth) / HA milestone |
| 5   | Nothing aggregates or alerts              | Per-execution state is inspectable (`Client.describe()` / `list()`) and the server emits structured lifecycle events, but nothing rolls them up or alerts. Queue depth is now readable per pool (`backlog()` on both queue ports), so the inputs exist; the aggregate view and a stuck-execution predicate do not — [#150](https://github.com/chrisrocco/tempo/issues/150).                                                                                                                                                                                                                                                                                         | `Client.describe()` / `queues()`; pipe the server's JSONL stderr somewhere you can query.                               | #150 (instrumentation landed)                                                |
| 6   | ~~Retry state is not durable~~            | **Closed.** Attempts are counted on the execution record and the server decides retries, so the budget holds across worker loss and server restarts, and is applied identically in local and distributed mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —                                                                                                                       | Done (Phase 7)                                                               |
| 7   | ~~Generated ids collide on restart~~      | **Closed.** Child ids are derived from lineage (`parent.run.seq`) instead of a counter, so they are stable across restarts and across continue-as-new; the root counter is seeded past existing ids on resume; and a duplicate id is logged rather than escaping as an unhandled rejection, which used to kill the server.                                                                                                                                                                                                                                                                                                                                          | —                                                                                                                       | Done                                                                         |

Blockers 1, 2, and 6 were one missing capability — **the server kept no account of
attempts** — and building it closed 1 and 6 outright. What is left of 2 is not
survival but _noticing_: a wedged execution is counted, bounded, inspectable and
escapable, and the instrumentation to spot one exists, but nothing aggregates or
alerts on it yet.

## Milestones

Tempo has serious users running agentic workloads, and the remaining phases are now
tracked as four GitHub milestones, each an outcome with its issues. The phases below
still hold the reasoning; the milestones hold the living state, per the
no-planning-docs rule (#38).

| Milestone                                                                          | Outcome                                                                                                         | Issues                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Serve agents safely](https://github.com/chrisrocco/tempo/milestone/1)             | The engine can stop, observe, and keep history bounded for a long-running agent.                                | [#146](https://github.com/chrisrocco/tempo/issues/146) [#147](https://github.com/chrisrocco/tempo/issues/147) [#148](https://github.com/chrisrocco/tempo/issues/148) [#99](https://github.com/chrisrocco/tempo/issues/99)                                                        |
| [A control plane teams can share](https://github.com/chrisrocco/tempo/milestone/2) | One server, many teams, reachable from other machines, and it says what it is.                                  | [#149](https://github.com/chrisrocco/tempo/issues/149) [#150](https://github.com/chrisrocco/tempo/issues/150) [#151](https://github.com/chrisrocco/tempo/issues/151)                                                                                                             |
| [Shared state](https://github.com/chrisrocco/tempo/milestone/3)                    | Server state stops being process-local. Phase 8, made concrete; Spanner is one adapter, proved elsewhere first. | [#152](https://github.com/chrisrocco/tempo/issues/152) [#153](https://github.com/chrisrocco/tempo/issues/153) [#154](https://github.com/chrisrocco/tempo/issues/154) [#155](https://github.com/chrisrocco/tempo/issues/155) [#76](https://github.com/chrisrocco/tempo/issues/76) |
| [HA](https://github.com/chrisrocco/tempo/milestone/4)                              | Losing the server stops being an outage. Phase 9.                                                               | [#156](https://github.com/chrisrocco/tempo/issues/156) [#157](https://github.com/chrisrocco/tempo/issues/157)                                                                                                                                                                    |

The first two run in parallel; Shared state follows in issue order, since each
assumes the store from the one before; HA follows Shared state.

**Schedules landed alongside**, in [`src/schedule/`](src/schedule/index.ts):
interval specs, nominal-time dedup, pause and trigger. What remains — calendar
specs, overlap policies, backfill — is
[#69](https://github.com/chrisrocco/tempo/issues/69), unphased.

## Phases 6–9

What used to be one "production" phase is four, sequenced by what each one
depends on. Two things that sequencing changed:

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
  destroy recoverable work. This follows Temporal; the full reasoning, and the
  two things that fall out of it, are on `failWorkflowTask` in
  [`src/server/server_core.ts`](src/server/server_core.ts).

- ~~**Terminate a wedged execution**~~ — **landed** as `Client.terminate()`. Settles the execution _without_
  replaying it, which is exactly why `cancel` could not serve: cancellation is
  cooperative and delivered through replay, so on a wedged execution it is
  recorded and never applied. Confirmed against a real one — `cancel` left it
  `running` with `cancelRequested: true` and the failure count still climbing,
  and `terminate` ended it. `terminated` is its own `ExecutionStatus` rather than
  a flavour of `failed`, so a postmortem can tell "an operator pulled the plug"
  from "your code raised".
- ~~**Per-execution inspection**~~ — **landed.** `Client.describe()` and
  `Client.list()` over new `describeExecution`/`listExecutions` RPCs, reporting what
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
  default for a crashed worker.
- ~~**Activity heartbeats**~~ — **landed** (closes blocker 1). `heartbeat()` from
  inside an activity renews its lease and resets a `heartbeatTimeoutMs` deadline,
  so work of genuinely unbounded duration — an agent that thinks for ten minutes
  — holds its claim while it is demonstrably working, and a dead worker is caught
  in one heartbeat interval rather than one lease. Explicit rather than a timer
  in the worker, which would keep beating for a wedged activity and report only
  that the process is alive. Calls are throttled worker-side, so a loop body is a
  fine place to put one. Activity code reaches it through a new
  [`src/activity.ts`](src/activity.ts) entrypoint.
- ~~**Activity checkpoints**~~ — **landed**. A beat may carry one, surfacing on
  `PendingActivityView` as `checkpoint` + `checkpointAt`, so a UI polling
  `describe` can watch a query that runs for hours. A register rather than a log:
  one slot per attempt, discarded with it, and never a history event — beats are
  unbounded per attempt, unlike the retries `activityRetryScheduled` records. The
  payload contract and the shapes rejected for the throttle are in
  [`src/worker/activity_context.ts`](src/worker/activity_context.ts).
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
  history size are already derivable from a run's log, and queue depth is now a
  live reading on both queue ports (`backlog()`). Aggregation and alerting remain
  unbuilt — the log is a source, not a dashboard — and are
  [#150](https://github.com/chrisrocco/tempo/issues/150).
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

### Landed alongside — task-queue routing

Not a phase item, but it turned out to be a prerequisite for running more than one
application against a server. With a single global queue, a workflow task for app
A could be claimed by an app B worker, which has no such workflow registered — and
that used to **settle the execution as failed**, nondeterministically, depending
on which worker won the poll.

Work is now routed by queue name: workers declare theirs (`--queue`), callers
pick one (`start`'s `taskQueue` option), and activities and children inherit their
execution's. An unregistered workflow type is now a _task_ failure rather than an
execution failure — it usually means a deploy still rolling, and recovering when
the right version lands is worth more than failing fast, which is the poison-task
policy applied consistently.

Still unbuilt, and deliberately: **sticky sessions** (routing a run of activities
to one specific host, for local state that cannot be a commit) need a session
lifecycle and host liveness on top of this, which is where the real difficulty is.

## Unphased

Real work that does not sequence behind anything, so it is not worth pinning to a
phase.

- **Auth on the RPC** (blocker 4) — **triggered**, and now
  [#149](https://github.com/chrisrocco/tempo/issues/149) in the control-plane
  milestone. It was worthless while everything sat on one host behind the loopback
  bind and mandatory the moment that bind widened; teams sharing a server is that
  moment. TLS is deliberately left to the ingress in front of the server — see the
  operational notes in [`src/server_main.ts`](src/server_main.ts).
- ~~**Workflow versioning**~~ — **the author half landed** (blocker 3, partly).
  `patched(id)` is on the author entrypoint: wrap the new code, leave the old in the
  `else`, and both an execution that has run the old path and one that has not can
  replay the same source. The decision is recorded per call site as a
  `patchRecorded` marker and read back **before the branch allocates a seq**, which
  is the only part that is subtle — a version branch changes how many commands are
  issued, and seq is assigned in call order, so a branch decided late or decided
  differently renumbers every completion after it. `core/workflow_api.patched` owns
  the reasoning, including why one boolean per change beat `getVersion(id, min,
max)`. `deprecatePatch(id)` retires a patch, and exists because deleting the `if`
  is _not_ the same as deleting the call: the marker holds a seq that still has to
  be accounted for.

  **What is deliberately not built: the engine half.** A change to replay semantics
  — [#51](https://github.com/chrisrocco/tempo/issues/51)'s batch settling is the
  live example — reaches every workflow at once, including ones nobody edited, and
  no author can wrap the driver in `patched`. That needs a per-execution stamp of
  the semantics in force, honoured for the life of the run (question 4 on
  [#52](https://github.com/chrisrocco/tempo/issues/52)); it is a `protocol/`
  decision of its own size and is not bundled here. So "drain before deploying"
  survives, narrowed to exactly the case it is true for.

  Paired with it, and worth having either way: an unversioned edit is no longer
  silent. A replay that **settles** an execution while history holds dispatched work
  it never issued is stopped and reported as a task failure rather than completing
  with a result computed without that work
  ([`src/core/apply_event.ts`](src/core/apply_event.ts)). That was the measured
  failure on #52 — `done=true`, zero commands, an orphaned activity, no error.

- ~~**Counter-collision on resume**~~ — **landed** (blocker 7). The stated fix,
  seeding the counter past resumed ids, only covered half of it: a caller can
  always pass an explicit `workflowId`, but `startChild` has no such option, so a
  child was stuck with whatever the counter produced. Child ids are now derived
  from lineage — `parent.run.seq`, including the run because continue-as-new
  resets `seq` — which needs no counter and no recovery. The counter that remains
  (client starts with no id) is seeded on resume, and a duplicate id no longer
  escapes as an unhandled rejection. `executeChild`/`startChild` also take an
  explicit `workflowId` now, which is a _claim_: the same id twice yields one
  child, so "one planner per calendar event" is expressible in the workflow
  rather than reconstructed from its own bookkeeping.
- ~~**Deployment**~~ — **out of scope, deliberately**
  ([#64](https://github.com/chrisrocco/tempo/issues/64)). It was built twice here
  — first as a CLI, then as a systemd library over a `Host` seam — and both had
  the same defect: everything they knew was about a machine this repo has never
  run on, so every assumption could only be falsified in the consumer's repo and
  only fixed in this one. The `/usr/bin/node` in `ExecStart=` is the specimen.
  What this library owes a deployment instead is that both artifacts are ordinary
  library calls — [`startServer`](src/server_main.ts) and
  [`startWorker`](src/tempo.ts) — plus the client and the flag vocabulary,
  all exported. Installing and supervising them is the consumer's, and README's
  "Running it yourself" is the whole of what this repo says about it. Supersedes
  [#41](https://github.com/chrisrocco/tempo/issues/41).
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

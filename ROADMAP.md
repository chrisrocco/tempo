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

| #   | Blocker                              | Consequence                                                                                                                                                                                                                                                  | Mitigation today                                                                                                                                     | Fix owned by                   |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | No activity timeout or heartbeat     | A lease expires on elapsed time alone, so an activity slower than `ACTIVITY_LEASE_MS` (global, default 30s) is redelivered and runs **concurrently** with the attempt still in flight, once per lease period. Two activity replicas is enough to trigger it. | Keep activities well under the lease; raise `ACTIVITY_LEASE_MS`, at the cost of slower crash detection for everything else; make effects idempotent. | Phase 6                        |
| 2   | Poison tasks wedge an execution      | Any replay that throws — a workflow bug, a nondeterminism error — leaves a task that cannot be completed, so the lease redelivers it forever. `getResult` never returns and the only signal is stderr backoff.                                               | None. Detect by watching for one execution replaying endlessly.                                                                                      | Phase 6                        |
| 3   | No workflow versioning               | Deploying changed workflow code while executions are in flight diverges replay from history, which lands in blocker 2.                                                                                                                                       | Drain in-flight executions before deploying a changed workflow.                                                                                      | Unphased (needs design)        |
| 4   | No auth or TLS; single server        | The RPC starts, signals, and cancels arbitrary workflows unauthenticated; the loopback bind is the only thing containing it. The server is also a single point of failure and a single writer.                                                               | Keep everything on one trusted host; do not widen the bind without a private network.                                                                | Unphased (auth) / Phase 9 (HA) |
| 5   | No operational visibility            | No metrics, no tracing, no way to list executions or inspect a history. Debugging a stuck workflow means reading the data dir by hand.                                                                                                                       | `tempo result`, and the `.jsonl` logs under `DATA_DIR`.                                                                                              | Phase 6 / Phase 7              |
| 6   | Retry state is not durable           | Retry counters live in the activity worker's memory, so a worker lost mid-backoff restarts attempts at 0 on redelivery — `maximumAttempts` is best-effort under worker loss.                                                                                 | Assume more attempts than configured; keep activities idempotent.                                                                                    | Phase 7                        |
| 7   | Generated ids can collide on restart | `LocalService`/`ServerHost` counters restart at 0, so a fresh child id can collide with a resumed one.                                                                                                                                                       | Pass explicit `workflowId`s.                                                                                                                         | Unphased                       |

Blockers 1, 2, and 6 reduce to one missing capability: **the server cannot tell a
worker that is slow from one that is gone, and has no terminal disposition for
work that can never succeed.** Scope them together and the fix is one mechanism,
not three.

## Phases 6–9

What used to be one "production" phase is four, sequenced by what each one
depends on. The decomposition and the evidence behind it are in
[`planning/sprints/05-phase-6-scope.md`](planning/sprints/05-phase-6-scope.md);
this is the schedule that came out of it. Two things it changed:

- **Phases are scoped by mechanism, not by symptom.** Activity timeouts used to
  sit in "finishing distribution" and dead-lettering in "production", but they are
  one capability — the server having an opinion about attempts and about when work
  is beyond saving — so they ship together in Phase 6.
- **HA moved behind the store.** A shared multi-writer store is a _prerequisite_
  for HA, not a sibling of it, so it gets its own phase before it.

### Phase 6 — Operability

_An execution can no longer stop making progress silently._ Both ways it can
happen today (a poison task, a hung activity) present identically as silence.

- **Dead-letter poison workflow tasks.** Count deliveries durably; past a
  threshold, stop redelivering and settle the execution with a diagnosable reason
  (adoption blocker 2). The count must survive a restart — the queues are
  in-memory, so a counter held there is reset by exactly the restart an operator
  will try.
- **Per-execution inspection** — `tempo describe <id>` and `tempo list`, plus the
  RPCs they need; `WorkflowService` has no history fetch today (blocker 5, in
  part). Prerequisite for the above being usable: a dead-letter nobody can inspect
  just relocates the mystery.
- **Activity start-to-close timeouts** (blocker 1), then heartbeats. The timeout is
  the part that ends the duplicate-concurrent-run behavior; heartbeats can follow
  inside the phase. See
  [`src/worker/activity_worker.ts`](src/worker/activity_worker.ts) for what the gap
  costs today.
- **Structured lifecycle log**, replacing ad-hoc stderr writes — no new dependency,
  and it is the source Phase 7 aggregates.

**Exit criterion:** no execution can stop making progress without becoming
terminal and inspectable, and a spec proves it across a server restart.

### Phase 7 — Measurement and control

_You can see what the system is doing, and it can throttle itself._ Everything
here needs Phase 6's durable attempt accounting to build on.

- **Server-decided retry.** Retry is worker-side and in-memory today; moving it to
  the server (re-enqueue with backoff) is what makes attempt counts durable
  (blocker 6). It reuses Phase 6's accounting rather than inventing its own.
- **Metrics and tracing** — queue depth, task latency, history size (blocker 5, the
  rest of it). Needs a sink decision first.
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
- **Counter-collision on resume** (blocker 7). `LocalService`/`ServerHost` counters
  restart at 0, so a fresh child id can collide with a resumed one. Harmless with
  explicit `workflowId`s; seed the counter past resumed ids to fix.
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

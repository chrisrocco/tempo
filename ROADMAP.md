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

## Next — finishing distribution

- **Activity heartbeats + start-to-close timeouts.** Deferred since Phase 3; the
  activity worker does one attempt per delivery today and relies on lease
  redelivery when a worker dies.
- **Server-decided retry.** Retry is worker-side today; it belongs as a server
  decision (re-enqueue with backoff). Move it when heartbeats land.
- **Sticky cache** in the workflow worker — keep warm suspended executions to skip
  cold replay. See [`src/worker/workflow_worker.ts`](src/worker/workflow_worker.ts).
- **Durable timer-sweep failover.** Timers reconstruct from history on resume, but
  there is no cross-process sweep leader-election.

## Next — hardening

- **Import-path lint rule.** Finish Phase 1's enforcement of the determinism
  boundary: `core` may import only `protocol`, workflow code only `workflow.ts`.
  Today both hold by discipline. The rule should fail a deliberately-planted
  `Date.now()` in a workflow file.
- **Counter-collision on resume.** `LocalService` and `ServerHost` id counters
  restart at 0, so a newly generated child id can collide with a resumed one.
  Harmless with explicit `workflowId`s; seed the counter past resumed ids to fix.
- **The deployment CLI** — `server install`, `deploy`, `status`, `logs`,
  `rollback`. Surface designed in [`src/cli/cli.ts`](src/cli/cli.ts) and
  [`planning/sprints/01-deployment-api.md`](planning/sprints/01-deployment-api.md).

## Phase 6 — production

Untouched. Poison-task handling and dead-lettering; retry-storm backpressure;
observability (metrics, tracing, per-execution history inspection); server HA and
failover; auth and TLS on the RPC; load and soak tests. Exit criteria: documented,
tested behavior under worker loss, server failover, and store failover, plus
dashboards for queue depth, task latency, and history size (which feed
continue-as-new tuning).

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

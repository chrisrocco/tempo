# Implementation Roadmap

A phased path from the current in-memory runtime to a resilient distributed
system. The guiding strategy: **introduce every seam as an interface with an
in-memory implementation first, keep the test suite green, then swap one
implementation at a time.** Each process boundary should be a substitution behind
a tested interface, never a rewrite.

Legend: **Goal** · **Deliverables** · **Exit criteria** · **Where it's documented**

> Design documentation lives in the `@fileoverview` comment of the module that
> owns each idea; the historical `0N` doc shorthand below has been replaced with
> the module to read. See [`README.md`](README.md) for the reading order.

---

## Phase 0 — Current state (done)

The working baseline this roadmap builds on.

- Deterministic core (context, primitives, `condition`, signals, `applyEvent`,
  `replay`) and an in-process runtime (`drive`, `pump`, `executeCommand`,
  blocking children).
- Fully typed (`tsc --noEmit` clean); 28 specs green under Jasmine + `tsx`.

**Read:** `src/core/replay.ts`, `src/core/condition.ts`, `src/core/signals.ts`, `src/protocol/`.

---

## Phase 1 — Restructure to the layered layout (no behavior change)

- **Goal:** make the determinism boundary physical and enforced before adding
  features.
- **Deliverables:** split the monolith into `protocol/`, `core/`, `runtime`
  pieces per the layered layout; add the two entrypoints (`workflow.ts`,
  `index.ts`); add the
  import-path lint rule (`core` may import only `protocol`; workflow code may
  import only `workflow.ts`). Move the standalone `replay.ts` to `examples/`.
- **Exit criteria:** identical behavior; all Phase 0 specs still pass; the lint
  rule fails a deliberately-planted `Date.now()` in a workflow file.
- **Read:** `src/workflow.ts`, `src/index.ts`.

## Phase 2 — Introduce the ports and the service seam (still in-memory)

- **Goal:** put the extensibility seams in place without changing where code runs.
- **Deliverables:** define `HistoryStore`, `TaskQueue`, `TimerService` interfaces
  and in-memory adapters; define the `WorkflowService` interface; implement
  `LocalService` (server_core + memory adapters + `pump`). Rewrite the existing
  runtime to go through these. Workers/client (even if trivial in-proc) written
  against `WorkflowService`.
- **Exit criteria:** the whole suite runs against `LocalService` unchanged;
  `pump` is now scoped inside `LocalService`.
- **Read:** `src/server/ports/workflow_task_queue.ts`, `src/protocol/service.ts`.

## Phase 3 — Feature completeness in local mode

- **Goal:** finish the programming model against the fast in-memory service.
- **Deliverables:**
  - **`proxyActivities`** + `ActivityOptions` on the command (`src/protocol/activity_options.ts`).
  - **`continueAsNew`** end to end: primitive (core), command (protocol), handler
    behavior incl. sparing children + resetting history accounting (server);
    `continueAsNewSuggested` populated by the (in-memory) server (`src/core/workflow_api.ts`).
  - **Real timers:** durable fire-time recorded in history + a sweep loop, instead
    of firing immediately (`src/server/ports/timer_service.ts`).
  - **Retry policy & heartbeats** semantics in the activity task handler (`src/server/retry_policy.ts`).
  - **Cancellation + fire-and-forget children** — the deferred pieces. This is
    what finally lets the original **bug-hotlist monitor** run for real
    (spawn-and-cancel), rather than the blocking child model. Needs cancellation
    scopes and `CancelledFailure` propagation; give it its own design pass.
- **Exit criteria:** the spawn-and-cancel monitor runs against `LocalService`;
  new specs cover continue-as-new (incl. children surviving), timer ordering,
  retries, and cancellation. _(Met. The example itself was later retired pending
  a rework, so the primitives are covered by `spec/integration/local.spec.ts`.)_
- **Read:** `src/core/workflow_api.ts`, `src/server/server_core.ts`.

## Phase 4 — Durable persistence

- **Goal:** survive process restarts; make the server the one stateful tier.
- **Deliverables:** a database `HistoryStore` with **optimistic versioning**;
  batch the per-task event appends into a **single transaction** (task-completion
  boundary); "record scheduled before running" for crash-recovery idempotency.
- **Exit criteria:** kill the process mid-workflow and have it resume correctly on
  restart; concurrent appends with a stale version are rejected.
- **Read:** `src/server/ports/`, `src/server/file/file_history_store.ts`.

## Phase 5 — Distribution

- **Goal:** run server, workflow workers, and activity workers as separate,
  independently scalable, crash-tolerant processes.
- **Deliverables:** RPC transport + `rpc.ts` types; `RemoteService`; the three
  `bin/` process mains; **leasing + expiry-driven redelivery**; the version check
  as the distributed replacement for `pump`'s exclusion; sticky cache in the
  workflow worker; at-least-once hardening with documented idempotency contract;
  durable timer sweep with failover.
- **Exit criteria:** `integration/remote.spec.ts` passes against a real server
  process, including: a killed worker's task redelivers; a lease-race loser's
  append is rejected; a retried activity surfaces at-least-once behavior.
- **Read:** `src/services/`, `src/server/lease.ts`.

## Phase 6 — Production hardening

- **Goal:** operability and failure-mode resilience.
- **Deliverables:** poison-task handling / dead-letter; retry-storm backpressure;
  timer-sweeper failover tests; observability (metrics, tracing, per-execution
  history inspection); database HA; load/soak tests.
- **Exit criteria:** documented, tested behavior under worker loss, server
  failover, and DB failover; dashboards for queue depth, task latency, and
  history size (feeding continue-as-new tuning).
- **Read:** `src/services/server_host.ts`, `bin/server-main.ts` (the operational
  caveats this phase has to close out).

---

## Cross-cutting invariants (hold in every phase)

1. **The determinism boundary is never crossed.** `core/` stays pure; features are
   placed by asking "deterministic or not?" (`src/workflow.ts`).
2. **The suite stays green.** `LocalService` is the always-on fast regression net;
   `RemoteService` integration tests are added from Phase 5 to catch the failure
   semantics the local path can't (`src/services/local_service.ts`).
3. **New seams are interfaces first.** In-memory implementation, then swap.
4. **`protocol/` types are the wire format.** Additions there are additions to the
   durable/serialized contract — treat them with versioning care from Phase 4 on
   (`src/protocol/`).

## Known deferred items (tracked so they aren't lost)

- Cancellation + fire-and-forget children (Phase 3) — required for the real
  monitor use case.
- Timer _ordering/duration_ fidelity (Phase 3) — currently fires immediately.
- `protocol` schema versioning/migration once persisted (Phase 4+).
- Exactly-once activity effects are **out of scope by design** — the framework
  provides at-least-once; idempotency is the activity author's responsibility.

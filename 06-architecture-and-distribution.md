# 06 — Architecture & Distribution

The project structure, the seams that make it extensible, and how the same code
scales from one process to three resilient tiers.

## Project structure

```
src/
  protocol/         # PURE DATA + CONTRACTS. no logic, no deps. the wire format.
    commands.ts activity_options.ts history_events.ts task_token.ts
    service.ts rpc.ts index.ts
  core/             # DETERMINISTIC ENGINE. (history) -> (commands). no I/O/clock/random.
    context.ts workflow_api.ts signals.ts condition.ts
    apply_event.ts microtask_scheduler.ts replay.ts index.ts
  server/           # ORCHESTRATION BRAIN. stateful, runs NO user code.
    ports/          history_store.ts task_queue.ts timer_service.ts
    memory/         memory_history_store.ts memory_task_queue.ts memory_timer_service.ts
    workflow_task_handler.ts activity_task_handler.ts retry_policy.ts
    lease.ts server_core.ts index.ts
  services/         # the two WorkflowService implementations
    pump.ts local_service.ts remote_service.ts index.ts
  worker/           # STATELESS workers, written once against WorkflowService
    workflow_worker.ts sticky_cache.ts
    activity_worker.ts activity_registry.ts index.ts
  client/           client.ts index.ts
  local_runtime.ts  # createLocalRuntime(): LocalService + in-proc workers + client
  workflow.ts       # ★ AUTHOR ENTRYPOINT — deterministic primitives ONLY
  index.ts          # ★ HOST ENTRYPOINT — createLocalRuntime, workers, client, types
bin/                # deployable process mains
  server-main.ts workflow-worker-main.ts activity-worker-main.ts
examples/           minimal_replay.ts bug_hotlist_monitor.ts
spec/               # mirrors src/ (+ integration/local.spec.ts, integration/remote.spec.ts)
```

## The two rules that keep it honest

1. **Dependencies point down:** `protocol <- core <- {server, services, worker,
   client} <- {local_runtime, entrypoints, bin}`. Nothing in `core/` imports from
   below it.
2. **Two entrypoints:** workflow code imports only from `workflow.ts` (deterministic
   surface); hosts import from `index.ts`. A lint rule enforces both, turning the
   determinism boundary (`01`) into a build-time invariant.

## The `WorkflowService` seam

Workers and client are written **once**, against a `WorkflowService` interface
(start/signal/getResult + the worker-facing poll/respond methods). Two
implementations satisfy it:

- **`LocalService`** — the whole server in-process: in-memory ports + `pump`.
  Fast; for tests and single-node runs.
- **`RemoteService`** — an RPC client to a networked server.

Local vs. distributed is a *choice of implementation*, not a fork of the runtime.
Your existing suite runs against `LocalService` unchanged.

## Ports & adapters

The server coordinates over three interfaces so implementations swap without
touching orchestration logic:

- `HistoryStore` — `load`/`append` with an **optimistic version**.
- `TaskQueue` — `enqueue`/`poll`/`lease`/`ack`/`expire-and-requeue`.
- `TimerService` — durable `schedule` + crash-tolerant `sweep`.

In-memory adapters power `LocalService`; durable adapters (a database, a real
queue) are the distributed swap.

## Going distributed: three tiers

The move isn't inventing new components — it's promoting existing function-call
boundaries to process boundaries. **`core/` doesn't move; it runs inside the
workflow worker.**

- **Server** — the only stateful tier, and it runs **no user code**. Owns
  histories, queues, timers, and the transactional logic that advances them.
  Client-facing API (Start/Signal/GetResult) and worker-facing API
  (poll/respond for both task types, heartbeat). Its heart is the
  **workflow-task handler**: on receiving a command batch it *atomically* appends
  events, creates downstream tasks, and closes the task — conditional on a version
  check.
- **Workflow workers** — stateless. Poll a workflow task → build context from the
  returned history → `replay` (core) → respond with commands. Keep a **sticky
  cache** of warm executions (pure optimization: hit = resume, miss = cold replay
  from fetched history). Workflow *types* register here.
- **Activity workers** — stateless. Poll an activity task → run the registered
  activity function → report result/failure, heartbeating long ones. This is the
  **only place I/O happens**. Activity *implementations* register here.

## What makes it resilient

- **Leasing + redelivery.** Every polled task carries a lease (token + timeout).
  A crashed worker's lease expires and the server redelivers to another. This is
  what makes worker crashes survivable — and it's the distributed form of `pump`'s
  Job 1.
- **Optimistic concurrency.** Two workers can end up holding a task for the same
  execution (lease race). Both replay; both respond; the append is conditional on
  the execution's version; the loser is rejected. Discarding the loser is safe
  **because replay commits no external effects** — the determinism boundary paying
  off directly.
- **At-least-once + idempotency.** Lease redelivery means activities may run more
  than once. The workflow side dedups naturally (a duplicate completion for a
  known seq is discarded on replay). Activity **side effects** are the author's
  responsibility to make idempotent (idempotency keys). The framework guarantees
  at-least-once; exactly-once effects are on you.
- **Retries & heartbeats.** Activity failures retry with backoff per policy (a
  server decision: retry vs. surface as a catchable failure). Long activities
  heartbeat so the server distinguishes "slow" from "dead."
- **Durable timers.** Persisted with a recorded fire-time, swept by a
  crash-tolerant loop with failover.

## `proxyActivities`

A typed façade over `runActivity`, living in `core/workflow_api.ts` (pure sugar;
re-exported from `workflow.ts`). It returns a proxy whose methods forward to
`runActivity(name, options, ...args)`; the generic parameter provides
compile-time typing. Its per-activity `ActivityOptions` (timeout, retry, task
queue) are **declared in `protocol/`, emitted by `core` on the command, and
interpreted only by the server** when it turns the command into a task. The core
does nothing with them — options are just more history-in/commands-out payload.

## The caveat that keeps the abstraction honest

`LocalService` and `RemoteService` are **not** behaviorally identical: local is
effectively exactly-once and synchronous-ish; remote is at-least-once with
redelivery, retries, and latency. The seam unifies the *code path*, not the
*failure semantics*. Keep `LocalService` for the fast inner loop, but run a subset
of integration tests against a real server (`integration/remote.spec.ts`) to
exercise duplicate execution and non-idempotent effects. Pretending the two are
the same is how you ship an activity that double-charges a card.

# Distribution

How the same code scales from one process to three resilient tiers — and the
failure-semantics caveat that comes with it. Prerequisite:
[structure & layers](structure-and-layers.md).

The distribution core is built (see [`PROJECT.md` §1](../../PROJECT.md)): a real
spawned server process with worker-crash redelivery, at-least-once activities, and
lease-race version rejection all pass under the suite.

## Going distributed: three tiers

The move isn't inventing new components — it's promoting existing function-call
boundaries to process boundaries. **`core/` doesn't move; it runs inside the
workflow worker.**

- **Server** — the only stateful tier, and it runs **no user code**. Owns
  histories, queues, timers, and the transactional logic that advances them.
  Client-facing API (start/signal/getResult) and worker-facing API (poll/respond
  for both task types, heartbeat). Its heart is the workflow-task handling in
  `server_core.ts` (`buildWorkflowTask` / `applyWorkflowTaskResult`): on receiving
  a command batch it *atomically* appends events, creates downstream tasks, and
  closes the task — conditional on a version check. (This handling lives in
  `server_core.ts`; it is **not** a separate `workflow_task_handler.ts` file.)
- **Workflow workers** — stateless. Poll a workflow task → build context from the
  returned history → replay (core) → respond with commands. A **sticky cache** of
  warm executions is a planned optimization (not yet built); today every task is a
  cold replay from fetched history. Workflow *types* register here.
- **Activity workers** — stateless. Poll an activity task → run the registered
  activity function → report result/failure, heartbeating long ones. This is the
  **only place I/O happens**. Activity *implementations* register here.

## What makes it resilient

- **Leasing + redelivery.** Every polled task carries a lease (token + timeout).
  A crashed worker's lease expires and the server redelivers to another. This is
  what makes worker crashes survivable — the distributed form of the per-execution
  concurrency guard described in
  [task execution & concurrency](task-execution-and-concurrency.md).
- **Optimistic concurrency.** Two workers can end up holding a task for the same
  execution (lease race). Both replay; both respond; the append is conditional on
  the execution's version; the loser is rejected. Discarding the loser is safe
  **because replay commits no external effects** — the
  [determinism boundary](../concepts/determinism-boundary.md) paying off directly.
- **At-least-once + idempotency.** Lease redelivery means activities may run more
  than once. The workflow side dedups naturally (a duplicate completion for a
  known seq is discarded on replay). Activity **side effects** are the author's
  responsibility to make idempotent (idempotency keys). The framework guarantees
  at-least-once; exactly-once effects are on you.
- **Retries & heartbeats.** Activity failures retry with backoff per policy. Retry
  is **worker-side today**; the design intends to move it to a server decision
  (re-enqueue with backoff) when heartbeats land (see [`PROJECT.md` §6](../../PROJECT.md)).
- **Durable timers.** Persisted with a recorded fire-time, swept by a
  crash-tolerant loop; cross-process sweep leader-election is still TODO.

## `proxyActivities` and where options are interpreted

`proxyActivities` is a typed façade over `runActivity`, living in
`core/workflow_api.ts` (pure sugar; re-exported from `workflow.ts`). Its
per-activity `ActivityOptions` (timeout, retry, task queue) are **declared in
`protocol/`, emitted by `core` on the command, and interpreted only by the
server** when it turns the command into a task. The core does nothing with them —
options are just more history-in/commands-out payload.

## The caveat that keeps the abstraction honest

`LocalService` and `RemoteService` are **not** behaviorally identical: local is
effectively exactly-once and synchronous-ish; remote is at-least-once with
redelivery, retries, and latency. The seam unifies the *code path*, not the
*failure semantics*. Keep `LocalService` for the fast inner loop, but run a subset
of integration tests against a real server
(`spec/integration/remote.spec.ts`, `spec/integration/distributed.spec.ts`) to
exercise duplicate execution and non-idempotent effects. Pretending the two are
the same is how you ship an activity that double-charges a card.

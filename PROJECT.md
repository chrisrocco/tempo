# PROJECT — status, map, and handoff

The living "you are here" for this codebase. `README.md` is the design record and
the target structure; the concept docs (`00`–`07`) explain the _ideas_; **this file
tracks what is actually built, how the code is laid out today, where the code has
diverged from the docs, and what to do next.** Read this first on a fresh session.

Last updated: end of **Phase 5, Slice 4** (distribution core complete).

---

## 1. Status at a glance

- **51 specs green** under Jasmine + `tsx` (`npm test`), `tsc --noEmit` clean.
- **Phases 1–4 complete. Phase 5 (distribution) core complete** — its exit
  criterion passes (a real spawned server process, worker-crash redelivery /
  at-least-once, and lease-race version rejection).
- **What works today:** activities (`proxyActivities` + retry), real wall-clock
  timers, signals, `condition`, blocking **and** fire-and-forget children,
  `continueAsNew`, cancellation (cascading). All of it runs three ways:
  1. **in-memory** (`createLocalRuntime()`) — the fast default,
  2. **durable single-binary** (`createLocalRuntime({ historyStore: FileHistoryStore.open(dir) })`) with crash-recovery `resume()`,
  3. **distributed** (server + workflow + activity worker processes over HTTP RPC), via the `bin/` mains.

### Commands

```bash
npm test          # jasmine + tsx, all 51 specs
npm run typecheck # tsc --noEmit
```

Distributed (manual): `node --import tsx bin/server-main.ts` (prints `LISTENING <port>`),
then the two worker mains with `SERVER_URL` + `WORKER_MODULE` env (see `bin/*-main.ts`).

---

## 2. The mental model (what to keep in your head)

1. **The determinism boundary.** `core/` turns `(history) -> (commands)` and
   touches nothing else — no I/O, clock, or randomness. Everything
   non-deterministic lives on the other side (`server`, `worker`, `services`).
   This is _the_ organizing principle (`01`). Not yet enforced by a lint rule.
2. **Event-sourced replay.** A workflow is re-run from its history on every task
   ("cold replay"). Commands it emits are matched against recorded events by a
   deterministic `seq`. History is an append-only log.
3. **Dispatch-and-park (Phase 4).** _No operation holds an orchestration frame
   while it runs._ Every dispatched op (activity, timer, child) writes a **marker
   event** and parks the workflow; its completion arrives later as its own event
   and wakes the workflow via a fresh task. Markers do double duty: they stop a
   re-emitted command from re-dispatching _and_ they are the crash-recovery
   "scheduled before running" record.
4. **Poll/respond (Phase 5).** Workers **poll** the server for tasks, do the work,
   and respond. Same worker code in-proc (`LocalService`) or over RPC
   (`RemoteService`). `pump`'s old per-execution mutex + wake-coalescing now lives
   in the **workflow-task queue**; leasing makes worker crashes survivable.

---

## 3. Architecture map (the real tree, annotated)

Dependencies point down: `protocol <- core <- {server, services, worker, client} <- {local_runtime, bin}`.

```
src/
  protocol/            PURE DATA. the wire format. no logic, no deps.
    commands.ts          Command union (+ detached child, cancelChild, continueAsNew)
    activity_options.ts  ActivityOptions + RetryPolicy
    history_events.ts    HistoryEvent union — completions + markers + signal + cancelRequested
    task_token.ts        TaskToken (lease identity)
    service.ts           WorkflowService seam (client + worker-facing) + task contracts
    rpc.ts               RPC request/response envelopes (HTTP transport)
  core/                DETERMINISTIC ENGINE. history -> commands.
    context.ts workflow_api.ts signals.ts condition.ts
    apply_event.ts microtask_scheduler.ts replay.ts errors.ts (CancelledFailure)
  server/              ORCHESTRATION BRAIN. runs NO user code.
    ports/               history_store · task_queue · workflow_task_queue · timer_service
    memory/              in-memory adapters for all four ports
    file/                file_history_store.ts — durable append-only log + lockfile
    server_core.ts       the brain: buildWorkflowTask / applyWorkflowTaskResult,
                         the poll/complete seam, version check, resume, correlation maps
    lease.ts             LeaseTable (lease/ack/reclaimExpired)
    retry_policy.ts      shouldRetry / backoffMs / maxAttempts
  services/            the WorkflowService implementations + transport
    local_service.ts     in-proc: server_core + memory ports + in-proc worker drain loops
    server_host.ts       headless server (server_core, no workers) for distributed mode
    rpc_server.ts        HTTP+JSON server exposing a ServerHost
    remote_service.ts    HTTP client implementing WorkflowService
  worker/              STATELESS workers
    workflow_worker.ts   replayTask (runs core)   activity_worker.ts   runTask (only I/O)
    activity_registry.ts worker_loops.ts (runWorkflowWorker / runActivityWorker poll loops)
  client/client.ts     WorkflowService -> ergonomic handles (result/status/signal/cancel)
  local_runtime.ts     createLocalRuntime() — wires LocalService + in-proc workers + client
  workflow.ts          ★ AUTHOR ENTRYPOINT — deterministic primitives only
  index.ts             ★ HOST ENTRYPOINT — createLocalRuntime, FileHistoryStore, types
bin/                   server-main · workflow-worker-main · activity-worker-main
examples/              bug_hotlist_monitor.ts — the motivating spawn-and-cancel workflow
```

### The control-flow model (how a workflow advances now)

1. A **wake** (start / signal / timer fire / activity report / child terminal /
   cancel) enqueues a **workflow task** for the execution.
2. A **workflow worker** polls it, gets `{name, args, history}`, replays (core),
   and responds with a `WorkflowTaskResult` (`done`/`failed`/`commands`).
3. The server **applies** the result: settle (terminal), restart (continueAsNew),
   or dispatch each command (activity → activity-task queue; timer → schedule;
   child → launch). Dispatched work parks; its completion is a future wake.
4. `pump`'s guarantees are the **workflow-task queue**'s: one task in flight per
   execution + a wake mid-task coalesces into one more (`memory_workflow_task_queue.ts`).

---

## 4. Concept docs vs. the implementation (READ THIS before trusting a doc)

The `00`–`07` docs were written at **Phase 0** and describe the _target_ and the
_ideas_. The ideas are all intact; some mechanisms have moved. Where they differ,
**the code is the truth** and this table is the guide.

| Doc                                      | Still accurate?   | Divergence to know                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00` overview, `01` determinism boundary | ✅ Fully          | The boundary holds; lint enforcement still TODO.                                                                                                                                                                                                                                                                                                                                                                        |
| `02` replay & execution                  | ✅ Core intact    | `replay`/`settle`/`applyEvent`/ALS unchanged. `applyEvent` now also no-ops marker events (`activityScheduled`/`timerStarted`/`childStarted`) and handles `cancelRequested`.                                                                                                                                                                                                                                             |
| `03` condition/signals/timers            | ⚠️ Timers changed | Timers are now **real wall-clock** and durable: a `timerStarted{fireAt}` event is recorded, a real `setTimeout` fires, `resume()` re-arms from history. `condition`/signals as described.                                                                                                                                                                                                                               |
| `04` drive & pump                        | ❌ Superseded     | The in-proc `drive` loop + `pump` are **gone**. Model is now **poll/respond**: `server_core.buildWorkflowTask`/`applyWorkflowTaskResult`; `pump`'s mutex+coalescing lives in `memory_workflow_task_queue.ts`; `LocalService` runs the in-proc drain loops. Read this doc for the _why_ (the two bugs pump prevents), then map to the queue.                                                                             |
| `05` continue-as-new                     | ✅ As designed    | Terminal primitive in `core`, `ContinueAsNewCommand`, server disposition in `applyWorkflowTaskResult` (reset + re-drive). `continueAsNewSuggested` from history length.                                                                                                                                                                                                                                                 |
| `06` architecture & distribution         | ⚠️ Mostly built   | The tier split exists. **Not split out:** `workflow_task_handler.ts`/`activity_task_handler.ts` are folded into `server_core.ts`. **Added, not in the doc's tree:** `server/file/`, `services/{server_host,rpc_server,remote_service}.ts`, `worker/worker_loops.ts`, `server/lease.ts`, `server/ports/workflow_task_queue.ts`. **Not built:** `worker/sticky_cache.ts`. Retry is worker-side today, not server-decided. |
| `07` type model                          | ⚠️ Grown          | `protocol/` gained `activity_options`, `task_token`, `service`, `rpc`. `Command` gained `continueAsNew` + `cancelChild`; `StartChildCommand` gained `detached`. `HistoryEvent` gained the marker events + `cancelRequested`. Modeling style (per-variant interfaces, `Omit` spec) as described.                                                                                                                         |

`ROADMAP.md` phase plan is accurate; Phases 1–4 done, Phase 5 done through Slice 4.

---

## 5. Test map (the specs are the executable documentation)

| Spec                                        | Covers                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spec/integration/local.spec.ts` (28)       | The whole programming model against `createLocalRuntime` — activities, `proxyActivities`+retries, dispatch-and-park (async + FIFO), signals/`condition`, blocking + concurrent children, timers (duration ordering), `continueAsNew`, cancellation (+ cascade). **Start here to understand behavior.** |
| `spec/examples/bug_hotlist_monitor.spec.ts` | The motivating spawn-and-cancel workflow end to end.                                                                                                                                                                                                                                                   |
| `spec/server/retry_policy.spec.ts`          | Retry arithmetic (attempts, exponential backoff cap).                                                                                                                                                                                                                                                  |
| `spec/server/timer_service.spec.ts`         | Durable timer fire / cancel / startup re-arm.                                                                                                                                                                                                                                                          |
| `spec/server/file_history_store.spec.ts`    | Durable persistence: behavior parity, reload-in-fresh-store round-trip, single-writer lockfile.                                                                                                                                                                                                        |
| `spec/server/concurrency.spec.ts`           | Optimistic version CAS, lease-expiry redelivery (both queues), lease-race resolved by the version check (headless `server_core`).                                                                                                                                                                      |
| `spec/integration/resume.spec.ts`           | Crash recovery: restart mid-flight on a timer / activity / blocking child and finish from history.                                                                                                                                                                                                     |
| `spec/integration/remote.spec.ts`           | Client → `RemoteService` → HTTP → server → workers, in one process over loopback.                                                                                                                                                                                                                      |
| `spec/integration/distributed.spec.ts`      | **Real** spawned server + worker processes; worker-crash redelivery / at-least-once.                                                                                                                                                                                                                   |

---

## 6. What's next & what's deferred

### Phase 5, Slice 5 — refinements (the remaining slice)

- **Activity heartbeats + start-to-close timeouts** (deferred since Phase 3; the
  activity worker does one attempt per delivery today, lease redelivers on crash).
- **Sticky cache** in the workflow worker (`worker/sticky_cache.ts`) — warm
  suspended executions to skip cold replay.
- **Durable timer-sweep failover** — timers reconstruct from history on resume,
  but there is no cross-process sweep leader-election.

### Standalone TODOs (not blocking, good first tasks)

- **Import-path lint rule** — finish Phase 1's enforcement of the determinism
  boundary (`core` may import only `protocol`; workflow code only `workflow.ts`).
- **Counter-collision on resume** — `LocalService`/`ServerHost` id counters start
  at 0 after a restart, so a new generated id could collide with a resumed one.
  Fine with explicit `workflowId`s; seed the counter past resumed ids to harden.
- **Server-decided retry** — retry is worker-side; doc 06 wants it as a server
  decision (re-enqueue with backoff). Move it when heartbeats land.

### Known simplifications (intentional, documented)

- The optimistic version check is a read-compare guard in `completeWorkflowTask`
  (seam path only); `appendIfVersion` is the store primitive a fully transactional
  backend would use for the whole batch. The in-proc happy path does **not**
  version-check (it relies on markers + queue coalescing).
- `RemoteService` client-facing sync methods are best-effort (fire-and-forget
  writes with a client-generated id, cached `getStatus`); `getResult` (polls
  `getOutcome`) is the authoritative await.
- Retry backoff, RPC, filesystem durability are all in-memory/single-node grade;
  Phase 6 (production hardening) is untouched.

---

## 7. Gotchas / invariants a new contributor must respect

- **Every dispatched op must leave a marker** (`activityScheduled` /
  `timerStarted` / `childStarted`). Without it, a re-emitted command re-dispatches
  on replay (the concurrent case) and resume can't reconstruct it. See
  `server_core.applyCommand` + `core/apply_event`.
- **In-proc drain loops must poll their queues _synchronously_** (no `await` in the
  loop condition), or a wake landing at the loop boundary is lost. See the sync
  `for (let leased = queue.poll(); ...)` in `local_service.ts`.
- **Worker-process poll loops must `sleep` ref'd** (`worker_loops.ts`) — an
  `unref`'d idle sleep lets a spawned worker exit its own event loop. (This was a
  real bug; see the Slice-4 fix.)
- **`getStatus` is a sync in-proc mirror** (`statusMirror`), not a store read —
  the store is async. Keep it updated when an execution settles.
- **Cancellation, signals, timers are recorded events** (deterministic replay),
  not side effects. Never make a decision from `Date.now()` inside `core`.
- **Children:** blocking children park the parent and resume it via a
  `childCompleted` event correlated by seq; fire-and-forget children carry _no_
  completion event (that's why they need no result waiter).

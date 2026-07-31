# Workflow Engine — Design Record

This is the design record for a minimal-but-correct durable workflow engine (a
small Temporal-shaped system) written in TypeScript. It began as a question about
authoring a Temporal workflow and grew into a working, event-sourced replay
engine with a documented path to a distributed deployment.

## Current status

A working, event-sourced durable workflow engine that runs three ways — in-memory,
durable single-binary (filesystem + crash-recovery), and distributed (server +
workers over RPC). Programming model: activities (`proxyActivities` + retries),
real timers, signals, `condition`, blocking **and** fire-and-forget children,
`continueAsNew`, cancellation. `tsc --noEmit` clean; full suite green via `npm test`.

> **Live status, the real code map, the test map, and what's next all live in
> [`PROJECT.md`](PROJECT.md)** — the single source of truth for "what's built."
> This README is the stable design front-door: the origin, the one idea, and the
> destination structure.

## Where the documentation lives

**Architectural and design documentation lives in the code**, in the
`@fileoverview` comment of the module each idea belongs to. There is no separate
`docs/` tree to drift out of sync with the implementation.

**On a fresh session, read [`PROJECT.md`](PROJECT.md) first** — the living "you
are here": current status, the real code map, the test map, and what's next. Then
[`CLAUDE.md`](CLAUDE.md) for the conventions to work by.

Read the code in this order the first time; each builds on the last:

| Read                                                                                                                                                              | What it covers                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`src/workflow.ts`](src/workflow.ts)                                                                                                                              | **The determinism boundary** — the organizing principle, and the rules workflow code obeys |
| [`src/core/replay.ts`](src/core/replay.ts)                                                                                                                        | Activation vs. replay, the live edge, `settle`, observe-don't-await                        |
| [`src/core/context.ts`](src/core/context.ts)                                                                                                                      | The per-task state, and the AsyncLocalStorage propagation caveat                           |
| [`src/core/condition.ts`](src/core/condition.ts) · [`signals.ts`](src/core/signals.ts) · [`src/server/ports/timer_service.ts`](src/server/ports/timer_service.ts) | The three ways a workflow waits, and the queue pattern                                     |
| [`src/core/workflow_api.ts`](src/core/workflow_api.ts)                                                                                                            | The primitives, `proxyActivities`, and `continueAsNew`'s layer split                       |
| [`src/protocol/`](src/protocol/)                                                                                                                                  | The wire format both sides of the boundary speak                                           |
| [`src/index.ts`](src/index.ts)                                                                                                                                    | The host entrypoint, the layering, and the dependency direction                            |
| [`src/services/local_service.ts`](src/services/local_service.ts)                                                                                                  | Local vs. distributed, and the failure-semantics caveat                                    |
| [`src/server/ports/workflow_task_queue.ts`](src/server/ports/workflow_task_queue.ts)                                                                              | The two concurrency bugs the design prevents                                               |
| [`src/services/server_host.ts`](src/services/server_host.ts) · [`bin/server-main.ts`](bin/server-main.ts)                                                         | The three tiers, and the operational caveats                                               |

**Behavior is documented by the specs**, which are executable and run in CI.
[`spec/integration/local.spec.ts`](spec/integration/local.spec.ts) is the
canonical one — the whole author-facing programming model. Start there to
understand what the engine does; [`PROJECT.md`](PROJECT.md) §5 maps the rest.

[`ROADMAP.md`](ROADMAP.md) has the phased implementation plan and exit criteria.

## Design blueprint (the intended shape)

This is the **original design target** — the blueprint, **not an inventory of what
exists today**. Some pieces shown aren't built yet (the `workflow_task_handler` /
`activity_task_handler` split, `worker/sticky_cache.ts`); some were superseded
(`services/pump.ts` — its mutex + coalescing moved into the workflow-task queue);
some built files aren't shown; and the `spec/` tree here is illustrative, not the
real one. **For the actual current tree see [`PROJECT.md`](PROJECT.md) §3.** The
shape still earns its place: the layering _is_ the determinism boundary, and the
dependency arrows only ever point down
(`protocol <- core <- {server, services, worker, client} <- {entrypoints, bin}`).

```
workflow-engine/
├── package.json
├── tsconfig.json
├── README.md
│
├── src/
│   │
│   ├── protocol/                    # ── PURE DATA + CONTRACTS. no logic, no deps. the wire format.
│   │   ├── commands.ts              #    Command union (CommandBase + per-variant interfaces, CommandSpec)
│   │   ├── activity_options.ts      #    ActivityOptions, RetryPolicy — shared vocab; rides on scheduleActivity
│   │   ├── history_events.ts        #    HistoryEvent = CompletionEvent (seq) | SignalEvent (no seq)
│   │   ├── task_token.ts            #    lease identity handed to workers
│   │   ├── service.ts               #    WorkflowService interface — the seam Local & Remote both implement
│   │   ├── rpc.ts                   #    request/response types for the networked transport
│   │   └── index.ts
│   │
│   ├── core/                        # ══ DETERMINISTIC ENGINE. (history) -> (commands). no I/O, clock, or random.
│   │   ├── context.ts               #    WorkflowContext, createContext, als, getContext  [ALS explainer]
│   │   ├── workflow_api.ts          #    runActivity, proxyActivities, sleep, executeChild, continueAsNew
│   │   ├── signals.ts               #    defineSignal, setHandler + pre-registration buffering
│   │   ├── condition.ts             #    condition() + tryUnblockConditions()  [unblock-pass explainer]
│   │   ├── apply_event.ts           #    route recorded events into parked promises; nondeterminism check
│   │   ├── microtask_scheduler.ts   #    drainMicrotasks — the host-coupled yield  [caveat lives here]
│   │   ├── replay.ts                #    settle() + replay() — live-edge detection, observe-don't-await
│   │   └── index.ts
│   │
│   ├── server/                      # ── ORCHESTRATION BRAIN. stateful, runs NO user code. shared by local+remote.
│   │   ├── ports/                   #    ports-and-adapters interfaces
│   │   │   ├── history_store.ts     #      load/append with optimistic version
│   │   │   ├── task_queue.ts        #      enqueue / poll / lease / ack / expire-and-requeue
│   │   │   └── timer_service.ts     #      durable schedule + crash-tolerant sweep (recorded fire-time)
│   │   ├── memory/                  #    in-memory adapters (power LocalService + the fast test path)
│   │   │   ├── memory_history_store.ts
│   │   │   ├── memory_task_queue.ts
│   │   │   └── memory_timer_service.ts
│   │   ├── workflow_task_handler.ts #    transactional apply: commands -> events + downstream tasks (version-checked)
│   │   ├── activity_task_handler.ts #    apply activity result/failure -> event + retry decision
│   │   ├── retry_policy.ts          #    backoff / retry-vs-surface (reads ActivityOptions)
│   │   ├── lease.ts                 #    lease timeout + redelivery loop  [pump Job-1, distributed form]
│   │   ├── server_core.ts           #    composes handlers + ports into the WorkflowService methods
│   │   └── index.ts
│   │
│   ├── services/                    # ── the two WorkflowService implementations workers talk to
│   │   ├── pump.ts                  #    concurrency guard — SCOPED to LocalService  [@fileoverview]
│   │   ├── local_service.ts         #    server_core + memory adapters + pump, all in-process
│   │   ├── remote_service.ts        #    RPC client over rpc.ts -> a networked server_core
│   │   └── index.ts
│   │
│   ├── worker/                      # ── STATELESS workers. written once, against WorkflowService.
│   │   ├── workflow_worker.ts       #    poll -> replay(core) -> respond
│   │   ├── sticky_cache.ts          #    warm suspended executions; cold-replay fallback on miss
│   │   ├── activity_worker.ts       #    poll -> run activity fn -> report, with heartbeat  [only I/O in the system]
│   │   ├── activity_registry.ts     #    activity implementations register HERE and nowhere else
│   │   └── index.ts
│   │
│   ├── client/
│   │   ├── client.ts                #    Start / Signal / GetResult -> handles, over any WorkflowService
│   │   └── index.ts
│   │
│   ├── local_runtime.ts             #    createLocalRuntime(): LocalService + in-proc workers + client, one call
│   ├── tempo.ts                     # ★ WORKER ENTRYPOINT — Tempo.startWorker(): RemoteService + poll loops
│   ├── workflow.ts                  # ★ AUTHOR ENTRYPOINT — exports ONLY deterministic primitives
│   └── index.ts                     # ★ HOST ENTRYPOINT — createLocalRuntime, Tempo, client, public types
│
├── bin/                             # ── deployable process mains (distributed mode)
│   ├── server-main.ts               #    boots server_core with DURABLE adapters + RPC transport
│   └── tempo.ts                     #    the `tempo` CLI entry (logic in src/cli/)
│                                    #    (workers are built from user code — see examples/greeter.ts)
│
├── examples/
│   ├── minimal_replay.ts            #    the old standalone replay.ts, demoted to a teaching artifact
│   └── greeter.ts                   #    the deployable worker: activity + workflow + entrypoint
│
└── spec/                            # ── mirrors src/ layout
    ├── support/jasmine.json
    ├── core/
    │   ├── context.spec.ts
    │   ├── condition.spec.ts
    │   ├── apply_event.spec.ts
    │   └── replay.spec.ts
    ├── services/
    │   ├── pump.spec.ts             #    fake drive() that flips rerun once -> asserts exactly two drives
    │   └── local_service.spec.ts
    ├── server/
    │   ├── workflow_task_handler.spec.ts   # version-check rejects the losing append
    │   ├── retry_policy.spec.ts
    │   └── lease.spec.ts            #    expired lease redelivers the task
    ├── worker/
    │   └── sticky_cache.spec.ts
    ├── integration/
    │   ├── local.spec.ts            #    full flows vs LocalService (fast; the current 28 specs live here)
    │   └── remote.spec.ts           #    subset vs a real server process — at-least-once, retries, latency
    └── examples/
        └── minimal_replay.spec.ts
```

The `★` entrypoints and the top-of-file layer banners are the load-bearing part:
they're what a lint rule keys on to keep the determinism boundary enforced rather
than merely documented (see `src/workflow.ts`).

## The one idea to keep

Everything else follows from a single boundary: **the deterministic core turns a
history into a set of commands, and touches nothing else — no I/O, no clock, no
randomness. All non-determinism lives on the other side.** If a change respects
that line, it's probably in the right place. If it blurs it, stop.

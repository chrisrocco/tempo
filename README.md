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

> **Live status, the real code map, the doc-vs-implementation divergence table,
> the test map, and what's next all live in [`PROJECT.md`](PROJECT.md)** — the
> single source of truth for "what's built." This README is the stable design
> front-door: the ideas, the concept-doc index, and the destination structure.

## How to read these

**On a fresh session, read [`PROJECT.md`](PROJECT.md) first** — it is the living
"you are here": current status, the real code map, which of these concept docs have
drifted from the implementation (with a divergence table), the test map, and what's
next. The docs below explain the *ideas*; `PROJECT.md` tracks what is *built*.

Read in order the first time; they build on each other.

The full documentation set lives under [`docs/`](docs/README.md), organized into
**concepts** (why), **architecture** (how it's built), **behavior** (what's
guaranteed, linked to the specs), **guides** (how-to), and **contributing**. The
[docs index](docs/README.md) has the reading order and the four-bucket map. The
core concept docs, in reading order:

| Doc | What it covers | Status |
|-----|----------------|--------|
| [`PROJECT.md`](PROJECT.md) | **Handoff hub** — status, code map, doc-vs-code divergences, test map, TODO | current |
| [concepts/overview](docs/concepts/overview.md) | Origin, the mental model, glossary | ✅ |
| [concepts/determinism-boundary](docs/concepts/determinism-boundary.md) | **The** organizing principle — read this first if nothing else | ✅ |
| [concepts/replay-and-execution](docs/concepts/replay-and-execution.md) | Replay vs activation, warm/cold paths, the core loop, ALS | ✅ |
| [concepts/conditions-signals-timers](docs/concepts/conditions-signals-timers.md) | `condition` internals, signals, the queue pattern, timers | ⚠ timers now durable |
| [concepts/continue-as-new](docs/concepts/continue-as-new.md) | The suggested flag, the primitive, the layer split | ✅ |
| [concepts/type-model](docs/concepts/type-model.md) | The `protocol` types and the modeling decisions behind them | ⚠ grown; see `PROJECT.md §4` |
| [architecture/structure-and-layers](docs/architecture/structure-and-layers.md) | File structure, entrypoints, the service seam | ⚠ mostly built; see `PROJECT.md §4` |
| [architecture/distribution](docs/architecture/distribution.md) | Going distributed; the failure-semantics caveat | ⚠ mostly built; see `PROJECT.md §4` |
| [architecture/task-execution-and-concurrency](docs/architecture/task-execution-and-concurrency.md) | `drive`, `pump`'s two jobs, `executeCommand` | ❌ superseded by the poll/queue model — read for the *why* |
| [`ROADMAP.md`](ROADMAP.md) | Phased implementation plan with exit criteria | accurate; P1–4 + P5 core done |

## Design blueprint (the intended shape)

This is the **original design target**, annotated with which concept doc owns each
piece — the blueprint, **not an inventory of what exists today**. Some pieces shown
aren't built yet (the `workflow_task_handler` / `activity_task_handler` split,
`worker/sticky_cache.ts`); some were superseded (`services/pump.ts` — its mutex +
coalescing moved into the workflow-task queue); some built files aren't shown; and
the `spec/` tree here is illustrative, not the real one. **For the actual current
tree see [`PROJECT.md`](PROJECT.md) §3; for where the code diverged from this
blueprint, §4.** The shape still earns its place: the layering *is* the determinism
boundary, and the dependency arrows only ever point down
(`protocol <- core <- {server, services, worker, client} <- {entrypoints, bin}`).
Bracketed notes point at the concept doc that owns each piece.

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
│   │   ├── context.ts               #    WorkflowContext, createContext, als, getContext  [ALS explainer, doc 02]
│   │   ├── workflow_api.ts          #    runActivity, proxyActivities, sleep, executeChild, continueAsNew
│   │   ├── signals.ts               #    defineSignal, setHandler + pre-registration buffering  [doc 03]
│   │   ├── condition.ts             #    condition() + tryUnblockConditions()  [unblock-pass explainer, doc 03]
│   │   ├── apply_event.ts           #    route recorded events into parked promises; nondeterminism check
│   │   ├── microtask_scheduler.ts   #    drainMicrotasks — the host-coupled yield  [caveat lives here, doc 02]
│   │   ├── replay.ts                #    settle() + replay() — live-edge detection, observe-don't-await  [doc 02]
│   │   └── index.ts
│   │
│   ├── server/                      # ── ORCHESTRATION BRAIN. stateful, runs NO user code. shared by local+remote.
│   │   ├── ports/                   #    ports-and-adapters interfaces  [doc 06]
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
│   │   ├── lease.ts                 #    lease timeout + redelivery loop  [pump Job-1, distributed form, doc 04]
│   │   ├── server_core.ts           #    composes handlers + ports into the WorkflowService methods
│   │   └── index.ts
│   │
│   ├── services/                    # ── the two WorkflowService implementations workers talk to
│   │   ├── pump.ts                  #    concurrency guard — SCOPED to LocalService  [@fileoverview, doc 04]
│   │   ├── local_service.ts         #    server_core + memory adapters + pump, all in-process
│   │   ├── remote_service.ts        #    RPC client over rpc.ts -> a networked server_core
│   │   └── index.ts
│   │
│   ├── worker/                      # ── STATELESS workers. written once, against WorkflowService.  [doc 06]
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
│   ├── workflow.ts                  # ★ AUTHOR ENTRYPOINT — exports ONLY deterministic primitives  [doc 01]
│   └── index.ts                     # ★ HOST ENTRYPOINT — createLocalRuntime, workers, client, public types
│
├── bin/                             # ── deployable process mains (distributed mode)
│   ├── server-main.ts               #    boots server_core with DURABLE adapters + RPC transport
│   ├── workflow-worker-main.ts      #    workflow_worker against RemoteService
│   └── activity-worker-main.ts      #    activity_worker against RemoteService
│
├── examples/
│   ├── minimal_replay.ts            #    the old standalone replay.ts, demoted to a teaching artifact
│   └── bug_hotlist_monitor.ts       #    the original motivating workflow, end to end
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
than merely documented (`01`).

## The one idea to keep

Everything else follows from a single boundary: **the deterministic core turns a
history into a set of commands, and touches nothing else — no I/O, no clock, no
randomness. All non-determinism lives on the other side.** If a change respects
that line, it's probably in the right place. If it blurs it, stop.

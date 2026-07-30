# Workflow Engine — Design & Handoff Documentation

This is the design record for a minimal-but-correct durable workflow engine (a
small Temporal-shaped system) written in TypeScript. It began as a question about
authoring a Temporal workflow and grew into a working, event-sourced replay
engine with a documented path to a distributed deployment.

## Current status

- **Working in-memory runtime** behind the `WorkflowService` seam, with
  activities (`proxyActivities` + retry policy), real wall-clock timers, signals,
  `condition`, blocking **and** fire-and-forget child workflows, `continueAsNew`,
  and cancellation (`CancelledFailure`, cascading to children).
- **Layered.** The determinism boundary is physical and the full tier split is in
  place: `protocol/ <- core/ <- {server, services, worker, client} <-
  {local_runtime, entrypoints}`, plus the `workflow.ts` (author) and `index.ts`
  (host) entrypoints. Ports (`HistoryStore`/`TaskQueue`/`TimerService`) have
  in-memory adapters; `pump` is scoped inside `LocalService`.
- **Typed.** Full TypeScript, `tsc --noEmit` clean.
- **Tested.** 34 specs passing under Jasmine + `tsx` (`npm test`), including the
  end-to-end bug-hotlist monitor example.
- **Phases 1–3 of `ROADMAP.md` are complete.**
- **Not yet built:** the import-path lint rule, durable persistence (Phase 4 —
  the first target is a filesystem adapter, single-binary), distribution
  (Phase 5), and production hardening (Phase 6). See `ROADMAP.md`.

## How to read these

Read in order the first time; they build on each other.

| Doc | What it covers |
|-----|----------------|
| `00-overview.md` | Origin, what exists, the mental model, glossary |
| `01-determinism-boundary.md` | **The** organizing principle — read this first if nothing else |
| `02-replay-and-execution.md` | Replay vs activation, warm/cold paths, the core loop, ALS |
| `03-condition-signals-timers.md` | `condition` internals, signals, the queue pattern, timers |
| `04-runtime-pump-and-drive.md` | `drive`, `pump`'s two jobs, `executeCommand` |
| `05-continue-as-new.md` | The suggested flag, the primitive, the layer split |
| `06-architecture-and-distribution.md` | File structure, entrypoints, the service seam, going distributed |
| `07-type-model.md` | The `protocol` types and the modeling decisions behind them |
| `ROADMAP.md` | Phased implementation plan with exit criteria |

## Target project structure

This is the **destination** layout (roughly Phase 5 of `ROADMAP.md`). The tree
below the entrypoints now matches through Phase 3: `protocol/`, `core/`,
`server/` (ports + in-memory adapters + `server_core`), `services/` (`pump` +
`LocalService`), `worker/`, `client/`, and `local_runtime.ts`. Still ahead are the
durable adapters under `server/memory/`'s eventual siblings, `remote_service.ts`,
the `bin/` process mains, and some server files not yet split out
(`workflow_task_handler.ts` etc. are currently folded into `server_core.ts`). The
full shape is kept here because it encodes the whole design: the layering *is* the
determinism boundary, and the dependency arrows only ever point down
(`protocol <- core <- {server, services, worker, client} <- {entrypoints, bin}`).
Bracketed notes point at the concept doc or explainer that owns each piece.

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

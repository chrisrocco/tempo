# tempo

A minimal-but-correct **durable workflow engine** in TypeScript — a small,
Temporal-shaped system built to demonstrate the mechanism end to end.

A _workflow_ is an ordinary async function whose execution survives crashes. The
engine never trusts the function's in-memory state: it records an **event
history** and reconstructs any execution by **replaying** the function against
that history. Workflow code stays deterministic; everything that touches the
outside world happens in **activities** the engine runs on its behalf.

```ts
import { runActivity } from './src/workflow';

// Deterministic orchestration. Survives a crash at any await.
export async function greeter(name: string): Promise<string> {
  return runActivity<string>('greet', name);
}

// The only place real I/O is allowed.
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

This is a working reference implementation, not a published package. It is not
on npm and makes no stability promises — clone it, read it, run it.

## What it does

- **Activities** with typed `proxyActivities`, server-decided retry with backoff,
  start-to-close timeouts, and `heartbeat()` for work of unbounded duration
- **Timers** — real wall-clock, durable, re-armed from history on restart
- **Signals** and **`condition`** — event-driven waiting, no polling
- **Child workflows**, blocking or fire-and-forget, optionally keyed by a
  `workflowId` you choose — claim the same id twice and you get one child
- **Cancellation**, cascading to children, surfacing as a catchable failure —
  plus `terminate` for when cooperative cancellation cannot land
- **`continueAsNew`** to bound history on long-lived workflows
- **Crash recovery** — kill the server mid-workflow, restart, and it continues
- **Inspection** — `tempo list`, and `tempo describe` for what an execution is
  waiting on, derived from history rather than stored
- **Structured lifecycle log** — JSON Lines on stderr, one event per fact, so a
  run can be aggregated without parsing prose
- **Task queues** — route work to a pool of workers, so several applications can
  share one server; activities and children inherit their execution's queue

The same workflow code runs three ways, with no changes:

| Mode                  | How                                                                      | For                            |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| In-memory             | `createLocalRuntime()`                                                   | Tests, the fast inner loop     |
| Durable single-binary | `createLocalRuntime({ historyStore: await FileHistoryStore.open(dir) })` | One process, survives restarts |
| Distributed           | Server + workflow/activity worker processes over HTTP RPC                | Horizontal scale               |

## Requirements

Node 18+ (uses global `fetch`). TypeScript runs directly via `tsx` — there is no
build step.

```bash
npm install
```

## Quickstart

Run a workflow in a single process:

```ts
import { createLocalRuntime } from './src';
import { runActivity } from './src/workflow';

const rt = createLocalRuntime()
  .registerActivity('greet', (name: string) => `Hello, ${name}!`)
  .registerWorkflow('greeter', (name: string) =>
    runActivity<string>('greet', name),
  );

console.log(await rt.start<string>('greeter', ['world']).result());
rt.shutdown(); // stop background timers so the process exits
```

Or run the whole topology — server plus a worker — in the foreground. Without
`--port` the server takes any free port; pinning it to the default lets the
client find it with no configuration:

```bash
npm run tempo -- up examples/greeter.ts --port=7233
```

Then drive workflows through it from another terminal:

```bash
npm run tempo -- start greeter world --wait
```

Going distributed does not change the workflow code, only how it is hosted. See
[`bin/server-main.ts`](bin/server-main.ts) for the server process and
[`src/tempo.ts`](src/tempo.ts) for the worker entrypoint and its environment
contract.

## How it works

1. Workflow code runs and, wherever it would do something durable, emits a
   **command** and suspends.
2. The server executes commands against the outside world and records the results
   as **history events**.
3. To advance, the engine **replays** the workflow function against accumulated
   history: recorded events resolve the promises it is waiting on, fast-forwarding
   it to where it left off, at which point it emits the next command.
4. When history grows large, the workflow **continues as new** — a fresh run
   carrying forward only the state it needs.

Everything else is an elaboration of that loop. The single organizing idea:

> The **deterministic core** turns a _history_ into a set of _commands_ and does
> nothing else — no I/O, no clock, no randomness. Everything non-deterministic
> lives on the other side of the line, in the runtime.

If a change respects that line it is probably in the right place. If it blurs it,
stop.

### Following a signal, end to end

Design documentation lives in each module, so the one thing no single module can
tell you is the path _between_ them. Here is a signal's, which exercises most of
the engine:

1. **Client** calls `signal(workflowId, name, payload)` —
   [`client/client.ts`](src/client/client.ts). Against `RemoteService` this is an
   HTTP POST; against `LocalService` it is a direct call. Same seam either way.
2. **Server** appends a `signal` history event, then _wakes_ the execution —
   [`server_core.appendSignal`](src/server/server_core.ts). Waking is nothing more
   than enqueuing a workflow task.
3. **The workflow-task queue** absorbs the wake —
   [`ports/workflow_task_queue.ts`](src/server/ports/workflow_task_queue.ts). At
   most one task per execution is in flight; a wake landing mid-task coalesces
   into exactly one more. This is where the two concurrency bugs are prevented.
4. **A workflow worker polls** and gets `{name, args, history}` plus a lease —
   [`worker/worker_loops.ts`](src/worker/worker_loops.ts). It holds no state
   between tasks, so any worker can serve any execution.
5. **Replay** builds a fresh context and re-runs the workflow function against the
   whole history — [`core/replay.ts`](src/core/replay.ts). Commands are suppressed
   while catching up; once the last event is consumed the context goes live.
6. **`applyEvent`** routes the signal to its registered handler, or buffers it if
   the handler is not set up yet — [`core/apply_event.ts`](src/core/apply_event.ts).
7. **`settle`** drains microtasks and runs the condition unblock pass to a
   fixpoint. A workflow parked on `condition(() => queue.length > 0)` wakes here,
   _after_ the handler pushed to the queue — that ordering is why the queue
   pattern never misses an item.
8. **The workflow runs on** past the live edge and emits new commands; the worker
   responds with them.
9. **The server applies the result** —
   [`applyWorkflowTaskResult`](src/server/server_core.ts) — behind a version check
   that discards a lease-race loser. Each command is dispatched: a marker event is
   recorded and the work is queued. Dispatched work parks the workflow.
10. **Completion is another wake.** An activity worker runs the activity, reports
    back, the server appends the completion — and the loop returns to step 3.

Cold replay from step 5 happens on _every_ task today; a sticky cache that keeps
warm executions on the worker is planned but not built.

### Terms

| Term              | Meaning                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| **Command**       | A request emitted by workflow code during a task, carrying a deterministic `seq`            |
| **History event** | The durable record of something that happened; history is the source of truth               |
| **seq**           | Sequence number assigned to each command in call order — how a completion finds its promise |
| **Activation**    | One batch of new events applied to advance a workflow (a "workflow task")                   |
| **Replay**        | Re-running the workflow from the top against recorded history to rebuild lost state         |
| **Live edge**     | The boundary between catching up and producing new commands                                 |
| **Marker event**  | A record that work was _dispatched_; resolves nothing, but stops re-dispatch on replay      |
| **Wake**          | Enqueuing a workflow task for an execution                                                  |
| **Execution**     | One running instance of a workflow (a `workflowId`, plus a `runId` per run)                 |

## Project layout

Dependencies point strictly down:
`protocol <- core <- {server, services, worker, client} <- {local_runtime, entrypoints, bin}`.

```
src/
  protocol/       Pure data + contracts. The wire format. No logic, no deps.
  core/           The deterministic engine: (history) -> (commands).
  server/         Orchestration brain. Stateful, runs NO user code.
    ports/          history_store · task_queue · workflow_task_queue · timer_service
    memory/         in-memory adapters for all four ports
    file/           durable append-only history log + single-writer lockfile
  services/       The WorkflowService implementations + HTTP transport
  worker/         Stateless workflow + activity workers
  client/         WorkflowService -> ergonomic handles
  cli/            the `tempo` CLI
  workflow.ts     ★ AUTHOR ENTRYPOINT — deterministic primitives only
  activity.ts     ★ ACTIVITY ENTRYPOINT — heartbeat()
  index.ts        ★ HOST ENTRYPOINT — createLocalRuntime, types
  tempo.ts        ★ WORKER ENTRYPOINT — Tempo.startWorker()
bin/              server-main (the server process) · tempo (the CLI)
examples/         greeter.ts — the reference deployable worker
spec/             the executable documentation
```

The `★` entrypoints are load-bearing: workflow code imports only from
`workflow.ts`, which is what makes the determinism boundary a structural fact
rather than a convention. [`tools/boundaries.ts`](tools/boundaries.ts) enforces
it mechanically — layering, core purity, and the author entrypoint — via
`npm run lint` and the suite. `activity.ts` is the other side of that line and is
deliberately _not_ enforced: activities are where I/O belongs, so there is
nothing to forbid — it exists to say where `heartbeat()` makes sense, and where
it does not.

## Documentation

**Design documentation lives in the code**, in the `@fileoverview` comment of the
module that owns each idea. There is no `docs/` tree to drift out of sync.
[`AGENTS.md`](AGENTS.md) explains that convention and how to structure code so it
keeps working.

Read in this order the first time; each builds on the last:

| Read                                                                                   | What it covers                                              |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`src/workflow.ts`](src/workflow.ts)                                                   | The determinism boundary, and the rules workflow code obeys |
| [`src/core/replay.ts`](src/core/replay.ts)                                             | Activation vs. replay, the live edge, observe-don't-await   |
| [`src/core/context.ts`](src/core/context.ts)                                           | Per-task state, and the AsyncLocalStorage caveat            |
| [`src/core/condition.ts`](src/core/condition.ts) · [`signals.ts`](src/core/signals.ts) | How a workflow waits, and the queue pattern                 |
| [`src/core/workflow_api.ts`](src/core/workflow_api.ts)                                 | The primitives, `proxyActivities`, `continueAsNew`          |
| [`src/protocol/`](src/protocol/)                                                       | The wire format both sides of the boundary speak            |
| [`src/server/server_core.ts`](src/server/server_core.ts)                               | Dispatch-and-park, and the transactional heart              |
| [`src/server/ports/workflow_task_queue.ts`](src/server/ports/workflow_task_queue.ts)   | The two concurrency bugs the design prevents                |
| [`src/services/local_service.ts`](src/services/local_service.ts)                       | Local vs. distributed, and the failure-semantics caveat     |
| [`bin/server-main.ts`](bin/server-main.ts)                                             | The three tiers, and the operational caveats                |

## Testing

**Behavior is documented by the specs** — they are executable and run in CI.
[`spec/integration/local.spec.ts`](spec/integration/local.spec.ts) is the
canonical one: the whole author-facing programming model. Start there to
understand what the engine does.

| Spec                                                                  | Covers                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`integration/local`](spec/integration/local.spec.ts)                 | The whole programming model against `createLocalRuntime`              |
| [`core/replay`](spec/core/replay.spec.ts)                             | The live edge, command suppression, terminal outcomes                 |
| [`core/apply_event`](spec/core/apply_event.spec.ts)                   | Event routing, markers, buffering, the nondeterminism check           |
| [`core/condition`](spec/core/condition.spec.ts)                       | Parking, the unblock fixpoint, the condSeq invariant                  |
| [`core/workflow_api`](spec/core/workflow_api.spec.ts)                 | seq allocation and command payloads                                   |
| [`architecture`](spec/architecture.spec.ts)                           | The determinism boundary, enforced — and proven to catch breakage     |
| [`integration/resume`](spec/integration/resume.spec.ts)               | Crash recovery: restart mid-flight and finish from history            |
| [`integration/remote`](spec/integration/remote.spec.ts)               | Client → RemoteService → HTTP → server → workers, one process         |
| [`integration/distributed`](spec/integration/distributed.spec.ts)     | Real spawned processes; crash redelivery / at-least-once              |
| [`integration/cli`](spec/integration/cli.spec.ts)                     | The `tempo` CLI end to end as a subprocess                            |
| [`server/concurrency`](spec/server/concurrency.spec.ts)               | Version CAS, lease expiry, lease-race rejection, late-ack dedup       |
| [`server/pending_work`](spec/server/pending_work.spec.ts)             | What an execution still awaits — shared by recovery and `describe`    |
| [`server/task_failure`](spec/server/task_failure.spec.ts)             | Poison tasks: counted, backed off, never settled, fixed by redeploy   |
| [`server/activity_timeout`](spec/server/activity_timeout.spec.ts)     | Start-to-close bounds an attempt without duplicating the work         |
| [`server/logging`](spec/server/logging.spec.ts)                       | Lifecycle events, their fields, and silence by default                |
| [`server/activity_retry`](spec/server/activity_retry.spec.ts)         | Server-decided retry: one budget, durable across restarts             |
| [`server/id_collision`](spec/server/id_collision.spec.ts)             | Ids stay unique across restarts, and children derive theirs           |
| [`server/heartbeat`](spec/server/heartbeat.spec.ts)                   | A long attempt holds its claim; a silent one is caught fast           |
| [`worker/activity_context`](spec/worker/activity_context.spec.ts)     | `heartbeat()` as an author meets it: ambient, throttled, inert        |
| [`server/task_queue_routing`](spec/server/task_queue_routing.spec.ts) | Work reaches the right pool; activities and children inherit theirs   |
| [`server/child_recovery`](spec/server/child_recovery.spec.ts)         | Children launch once across replay/restart; cancel still reaches them |
| [`server/file_history_store`](spec/server/file_history_store.spec.ts) | Durable persistence + single-writer lockfile                          |
| [`server/timer_service`](spec/server/timer_service.spec.ts)           | Durable timer fire / cancel / startup re-arm                          |
| [`server/retry_policy`](spec/server/retry_policy.spec.ts)             | Retry arithmetic (attempts, backoff cap)                              |
| [`worker/worker_loops`](spec/worker/worker_loops.spec.ts)             | Poll-failure reporting and backoff                                    |

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run lint
```

## Status

Working and green: the suite, `tsc --noEmit`, and the boundary checker all pass.
The full programming model runs in all three modes above.

Not built: server HA, workflow versioning, metrics and alerting on top of the
lifecycle log, the workflow-worker sticky cache, cross-process timer-sweep
failover, and the deployment half of the CLI. The RPC has no auth or TLS and
binds loopback. [`ROADMAP.md`](ROADMAP.md) ranks these by
how likely each is to bite a real deployment ("Adoption blockers") and tracks
what's planned; [`planning/`](planning/) holds in-flight design work.

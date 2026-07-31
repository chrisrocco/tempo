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

- **Activities** with typed `proxyActivities`, retry policies, and backoff
- **Timers** — real wall-clock, durable, re-armed from history on restart
- **Signals** and **`condition`** — event-driven waiting, no polling
- **Child workflows**, both blocking and fire-and-forget
- **Cancellation**, cascading to children, surfacing as a catchable failure
- **`continueAsNew`** to bound history on long-lived workflows
- **Crash recovery** — kill the server mid-workflow, restart, and it continues

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
  index.ts        ★ HOST ENTRYPOINT — createLocalRuntime, types
  tempo.ts        ★ WORKER ENTRYPOINT — Tempo.startWorker()
bin/              server-main (the server process) · tempo (the CLI)
examples/         greeter.ts — the reference deployable worker
spec/             the executable documentation
```

The three `★` entrypoints are load-bearing: workflow code imports only from
`workflow.ts`, which is what makes the determinism boundary a structural fact
rather than a convention.

## Documentation

**Design documentation lives in the code**, in the `@fileoverview` comment of the
module that owns each idea. There is no `docs/` tree to drift out of sync.
[`CLAUDE.md`](CLAUDE.md) explains that convention and how to structure code so it
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

| Spec                                                                  | Covers                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------- |
| [`integration/local`](spec/integration/local.spec.ts)                 | The whole programming model against `createLocalRuntime`      |
| [`integration/resume`](spec/integration/resume.spec.ts)               | Crash recovery: restart mid-flight and finish from history    |
| [`integration/remote`](spec/integration/remote.spec.ts)               | Client → RemoteService → HTTP → server → workers, one process |
| [`integration/distributed`](spec/integration/distributed.spec.ts)     | Real spawned processes; crash redelivery / at-least-once      |
| [`integration/cli`](spec/integration/cli.spec.ts)                     | The `tempo` CLI end to end as a subprocess                    |
| [`server/concurrency`](spec/server/concurrency.spec.ts)               | Optimistic version CAS, lease expiry, lease-race rejection    |
| [`server/file_history_store`](spec/server/file_history_store.spec.ts) | Durable persistence + single-writer lockfile                  |
| [`server/timer_service`](spec/server/timer_service.spec.ts)           | Durable timer fire / cancel / startup re-arm                  |
| [`server/retry_policy`](spec/server/retry_policy.spec.ts)             | Retry arithmetic (attempts, backoff cap)                      |
| [`worker/worker_loops`](spec/worker/worker_loops.spec.ts)             | Poll-failure reporting and backoff                            |

```bash
npm test
```

```bash
npm run typecheck
```

## Status

Working and green: 64 specs, `tsc --noEmit` clean. The full programming model
runs in all three modes above.

Not built: server HA, activity heartbeats and start-to-close timeouts, the
workflow-worker sticky cache, cross-process timer-sweep failover, and the
deployment half of the CLI. The RPC has no auth or TLS and binds loopback. See
[`ROADMAP.md`](ROADMAP.md) for what's planned and
[`planning/`](planning/) for in-flight design work.

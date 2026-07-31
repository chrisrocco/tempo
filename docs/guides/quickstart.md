# Quickstart — define, deploy, run

Write a workflow once, then run it **two ways** with the _same_ workflow code:
in a single process (fast, one call) or distributed across a server plus worker
processes that talk only over HTTP RPC (the production shape).

The one rule to remember: **workflow code is deterministic orchestration; all I/O
lives in activities.** See [the determinism boundary](../concepts/determinism-boundary.md).

Snippets below assume a `quickstart/` folder at the repo root, so imports use
`../src`. Run any file with `node --import tsx quickstart/<file>.ts`.

## 1. Define a workflow and an activity

```ts
// quickstart/definitions.ts
import { runActivity } from '../src/workflow';
import type { WorkflowRegistry, ActivityRegistry } from '../src/worker';

// A workflow: pure orchestration. It asks for I/O by calling an activity by name.
export async function greeter(name: string): Promise<string> {
  return runActivity<string>('greet', name);
}

// An activity: the only place real I/O is allowed (here, just building a string).
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

// Register them by name so a worker can find them.
export function registerWorkflows(r: WorkflowRegistry): void {
  r.set('greeter', greeter);
}
export function registerActivities(r: ActivityRegistry): void {
  r.set('greet', greet);
}
```

## 2. Run it locally (one process)

`createLocalRuntime()` wires the server, workers, and a client in-process — ideal
for development and single-node use.

```ts
// quickstart/run-local.ts
import { createLocalRuntime } from '../src';
import { greeter, greet } from './definitions';

const rt = createLocalRuntime()
  .registerActivity('greet', greet)
  .registerWorkflow('greeter', greeter);

const result = await rt.start<string>('greeter', ['world']).result();
console.log(result); // Hello, world!
rt.shutdown(); // stop background timers so the process exits
```

```bash
node --import tsx quickstart/run-local.ts
```

That is the whole programming model. Going distributed does not change the
workflow code — only how it is hosted.

## 3. Deploy it distributed (server + workers)

For durability across crashes and horizontal scale, split into three process
types that communicate **only over HTTP RPC**.

The workers below are the same **one binary**, started twice with a different
`TEMPO_ROLE` — your own entrypoint, built from your code. See
[`examples/greeter/`](../../examples/greeter/) for its three files, and
[Build and Deploy](build-and-deploy.md) for the full journey.

```text
          start / getResult (HTTP)
  client ─────────────────────────────▶ ┌──────────────────────────────┐
                                         │  server  (bin/server-main)   │
  workflow worker ─ poll / respond ────▶ │  HTTP RPC on :7233           │
  activity worker ─ poll / respond ────▶ │  stateful: history, queues,  │
                                         │  timers — runs NO user code  │
                                         └──────────────────────────────┘
```

Everyone talks to the server; the server is the only stateful tier. Start the
three processes (each in its own terminal):

```bash
# 1) the server — owns all state; prints the port it bound
PORT=7233 node --import tsx bin/server-main.ts
# → LISTENING 7233

# 2) a workflow worker — replays workflow code
TEMPO_SERVER_URL=http://127.0.0.1:7233 \
TEMPO_ROLE=workflow \
node --import tsx examples/greeter/worker.ts
# → WORKER_READY greeter workflow

# 3) an activity worker — runs activities (the only I/O)
TEMPO_SERVER_URL=http://127.0.0.1:7233 \
TEMPO_ROLE=activity \
node --import tsx examples/greeter/worker.ts
# → WORKER_READY greeter activity
```

> On Windows PowerShell, set each env var on its own line first — e.g.
> `$env:SERVER_URL = "http://127.0.0.1:7233"` — then run the `node ...` command.

Now start a workflow from a client — a separate process, or your own app:

```ts
// quickstart/client.ts
import { createRemoteService } from '../src/services';

const service = createRemoteService('http://127.0.0.1:7233');
const { workflowId } = service.start('greeter', ['world']);
console.log(await service.getResult(workflowId)); // Hello, world!
```

```bash
node --import tsx quickstart/client.ts
```

### What happened over the wire

1. **Client → server:** `start` POSTs the request; the server creates the
   execution and enqueues a workflow task. `getResult` polls `getOutcome` until
   the run is terminal.
2. **Workflow worker ⇄ server:** the worker polls a workflow task, replays the
   workflow function (the deterministic core), and responds with the _commands_ it
   produced — e.g. "run activity `greet`". It keeps no state; everything it needs
   arrives in the task's history.
3. **Activity worker ⇄ server:** the server turns that command into an activity
   task; the activity worker polls it, runs `greet` (real I/O happens here only),
   and reports the result. That wakes the workflow, which is replayed again to
   completion.

Every message is a plain HTTP POST of JSON between `RemoteService` and
`bin/server-main`. Because only the server holds state and replay commits no
external effects, a crashed worker is harmless — its leased task simply
redelivers to another worker.

### Why it's split this way

- **The server is the only stateful tier** and runs no user code — it owns
  history, queues, and timers.
- **Workers are stateless and scale horizontally** — run many workflow or activity
  workers against one server; each just polls, works, and responds. Lease
  redelivery makes crashes survivable.
- Local vs distributed is a choice of `WorkflowService` implementation
  (`LocalService` vs `RemoteService`) behind one seam — not a rewrite. See
  [structure & layers](../architecture/structure-and-layers.md) and
  [distribution](../architecture/distribution.md).

> **Caveat:** `LocalService` is effectively exactly-once; the distributed path is
> at-least-once, so an activity can run more than once. Make activity side effects
> idempotent — see [distribution](../architecture/distribution.md).

## Next

- [Getting Started](getting-started.md) — a richer example (signals, children,
  cancellation) walked through end to end.
- [Concepts](../concepts/) for the _why_, [Behavior](../behavior/README.md) for
  the guarantees, each linked to the spec that proves it.

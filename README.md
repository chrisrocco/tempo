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
export async function greeter({ name }: { name: string }): Promise<string> {
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

- **Activities** with typed `proxyActivities`, which registers what it types, plus
  server-decided retry with
  backoff, start-to-close timeouts, and `heartbeat()` for work of unbounded
  duration
- **Timers** — real wall-clock, durable, re-armed from history on restart;
  `sleep('30 minutes')` or milliseconds, and the same duration strings anywhere
  an option wants a time span
- **Signals** and **`condition`** — event-driven waiting, no polling; a
  workflow can `signalWorkflow` another one, so a child poller can feed items
  to a waiting parent without leaving the engine
- **Child workflows**, blocking or fire-and-forget, optionally keyed by a
  `workflowId` you choose — claim the same id twice and you get one child, and
  a per-child **parent-close policy** decides whether it is terminated, asked
  to unwind, or left running when its parent finishes
- **`createWorkflow`** — define a workflow under its wire name and get a typed
  reference back: invoking it runs it as a blocking child (`.execute` adds the
  `workflowId`/policy knobs), `.detached()` spawns it fire-and-forget, and
  defining it registers it — so a worker names only its
  root workflows and everything they invoke rides along on the import graph,
  the same way `proxyActivities` registers activities
- **Cancellation**, cascading to children, surfacing as a catchable failure —
  plus `terminate` for when cooperative cancellation cannot land
- **`continueAsNew`** to bound history on long-lived workflows
- **Versioning** — `patched('some-change')` lets a workflow's body gain a branch
  while executions of it are running: the choice is recorded in each execution's
  history, so one that has already run the old path keeps it and one that has not
  reached the call site takes the new one. `deprecatePatch` retires the branch
  afterwards
- **Crash recovery** — kill the server mid-workflow, restart, and it continues
- **Retention**, opt-in — `--retain-closed-for-days=N` deletes executions that
  have been closed longer than the window, so a long-lived server's history
  does not grow forever; results and `workflowId` claims last only as long as
  the record, which is the trade the flag's docs spell out
- **Inspection** — an execution's status, history, and what it is currently
  waiting on, derived from history rather than stored and reachable through
  [`src/client/`](src/client/client.ts)
- **Structured lifecycle log** — JSON Lines on stderr, one event per fact, so
  a run can be aggregated without parsing prose
- **Task queues** — route work to a pool of workers, so several applications
  can share one server; activities and children inherit their execution's
  queue

The same workflow code runs four ways, with no changes:

| Mode                    | How                                                                    | For                            |
| ----------------------- | ---------------------------------------------------------------------- | ------------------------------ |
| In-memory               | `createLocalRuntime()`                                                 | Tests, the fast inner loop     |
| One workflow, no server | `worker.js --local=NAME`                                               | Trying a change; build checks  |
| Durable single-binary   | `createLocalRuntime({historyStore: await FileHistoryStore.open(dir)})` | One process, survives restarts |
| Distributed             | Server + workflow/activity worker processes over HTTP RPC              | Horizontal scale               |

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
  .registerWorkflow('greeter', ({ name }: { name: string }) =>
    runActivity<string>('greet', name),
  );

console.log(await rt.start<string>('greeter', { name: 'world' }).result());
rt.shutdown(); // stop background timers so the process exits
```

Or run one workflow through your worker binary, with no server at all:

```bash
tsx spec/support/greeter_worker.ts --local=greeter --args='["world"]'
# LOCAL RUN greeter greeter — one workflow, then exit. Not a deployment: …
# "Hello, world!"
```

`--local=NAME` runs that workflow to completion in-process, prints its result as
JSON, and exits — 0 on success, 1 if the workflow failed or the artifact does not
register it. That last part is the other reason it exists: it is the cheapest way
to prove a _built_ worker actually registered its workflows, which otherwise
surfaces only as executions parking on a queue whose workers reject every task.

**Never put `--local` in a supervisor's command line.** The process runs one
workflow and exits, so a supervisor that restarts it will run that workflow
again, forever, with real activities doing real I/O. It announces itself on
stderr on every run for exactly this reason.

Or run the real thing — a server and the two worker tiers, each its own process:

```bash
tsx bin/server-main.ts --port=7777 --data-dir=./data &          # LISTENING 7777 127.0.0.1
tsx spec/support/greeter_worker.ts --server=http://127.0.0.1:7777 --role=workflow &
tsx spec/support/greeter_worker.ts --server=http://127.0.0.1:7777 --role=activity &
```

Each prints one readiness line — `LISTENING <port> <host>` and `WORKER_READY
<name> <roles> <queue>` — and then drive them from a script, through
[`src/client/`](src/client/client.ts), the same seam an application uses:

```ts
import { createRemoteClient, createRemoteService } from './src';

const client = createRemoteClient(createRemoteService('http://127.0.0.1:7777'));

await client.health(); // is it up, is it durable, and where is it bound
await client.queues(); // who is polling, per queue and role

const handle = client.start<string>('greeter', 'world');
console.log(await handle.result()); // Hello, world!
```

`start`, `describe`, `signal`, `cancel`, `terminate`, `reset`, `list`, `queues`,
`counts`, `workflows`, and `health` are all there — the whole client-facing
surface, so nothing needs a raw service.

Configuration is flags with defaults, never the environment — see
[`src/process_flags.ts`](src/process_flags.ts) for why.

## Running it yourself

**This library does not deploy itself, and it has no operator tooling.** There is
no CLI, no `tempo up`, no deployment module, and no dashboard. Building the
artifacts, installing them, supervising them, and looking at what they are doing
are yours — and that is a decision rather than a gap, because the build system,
the machine, the supervisor, and the browser are yours too. Anything written here
about them would be a guess made in a repo that cannot test it, corrected in a
repo that cannot fix it. (The reasoning in full: issue #64.)

What that leaves is a contract rather than a shrug: everything such a tool needs
is on the published surface. `workflow-engine/protocol` is the wire format —
`RpcRequest`, `RpcResponse`, every projection type a listing or a describe
returns, and the two predicates (`isStuck`, `isQueueServed`) whose answers must
not be guessed at twice. A UI reading them is reading the same definitions the
server writes, so a field added to a projection is a compile error in the tool
rather than `undefined` at runtime. A gap there is a bug here.

`workflow-engine/client` is how such a tool reaches a server: `createRemoteService`
plus `createRemoteClient`, and nothing else. It exists because those two used to
be reachable only through the host entrypoint, which meant a dashboard pulled
`node:fs` and `node:http` into a browser build to get a function that calls
`fetch`. Both paths are now **checked** to reach no Node builtin and no workflow
module, transitively — a barrel that would quietly undo it fails `npm run lint`
rather than a consumer's bundler.

One deployment note the engine cannot handle for you: **failure stacks are
formatted in the process that threw** and travel as strings, so a bundled worker
binary owns the legibility of its own frames. Emit _inline_ source maps (a
binary moved to a stable location silently breaks a relative
`sourceMappingURL`), run workers with `node --enable-source-maps`, and keep
identifier names through the bundle (`--keep-names`, no identifier minification)
— otherwise the stack the engine faithfully carries from an activity to your
terminal names positions in a bundle nobody can open. Each process fixes its
own half: activity frames in the activity worker, the awaited-at frames in the
workflow worker.

Reading the surface is one thing; **developing** against it is another.
`workflow-engine/testing` starts a real server, on a real port, already holding
the states such a tool has to render:

```ts
import { startScenario } from 'workflow-engine/testing';

const server = await startScenario(['stuck', 'parked', 'unserved-queue']);
// point your UI at server.url, build it, then:
await server.stop();
```

Getting a server into those states is otherwise the hardest part of building
anything that reads one, and every tool that does it from guesswork drifts from
what the engine actually produces — separately, and invisibly. The catalogue is
closed on purpose: a state it cannot produce is a state no tool should claim to
render. `src/testing/scenarios.ts` lists them, and the suite runs every one.

What this library gives a deployment is **two entrypoints, one per artifact** —
each a file whose whole body is one call:

```ts
// server.ts — bundle this, run it once
import { startServer } from 'workflow-engine';
void startServer({ dataDir: '/var/lib/tempo' });

// workflows/order.workflow.ts — declaring the activities registers them
import * as Tempo from 'workflow-engine/workflow';
import * as payments from '../activities/payments';
const act = Tempo.proxyActivities(payments, { retry: { maximumAttempts: 3 } });

export const order = Tempo.createWorkflow('order', async (id: string) => {
  await act.charge(id);
});

// worker.ts — bundle this, run it twice, once per --role
import { startWorker } from 'workflow-engine';
import * as workflows from './workflows';
startWorker({ name: 'orders', workflows });
```

plus the client above, and the **flag vocabulary** both processes read
(`SERVER_FLAG`, `WORKER_FLAG`, `formatFlag`, `DEFAULT_PORT`), so whatever writes
their command lines shares one spelling with the code that parses it rather than
hardcoding strings:

```ts
import { SERVER_FLAG, formatFlag } from 'workflow-engine';
formatFlag(SERVER_FLAG.dataDir, '/var/lib/tempo'); // --data-dir=/var/lib/tempo
```

The worker is checkable before it is deployed: `node worker.js --local=NAME` runs
one workflow through the built artifact and exits non-zero if it is not
registered, which is worth a CI step — a worker that registered nothing installs
happily and reports nothing until executions park on a queue it never serves.

The rest is ordinary process supervision, and the shape is always the same: one
server, one workflow worker (`--role=workflow`), one activity worker
(`--role=activity`), the workers pointed at the server with `--server`. Split by
role so an activity blocking the event loop cannot stall workflow replay into a
lease expiry. Restart the server first; the workers back off and retry, and
report it while they do.

Three things are worth knowing before you write that supervisor config:

- **A server with no `--data-dir` is not durable.** It serves correctly and loses
  every execution on its next restart. `health().durable` is the field that says
  so — check it after a deploy, because nothing else will.
- **A redeploy is a restart.** Nothing rereads a `.js` in place.
- **Readiness is `health()` and `queues()`, not the stdout lines.** Those two
  answer from anywhere, at any time, about a process you did not spawn — which is
  what a supervisor or a deploy check actually needs. `health()` also says where
  the server bound — the interface, the resolved port after `--port=0`, and the
  machine's hostname — which is how you find out that a server nothing can reach
  is on loopback. `serverUrl(health)` turns that into an address to dial, on the
  client side, because the server cannot see a proxy in front of itself and will
  not claim to. The readiness lines are left for a human watching a terminal, and
  for learning the port when you cannot yet connect at all.

Going distributed does not change the workflow code, only how it is hosted. See
[`src/server_main.ts`](src/server_main.ts) for the server entrypoint and its
operational caveats, and [`src/tempo.ts`](src/tempo.ts) for the worker entrypoint
and its input contract.

### Put your own server in front of a dashboard

The RPC has **no auth and no TLS** — `bin/server-main` binds loopback for that
reason, and anything that can reach the port can terminate any execution. For
workers on a trusted network that is a deferred problem. For a UI it is not,
because a UI has users, sessions, and a browser between them and the port.

So the supported shape puts a server of your own in the middle:

```
browser ──▶ your dashboard's server ──▶ tempo RPC
             (auth, sessions, RBAC)     (loopback / trusted network)
```

Your server holds the session and decides who may call `terminate`; tempo's port
stays where it already is. The browser gets `workflow-engine/protocol` for the
types and the shared predicates, which is dependency-free and safe to bundle.

Two things follow from this, and both look like gaps until you see the shape:

- **There is no CORS on the RPC, deliberately.** Adding it would invite exactly
  the topology above to be skipped, putting an unauthenticated `terminate` one
  fetch away from any page a user has open.
- **The engine will not grow a login.** Authorization is about your users and your
  roles, neither of which this library knows anything about. It is the same
  argument as the rest of this section.

### What is contract, and what is not

The top of this file says the package makes no stability promises, and that stays
true: there is no npm release, no semver, and no deprecation window. What can be
said is narrower and more useful — which surfaces are load-bearing, and what a
change to one of them counts as.

| Surface                                                    | A change to it                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| The paths in the `exports` map                             | A break. Something outside resolves them by name.                    |
| Types and predicates from `workflow-engine/protocol`       | A break, and a wire-format one — treat it like a schema migration.   |
| Log event names and their fields                           | A break once anything aggregates them. See `server/ports/logger.ts`. |
| `LISTENING` / `WORKER_READY` lines, and the flag spellings | A break. A supervisor parses one and emits the other.                |
| Anything reached by a deep import into `src/`              | Not a break. That is the reason the `exports` map is a short list.   |

"A break" here means it is treated as a bug in this repo rather than as a
consumer's problem to absorb — the same standing the missing-projection rule
above has. It does not mean it will not happen.

## How it works

1.  Workflow code runs and, wherever it would do something durable, emits a
    **command** and suspends.
2.  The server executes commands against the outside world and records the
    results as **history events**.
3.  To advance, the engine **replays** the workflow function against accumulated
    history: recorded events resolve the promises it is waiting on,
    fast-forwarding it to where it left off, at which point it emits the next
    command.
4.  When history grows large, the workflow **continues as new** — a fresh run
    carrying forward only the state it needs.

Everything else is an elaboration of that loop. The single organizing idea:

> The **deterministic core** turns a _history_ into a set of _commands_ and does
> nothing else — no I/O, no clock, no randomness. Everything non-deterministic
> lives on the other side of the line, in the runtime.

If a change respects that line it is probably in the right place. If it blurs
it, stop.

### Following a signal, end to end

Design documentation lives in each module, so the one thing no single module can
tell you is the path _between_ them. Here is a signal's, which exercises most of
the engine:

1.  **Client** calls `signal(workflowId, name, payload)` —
    [`client/client.ts`](src/client/client.ts). Against `RemoteService` this is
    an HTTP POST; against `LocalService` it is a direct call. Same seam either
    way.
2.  **Server** appends a `signal` history event, then _wakes_ the execution —
    [`server_core.appendSignal`](src/server/server_core.ts). Waking is nothing
    more than enqueuing a workflow task.
3.  **The workflow-task queue** absorbs the wake —
    [`ports/workflow_task_queue.ts`](src/server/ports/workflow_task_queue.ts).
    At most one task per execution is in flight; a wake landing mid-task
    coalesces into exactly one more. This is where the two concurrency bugs are
    prevented.
4.  **A workflow worker polls** and gets `{name, args, history}` plus a lease —
    [`worker/worker_loops.ts`](src/worker/worker_loops.ts). It holds no state
    between tasks, so any worker can serve any execution.
5.  **Replay** builds a fresh context and re-runs the workflow function against
    the whole history — [`core/replay.ts`](src/core/replay.ts). A command whose
    `seq` history already holds an event for is suppressed, because it is already
    durable; anything history has no seq for is new work. Position in the batch
    does not decide this — see the fileoverview for the wedge that assumption
    caused.
6.  **`applyEvent`** routes the signal to its registered handler, or buffers it
    if the handler is not set up yet —
    [`core/apply_event.ts`](src/core/apply_event.ts).
7.  **`settle`** drains microtasks and runs the condition unblock pass to a
    fixpoint. A workflow parked on `condition(() => queue.length > 0)` wakes
    here, _after_ the handler pushed to the queue — that ordering is why the
    queue pattern never misses an item.
8.  **The workflow runs on** and emits the commands history holds no event for;
    the worker responds with them.
9.  **The server applies the result** —
    [`applyWorkflowTaskResult`](src/server/server_core.ts) — behind a version
    check that discards a lease-race loser. Each command is dispatched: a marker
    event is recorded and the work is queued. Dispatched work parks the
    workflow.
10. **Completion is another wake.** An activity worker runs the activity,
    reports back, the server appends the completion — and the loop returns to
    step 3.

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

Dependencies point strictly down: `protocol <- core <- {patterns, server,
services, worker, client} <- {local_runtime, entrypoints, bin}`.

```
src/
  protocol/       Pure data + contracts. The wire format. No logic, no deps.
  core/           The deterministic engine: (history) -> (commands).
  patterns/       Authoring helpers built from core's primitives — pollForever,
                  diffing, signal streams. Depends on core; core never on it.
  walltime/       An internally-owned library, held at arm's length: duration
                  strings and wall-clock rules. Imports nothing, knows nothing
                  about the engine; its removal surface is a checked list.
  schedule/       Schedules: the scheduler workflow, its client, and the
                  when-does-this-fire arithmetic (client and worker halves are
                  separate entrypoints on purpose — see schedule/index.ts).
  server/         Orchestration brain. Stateful, runs NO user code.
    ports/          history_store · task_queue · workflow_task_queue · timer_service
    memory/         in-memory adapters for all four ports
    file/           durable append-only history log + single-writer lockfile
  services/       The WorkflowService implementations + HTTP transport
  worker/         Stateless workflow + activity workers
  client/         WorkflowService -> handles and server-wide reads
  workflow.ts     ★ AUTHOR ENTRYPOINT — deterministic primitives only
  activity.ts     ★ ACTIVITY ENTRYPOINT — heartbeat()
  index.ts        ★ HOST ENTRYPOINT — startServer, createLocalRuntime, types
  tempo.ts        ★ WORKER ENTRYPOINT — startWorker()
  server_main.ts  ★ SERVER ENTRYPOINT — startServer()
  remote_client.ts ★ CLIENT ENTRYPOINT — reaching a server from outside it,
                  from a browser included. Published as `workflow-engine/client`.
  testing/        ★ TESTING ENTRYPOINT — startScenario(), a real server already
                  in the states a UI has to render
  process_flags.ts  how a deployed process reads its own configuration
bin/              server-main.ts — the reference server binary, one call
spec/             the executable documentation; spec/support/greeter_worker.ts
                  is the reference worker binary the process-level specs deploy
```

The `★` entrypoints are load-bearing: workflow code imports only from
`workflow.ts`, which is what makes the determinism boundary a structural fact
rather than a convention. [`tools/boundaries.ts`](tools/boundaries.ts) enforces
it mechanically — layering, core purity, the author entrypoint, and browser
safety — via `npm run lint` and the suite. `activity.ts` is the other side of that line and is
deliberately _not_ enforced: activities are where I/O belongs, so there is
nothing to forbid — it exists to say where `heartbeat()` makes sense, and where
it does not.

## Documentation

**Design documentation lives in the code**, in the `@fileoverview` comment of
the module that owns each idea. There is no `docs/` tree to drift out of sync.
[`AGENTS.md`](AGENTS.md) explains that convention and how to structure code so
it keeps working.

[`GLOSSARY.md`](GLOSSARY.md) fixes one term per concept. Worth skimming before
the reading order below, because a few of the distinctions it draws —
**execution** against **run**, **marker** against **informational event** — are
ones the code relies on and prose tends to collapse.

Read in this order the first time; each builds on the last:

| Read                                                                                   | What it covers                                                        |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`src/workflow.ts`](src/workflow.ts)                                                   | The determinism boundary, and the rules workflow code obeys           |
| [`src/core/replay.ts`](src/core/replay.ts)                                             | Activation vs. replay, what suppresses a command, observe-don't-await |
| [`src/core/context.ts`](src/core/context.ts)                                           | Per-task state, and the AsyncLocalStorage caveat                      |
| [`src/core/condition.ts`](src/core/condition.ts) · [`signals.ts`](src/core/signals.ts) | How a workflow waits, and the queue pattern                           |
| [`src/core/workflow_api.ts`](src/core/workflow_api.ts)                                 | The primitives, `proxyActivities`, `continueAsNew`, `patched`         |
| [`src/protocol/`](src/protocol/)                                                       | The wire format both sides of the boundary speak                      |
| [`src/server/server_core.ts`](src/server/server_core.ts)                               | Dispatch-and-park, and the transactional heart                        |
| [`src/server/ports/workflow_task_queue.ts`](src/server/ports/workflow_task_queue.ts)   | The two concurrency bugs the design prevents                          |
| [`src/services/local_service.ts`](src/services/local_service.ts)                       | Local vs. distributed, and the failure-semantics caveat               |
| [`src/server_main.ts`](src/server_main.ts)                                             | The three tiers, and the operational caveats                          |

## Testing

**Behavior is documented by the specs** — they are executable and run in CI.
[`spec/integration/local.spec.ts`](spec/integration/local.spec.ts) is the
canonical one: the whole author-facing programming model. Start there to
understand what the engine does.

| Spec                                                                              | Covers                                                                                   |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`integration/local`](spec/integration/local.spec.ts)                             | The whole programming model against `createLocalRuntime`                                 |
| [`core/replay`](spec/core/replay.spec.ts)                                         | Command suppression, divergence detection, terminal outcomes                             |
| [`core/apply_event`](spec/core/apply_event.spec.ts)                               | Event routing, markers, buffering, the nondeterminism check                              |
| [`core/condition`](spec/core/condition.spec.ts)                                   | Parking, the unblock fixpoint, the condSeq invariant                                     |
| [`core/workflow_api`](spec/core/workflow_api.spec.ts)                             | seq allocation and command payloads                                                      |
| [`core/patched`](spec/core/patched.spec.ts)                                       | Versioning, at the layer where it can go wrong: seq allocation                           |
| [`integration/workflow_versioning`](spec/integration/workflow_versioning.spec.ts) | A running workflow's body changing under it, and the loud failure when it is unversioned |
| [`architecture`](spec/architecture.spec.ts)                                       | The determinism boundary, enforced — and proven to catch breakage                        |
| [`integration/resume`](spec/integration/resume.spec.ts)                           | Crash recovery: restart mid-flight and finish from history                               |
| [`integration/remote`](spec/integration/remote.spec.ts)                           | Client → RemoteService → HTTP → server → workers, one process                            |
| [`integration/distributed`](spec/integration/distributed.spec.ts)                 | Real spawned processes; crash redelivery / at-least-once                                 |
| [`integration/server_entrypoint`](spec/integration/server_entrypoint.spec.ts)     | `startServer`: bind, persist, refuse, override                                           |
| [`integration/local_run`](spec/integration/local_run.spec.ts)                     | `--local`: one workflow, no server, and what it refuses                                  |
| [`integration/worker_entrypoint`](spec/integration/worker_entrypoint.spec.ts)     | `startWorker`: what it registers, connects to, refuses                                   |
| [`server/concurrency`](spec/server/concurrency.spec.ts)                           | Version CAS, lease expiry, lease-race rejection, late-ack dedup                          |
| [`server/pending_work`](spec/server/pending_work.spec.ts)                         | What an execution still awaits — shared by recovery and `describe`                       |
| [`server/task_failure`](spec/server/task_failure.spec.ts)                         | Poison tasks: counted, backed off, never settled, fixed by redeploy                      |
| [`server/activity_timeout`](spec/server/activity_timeout.spec.ts)                 | Start-to-close bounds an attempt without duplicating the work                            |
| [`server/logging`](spec/server/logging.spec.ts)                                   | Lifecycle events, their fields, and silence by default                                   |
| [`server/activity_retry`](spec/server/activity_retry.spec.ts)                     | Server-decided retry: one budget, durable across restarts                                |
| [`server/id_collision`](spec/server/id_collision.spec.ts)                         | Ids stay unique across restarts, and children derive theirs                              |
| [`server/heartbeat`](spec/server/heartbeat.spec.ts)                               | A long attempt holds its claim; a silent one is caught fast                              |
| [`worker/activity_context`](spec/worker/activity_context.spec.ts)                 | `heartbeat()` as an author meets it: ambient, throttled, inert                           |
| [`server/task_queue_routing`](spec/server/task_queue_routing.spec.ts)             | Work reaches the right pool; activities and children inherit theirs                      |
| [`server/child_recovery`](spec/server/child_recovery.spec.ts)                     | Children launch once across replay/restart; cancel still reaches them                    |
| [`server/file_history_store`](spec/server/file_history_store.spec.ts)             | Durable persistence + single-writer lockfile                                             |
| [`server/timer_service`](spec/server/timer_service.spec.ts)                       | Durable timer fire / cancel / startup re-arm                                             |
| [`server/retry_policy`](spec/server/retry_policy.spec.ts)                         | Retry arithmetic (attempts, backoff cap)                                                 |
| [`worker/worker_loops`](spec/worker/worker_loops.spec.ts)                         | Poll-failure reporting and backoff                                                       |

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
lifecycle log, the workflow-worker sticky cache, and cross-process timer-sweep
failover. Deployment is deliberately not here at all — see "Running it yourself".
The RPC has no auth or TLS and binds loopback. [`ROADMAP.md`](ROADMAP.md) ranks these by how likely each is to
bite a real deployment ("Adoption blockers") and tracks what's planned;
in-flight design work lives in
[GitHub issues](https://github.com/chrisrocco/tempo/issues).

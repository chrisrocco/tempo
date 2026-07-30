# Structure & Layers

How the code is organized, the seams that make it extensible, and the two rules
that keep the layering honest. This doc explains the _principles_; for the exact,
annotated file tree as it stands today, see [`PROJECT.md` §3](../../PROJECT.md) —
that is the single source of truth for the live layout, kept current as the code
moves so this doc doesn't have to re-rot a duplicated file list.

## The layers

The system is a stack of layers, each with one responsibility, that depend
strictly downward:

- **`protocol/`** — pure data and contracts: the command union, history events,
  activity options, the `WorkflowService` seam, RPC envelopes. No logic, no
  dependencies. This is the wire format ([type model](../concepts/type-model.md)).
- **`core/`** — the deterministic engine: `(history) -> (commands)` and nothing
  else. No I/O, clock, or randomness. Imports only `protocol/`
  ([determinism boundary](../concepts/determinism-boundary.md)).
- **`server/`** — the orchestration brain: stateful, runs **no** user code. Owns
  histories, queues, timers, and the transactional logic that advances them
  (`server_core.ts`).
- **`services/`** — the two `WorkflowService` implementations plus transport
  (`LocalService`, `ServerHost` + `rpc_server`, `RemoteService`).
- **`worker/`** — stateless workers written once against `WorkflowService`.
- **`client/`** — turns a `WorkflowService` into ergonomic handles.

Above the stack sit the two entrypoints and the deployable process mains
(`local_runtime.ts`, `workflow.ts`, `index.ts`, `bin/`).

## The two rules that keep it honest

1. **Dependencies point down:** `protocol <- core <- {server, services, worker,
client} <- {local_runtime, entrypoints, bin}`. Nothing in `core/` imports from
   below it; `core/` may import only `protocol/` (pure data).
2. **Two entrypoints:** workflow code imports only from `workflow.ts` (the
   deterministic surface); hosts import from `index.ts`. This is what turns the
   [determinism boundary](../concepts/determinism-boundary.md) into a structural
   fact rather than a convention.

> **Status:** both rules are currently upheld by discipline, not tooling. The
> import-path **lint rule** that would make them mechanical is a planned TODO, not
> yet built (see [`PROJECT.md` §6](../../PROJECT.md)). Treat any description of the
> lint rule as existing as aspirational until it lands.

## The `WorkflowService` seam

Workers and client are written **once**, against a `WorkflowService` interface
(start/signal/getResult + the worker-facing poll/respond methods). Two
implementations satisfy it:

- **`LocalService`** — the whole server in-process: in-memory ports + in-proc
  worker drain loops. Fast; for tests and single-node runs.
- **`RemoteService`** — an RPC client to a networked server (`ServerHost` behind
  `rpc_server`).

Local vs. distributed is a _choice of implementation_, not a fork of the runtime.
The integration suite runs against `LocalService` unchanged, and a subset runs
against a real server (see [distribution](distribution.md)).

## Ports & adapters

The server coordinates over interfaces so implementations swap without touching
orchestration logic:

- `HistoryStore` — `load`/`append` with an **optimistic version**. In-memory and
  file-backed (`server/file/`) adapters exist today.
- `TaskQueue` / `WorkflowTaskQueue` — `enqueue`/`poll`/`lease`/`ack`/`expire-and-requeue`.
  The workflow-task queue also carries the per-execution concurrency guarantees
  described in [task execution & concurrency](task-execution-and-concurrency.md).
- `TimerService` — durable `schedule` + crash-tolerant `sweep`.

In-memory adapters power `LocalService`; durable adapters (a database, a real
queue) are the distributed swap.

## Where to go next

- [Distribution](distribution.md) — how the same code scales to three resilient
  tiers, and the failure-semantics caveat that comes with it.
- [Task execution & concurrency](task-execution-and-concurrency.md) — how a
  workflow actually advances under poll/respond, and the two concurrency bugs the
  design prevents.

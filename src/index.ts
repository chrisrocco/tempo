/**
 * @fileoverview
 * ★ HOST ENTRYPOINT — process/host code imports from here.
 *
 * The runtime factory, its handle/registration types, the service seam, and the
 * public protocol vocabulary. Workflow *authors* do not import from here; they
 * import from `workflow.ts`.
 *
 * The two entrypoints are what turn the determinism boundary into a structural
 * fact rather than a convention: everything reachable from `workflow.ts` is
 * deterministic, everything reachable from here is host-side. Dependencies point
 * strictly downward — `protocol <- core <- {server, services, worker, client} <-
 * {local_runtime, entrypoints, bin}` — and nothing in `core/` imports from below
 * it.
 *
 * ## What a host can build from here, and why the list is what it is
 *
 * This library does not deploy itself. There is no CLI and no deployment
 * module — assembling one is the consumer's job, because the machine, the build
 * system, and the supervisor are theirs (`README.md`, "Running it yourself").
 * That makes this entrypoint a contract rather than a convenience: everything
 * needed to stand the system up has to be reachable from here, or it is not
 * reachable at all.
 *
 * Four things, and each is here because something cannot be built without it:
 *
 * - **`startServer`** — a server artifact. Without it a consumer can build a
 *   worker and have nothing to point it at.
 * - **`startWorker`** — a worker artifact.
 * - **`createRemoteClient` + `createRemoteService`** — a client. The client was
 *   already exported and the service to construct it from was not, so the one
 *   supported way to reach a running server ran through a deep import.
 * - **The flag vocabulary** (`DEFAULT_PORT`, `SERVER_FLAG`, `WORKER_FLAG`,
 *   `formatFlag`) — a launcher. Whoever writes the command line that starts these
 *   processes shares the constants with the processes that read them, so a
 *   supervisor emitting `--listen=7777` where the server reads `--port` is a
 *   compile error rather than a deployment that starts, reports healthy, and
 *   serves nobody.
 *
 * `createServerHost` and `createRpcServer` are exported below them for the case
 * `startServer` does not cover — an embedded host, or a server behind a
 * transport this repo did not write.
 */

export {createClient, createRemoteClient} from './client';
export type {Client, RemoteClient, WorkflowHandle} from './client';
export type {WorkflowContext, WorkflowFn} from './core';
export {
  createLocalRuntime,
  type LocalRuntimeOptions,
  type Runtime,
} from './local_runtime';
export {FileHistoryStore} from './server';
export type {ExecutionRecord, HistoryStore} from './server';
export {startServer, type Server, type StartServerOptions} from './server_main';
export {
  DEFAULT_SERVER_URL,
  startWorker,
  type StartWorkerOptions,
  type Worker,
  type WorkerRole,
} from './tempo';

// The composition seam under the two entrypoints: what to build a server from
// when `startServer` is not the shape you want, and the service a remote client
// is made of. `createRemoteService` is the one a consumer needs most — a
// `RemoteClient` cannot be constructed without it.
export {
  createRemoteService,
  createRpcServer,
  createServerHost,
  type RemoteServiceOptions,
  type ServerHost,
  type ServerHostOptions,
} from './services';

// The argv vocabulary, shared with whoever writes the command line that starts
// these processes — see the fileoverview.
export {
  DEFAULT_PORT,
  SERVER_FLAG,
  WORKER_FLAG,
  formatFlag,
} from './process_flags';
export type {ActivityFn} from './worker';
// NondeterminismError is exported here but deliberately NOT from `workflow.ts`:
// a host may want to distinguish a diverged execution from an ordinary failure,
// while a workflow cannot do anything useful about its own history diverging.
export {CancelledFailure, NondeterminismError} from './core';

// the service seam + worker task contracts
export type {
  ActivityResult,
  ActivityTask,
  ExecutionStatus,
  RemoteWorkflowService,
  ServerHealth,
  StartWorkflowOptions,
  WorkflowService,
  WorkflowTaskResult,
} from './protocol';

// the protocol vocabulary — the wire format consumers may reference
export type {
  ActivityOptions,
  Command,
  CommandSpec,
  CompletionEvent,
  HistoryEvent,
  RetryPolicy,
  SignalEvent,
} from './protocol';

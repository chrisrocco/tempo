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
 */

export type {Client, WorkflowHandle} from './client';
export type {WorkflowContext, WorkflowFn} from './core';
export {
  createLocalRuntime,
  type LocalRuntimeOptions,
  type Runtime,
} from './local_runtime';
export {FileHistoryStore} from './server';
export type {ExecutionRecord, HistoryStore} from './server';
export {
  DEFAULT_SERVER_URL,
  Tempo,
  startWorker,
  type RuntimeMode,
  type StartWorkerOptions,
  type Worker,
  type WorkerRole,
} from './tempo';
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

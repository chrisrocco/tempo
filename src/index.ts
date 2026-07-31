/**
 * @fileoverview
 * ★ HOST ENTRYPOINT — process/host code imports from here.
 *
 * The runtime factory, its handle/registration types, the service seam, and the
 * public protocol vocabulary. Workflow *authors* do not import from here; they
 * import from `workflow.ts`. See docs/concepts/determinism-boundary.md and docs/architecture/structure-and-layers.md.
 */

export {
  createLocalRuntime,
  type Runtime,
  type LocalRuntimeOptions,
} from './local_runtime';
export {
  Tempo,
  startWorker,
  DEFAULT_SERVER_URL,
  type StartWorkerOptions,
  type Worker,
  type WorkerRole,
} from './tempo';
export { FileHistoryStore } from './server';
export type { HistoryStore, ExecutionRecord } from './server';
export type { WorkflowHandle, Client } from './client';
export type { ActivityFn } from './worker';
export type { WorkflowFn, WorkflowContext } from './core';
export { CancelledFailure } from './core';

// the service seam + worker task contracts
export type {
  WorkflowService,
  ExecutionStatus,
  StartWorkflowOptions,
  ActivityTask,
  ActivityResult,
  WorkflowTaskResult,
} from './protocol';

// the protocol vocabulary — the wire format consumers may reference
export type {
  Command,
  CommandSpec,
  ActivityOptions,
  RetryPolicy,
  HistoryEvent,
  SignalEvent,
  CompletionEvent,
} from './protocol';

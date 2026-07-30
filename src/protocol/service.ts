// The service contract: what a host/client calls to drive workflows, plus the
// task payloads the server hands to workers and gets back. These are pure data +
// signatures — the seam that `LocalService` (in-proc) and, later, `RemoteService`
// (RPC) both satisfy. Living in `protocol/` is what lets `server` and `worker`
// share the task shapes without importing each other (see docs/architecture/structure-and-layers.md).
import type { ActivityOptions } from './activity_options';
import type { Command } from './commands';
import type { HistoryEvent } from './history_events';
import type { TaskToken } from './task_token';

export type ExecutionStatus = 'running' | 'completed' | 'failed';

export interface StartWorkflowOptions {
  workflowId?: string;
}

/**
 * The seam both `LocalService` (in-proc) and, later, `RemoteService` (RPC) satisfy.
 * It has two faces: the client-facing methods (start/signal/cancel/get*) and the
 * worker-facing poll/respond methods. Workers are written once against the latter
 * — the in-proc workers poll a local implementation; distributed workers poll a
 * remote one over RPC (docs/architecture/structure-and-layers.md).
 */
export interface WorkflowService {
  // ── client-facing ──
  start(name: string, args?: unknown[], opts?: StartWorkflowOptions): { workflowId: string };
  signal(workflowId: string, signalName: string, payload?: unknown): void;
  cancel(workflowId: string): void;
  getResult(workflowId: string): Promise<unknown>;
  getStatus(workflowId: string): ExecutionStatus;
  // ── worker-facing (poll a task, respond when done) ──
  pollWorkflowTask(): Promise<WorkflowTask | undefined>;
  completeWorkflowTask(token: TaskToken, result: WorkflowTaskResult): Promise<void>;
  pollActivityTask(): Promise<LeasedActivityTask | undefined>;
  completeActivityTask(token: TaskToken, result: ActivityResult): Promise<void>;
}

// ── worker task contracts ───────────────────────────────────────────────
/** A unit of activity work: which activity to run, for which execution/command. */
export interface ActivityTask {
  workflowId: string;
  seq: number;
  name: string;
  args: unknown[];
  /** Carried so the worker can apply the retry policy while the workflow stays parked. */
  options: ActivityOptions;
}

/** What an activity worker reports back after running an activity function. */
export type ActivityResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/** An activity task handed to a worker, with the lease token to complete it. */
export interface LeasedActivityTask extends ActivityTask {
  token: TaskToken;
}

/**
 * A workflow task handed to a workflow worker: replay this history and respond
 * with the resulting commands + terminal state. The `token` identifies the task
 * on complete; `continueAsNewSuggested` is the server's history-growth hint.
 */
export interface WorkflowTask {
  token: TaskToken;
  workflowId: string;
  name: string;
  args: unknown[];
  history: HistoryEvent[];
  continueAsNewSuggested: boolean;
}

/** What a workflow worker returns after replaying one workflow task. */
export interface WorkflowTaskResult {
  done: boolean;
  result: unknown;
  failed: boolean;
  failure: unknown;
  commands: Command[];
}

// The service contract: what a host/client calls to drive workflows, plus the
// task payloads the server hands to workers and gets back. These are pure data +
// signatures — the seam that `LocalService` (in-proc) and, later, `RemoteService`
// (RPC) both satisfy. Living in `protocol/` is what lets `server` and `worker`
// share the task shapes without importing each other (see doc 06).
import type { ActivityOptions } from './activity_options';
import type { Command } from './commands';

export type ExecutionStatus = 'running' | 'completed' | 'failed';

export interface StartWorkflowOptions {
  workflowId?: string;
}

/**
 * The client-facing surface. Workers and client are written once against this
 * seam; two implementations satisfy it (local + remote).
 *
 * NOTE: the *worker-facing* poll/respond methods (and leasing) described in doc
 * 06 are the distributed seam — they join this interface in Phase 5 alongside
 * `RemoteService`. Today the in-proc workers are wired directly by
 * `local_runtime`, so `WorkflowService` carries only the client-facing methods.
 */
export interface WorkflowService {
  start(name: string, args?: unknown[], opts?: StartWorkflowOptions): { workflowId: string };
  signal(workflowId: string, signalName: string, payload?: unknown): void;
  cancel(workflowId: string): void;
  getResult(workflowId: string): Promise<unknown>;
  getStatus(workflowId: string): ExecutionStatus;
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

/** What a workflow worker returns after replaying one workflow task. */
export interface WorkflowTaskResult {
  done: boolean;
  result: unknown;
  failed: boolean;
  failure: unknown;
  commands: Command[];
}

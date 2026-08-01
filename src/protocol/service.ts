/**
 * @fileoverview
 * The service contract: what a host/client calls to drive workflows, plus the
 * task payloads the server hands to workers and gets back. These are pure data +
 * signatures — the seam that `LocalService` (in-proc) and `RemoteService` (RPC)
 * both satisfy. Living in `protocol/` is what lets `server` and `worker` share the
 * task shapes without importing each other.
 *
 * This seam is why local vs. distributed is a *choice of implementation* rather
 * than a fork of the runtime: workers and the client are written once against it,
 * and the integration suite runs unchanged against either side. It unifies the
 * code path, not the failure semantics — see the caveat on `LocalService`.
 */

import type { ActivityOptions } from './activity_options';
import type { Command } from './commands';
import type { HistoryEvent } from './history_events';
import type { TaskToken } from './task_token';

/**
 * `terminated` is deliberately its own status rather than a flavour of `failed`.
 * They answer different questions in a postmortem — "your code raised" versus "an
 * operator pulled the plug" — and folding them together loses that exactly where
 * it is being looked for. Adding the member also makes every switch over status a
 * compile error until it is considered, which is the point.
 */
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'terminated';

export interface StartWorkflowOptions {
  workflowId?: string;
}

// ── inspection (read-only views) ─────────────────────────────────────────
// Derived from history rather than stored, so they cannot drift from the truth
// and no adapter has to maintain them. Deliberately projections, not the
// server's own record types: `ExecutionRecord` carries a `version` for the
// optimistic CAS and raw `failure` values that need not be serializable, and
// neither belongs on the wire.

/** One line of `tempo list`: enough to identify an execution and its state. */
export interface ExecutionSummary {
  workflowId: string;
  /** Increments on each continue-as-new; the workflowId is stable across runs. */
  runId: number;
  name: string;
  status: ExecutionStatus;
  historyLength: number;
}

/**
 * Dispatched work whose completion has not arrived — why a running execution is
 * parked. An execution that is `running` with nothing pending is either mid-task
 * or genuinely stuck, and that distinction is the first thing an operator wants.
 */
export interface PendingWorkView {
  activities: { seq: number; name: string }[];
  timers: { seq: number; fireAt: number }[];
  children: { seq: number; childId: string; detached: boolean }[];
}

/** `tempo describe`: the summary, plus history and what the execution awaits. */
export interface ExecutionDetail extends ExecutionSummary {
  args: unknown[];
  history: HistoryEvent[];
  pending: PendingWorkView;
  cancelRequested: boolean;
  result?: unknown;
  /** A message, not an Error — failures cross the wire as text. */
  failure?: string;
  /**
   * Consecutive workflow-task failures. Non-zero on a `running` execution is the
   * signal that it is wedged rather than merely waiting — the engine cannot
   * replay it, and is retrying on a backoff.
   */
  taskFailures: number;
  /** Why the most recent workflow task failed. */
  lastTaskFailure?: string;
}

/**
 * The seam both `LocalService` (in-proc) and, later, `RemoteService` (RPC) satisfy.
 * It has two faces: the client-facing methods (start/signal/cancel/get*) and the
 * worker-facing poll/respond methods. Workers are written once against the latter
 * — the in-proc workers poll a local implementation; distributed workers poll a
 * remote one over RPC.
 */
export interface WorkflowService {
  // ── client-facing ──
  start(
    name: string,
    args?: unknown[],
    opts?: StartWorkflowOptions,
  ): { workflowId: string };
  signal(workflowId: string, signalName: string, payload?: unknown): void;
  cancel(workflowId: string): void;
  /**
   * End an execution outright, without replaying it. Distinct from `cancel`,
   * which is cooperative and therefore cannot reach an execution whose replay is
   * the thing that throws.
   */
  terminate(workflowId: string, reason: string): void;
  getResult(workflowId: string): Promise<unknown>;
  getStatus(workflowId: string): ExecutionStatus;
  /** Inspect one execution: status, history, and what it is waiting on. */
  describeExecution(workflowId: string): Promise<ExecutionDetail | undefined>;
  /** Every execution the server knows about. */
  listExecutions(): Promise<ExecutionSummary[]>;
  // ── worker-facing (poll a task, respond when done) ──
  pollWorkflowTask(): Promise<WorkflowTask | undefined>;
  completeWorkflowTask(
    token: TaskToken,
    result: WorkflowTaskResult,
  ): Promise<void>;
  /**
   * Report that this task could not be replayed at all. Distinct from a
   * `WorkflowTaskResult` carrying `failed` — that is the *workflow* failing, a
   * normal outcome the engine records and settles. This is the *engine* unable to
   * run it: a nondeterminism error, or a bug thrown outside the workflow's own
   * control flow. The execution keeps running and the task is retried.
   */
  failWorkflowTask(token: TaskToken, reason: string): Promise<void>;
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
  { ok: true; result: unknown } | { ok: false; error: string };

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

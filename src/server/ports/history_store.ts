/**
 * @fileoverview
 * The port the server persists executions through. Async, so a filesystem/db
 * adapter (Phase 4) slots in unchanged. `append` is atomic per call and the
 * adapter owns the version bump — under a single writer (drives serialized by
 * pump, external writes serialized by the adapter) that is sufficient. `version`
 * is retained on the record for the Phase-5 optimistic-CAS check, which is where
 * concurrent workers make it meaningful.
 */

import type {Carryover, ExecutionStatus, HistoryEvent} from '../../protocol';

/** One execution's durable state: its identity, history, and terminal outcome. */
export interface ExecutionRecord {
  workflowId: string;
  /** Increments on each continue-as-new; the workflowId stays stable across runs. */
  runId: number;
  name: string;
  args: unknown[];
  /**
   * The pool this execution runs on. Durable because routing has to outlive the
   * process that decided it: every workflow task this execution ever produces
   * must go to the same pool, including the ones a restart re-drives from
   * history, and its activities inherit it.
   */
  taskQueue: string;
  /**
   * When the execution was created, epoch ms. Distinct from the first history
   * event: an execution exists, and can be listed, before it has been replayed
   * once. It is also the sort key a paged listing needs — a cursor is only
   * meaningful over a total order, and neither insertion order nor whatever a
   * directory read returns is one.
   */
  createdAt: number;
  history: HistoryEvent[];
  version: number;
  status: ExecutionStatus;
  result?: unknown;
  failure?: unknown;
  /**
   * The stack behind `failure`, stored separately because `failure` is an
   * arbitrary thrown value: over RPC it arrives already flattened to a message,
   * and an `Error` does not survive JSON with its stack attached.
   */
  failureStack?: string;
  /**
   * Workflow-owned state that survives continue-as-new. Unlike `history` it is
   * not append-only and not replayed — it is the value the last workflow task
   * reported, kept so the next one can start from it.
   */
  carryover: Carryover;
  /** Absent on an execution a client started directly, which is most of them. */
  parent?: ExecutionParent;
  /**
   * Consecutive workflow-task failures, reset by the next success. Durable
   * because the queues are not: a counter kept in the queue would reset on
   * exactly the restart a frustrated operator reaches for first, making a poison
   * task immortal.
   *
   * Deliberately **not** a history event. History is replayed, and one event per
   * failed attempt would both bloat it and skew `continueAsNewSuggested`, which
   * fires on history length — a task failing in a loop would push its own
   * execution toward continue-as-new while making no progress.
   */
  taskFailures: number;
  /** Why the most recent workflow task failed; cleared alongside the count. */
  lastTaskFailure?: string;
  /**
   * What is known about each activity `seq` currently being retried. Cleared
   * when the activity reaches a terminal event, so this holds only what is in
   * flight rather than growing with history.
   *
   * Durable for the same reason `taskFailures` is: the queues are in-memory, so a
   * count kept there would reset on a restart and quietly grant a fresh retry
   * budget. Not in history, because one event per failed attempt would bloat it
   * and skew the continue-as-new hint.
   */
  activityAttempts: Record<number, ActivityRetryState>;
}

/**
 * The execution that started this one, on a child's record.
 *
 * Recorded on the child rather than derived from the parent because the parent's
 * `childStarted` event is the only other place it exists, and finding it from a
 * child would mean scanning every execution's history for one naming this id.
 * `parentOfChild` in `server_core` holds the same fact in memory, but only for
 * blocking children and only to route a completion — it is not an answer to
 * "where did this come from", which is asked of settled and detached children
 * too.
 */
export interface ExecutionParent {
  workflowId: string;
  /** The `startChild` seq in the parent, which its history is keyed by. */
  seq: number;
}

/**
 * Why an activity is between attempts.
 *
 * `attempts` is the count the retry policy is applied to, and the reason this
 * record exists at all. The other two are here because a count alone says an
 * activity is failing without saying why or for how much longer, and an operator
 * reading "attempt 4 of 5" immediately asks both — see `PendingActivityView`,
 * which is where this reaches them.
 */
export interface ActivityRetryState {
  /** Attempts that have been made and failed. */
  attempts: number;
  /** Why the most recent one failed. */
  lastError?: string;
  /**
   * When the next attempt is due, epoch ms.
   *
   * Absent between the failure being recorded and the retry being scheduled, and
   * on the final failure — there is no next attempt to describe. A reader must
   * treat it as unknown rather than as "now".
   */
  nextAttemptAt?: number;
}

/** Thrown by `appendIfVersion` when the execution has moved on — a lost lease race. */
export class VersionConflictError extends Error {
  constructor(workflowId: string, expected: number, actual: number) {
    super(
      `version conflict on ${workflowId}: expected ${expected}, have ${actual}`,
    );
    this.name = 'VersionConflictError';
    Object.setPrototypeOf(this, VersionConflictError.prototype);
  }
}

export interface HistoryStore {
  /** Register a fresh execution. Rejects if the id already exists. */
  create(
    workflowId: string,
    name: string,
    args: unknown[],
    taskQueue?: string,
    parent?: ExecutionParent,
  ): Promise<void>;
  /** A snapshot of the record, or undefined if unknown. */
  get(workflowId: string): Promise<ExecutionRecord | undefined>;
  /** Every execution — used by the resume driver on boot to re-drive running ones. */
  list(): Promise<ExecutionRecord[]>;
  /** Append events atomically and bump the version. Rejects if the id is unknown. */
  append(workflowId: string, events: HistoryEvent[]): Promise<void>;
  /**
   * Append conditional on `expectedVersion` matching the current version
   * (optimistic concurrency) — throws VersionConflictError otherwise. The
   * distributed replacement for the single-writer assumption: two workers racing
   * the same task both hold the same expected version, and only the first append
   * lands. Safe to reject the loser because replay commits no external effects.
   */
  appendIfVersion(
    workflowId: string,
    events: HistoryEvent[],
    expectedVersion: number,
  ): Promise<void>;
  /**
   * Record that a workflow task failed: increment the counter, keep the reason,
   * and return the new count so the caller can size its backoff.
   *
   * **Must not bump `version`.** A failure is not history, and bumping it would
   * make a concurrent worker's legitimate completion lose the optimistic CAS —
   * one worker's failure would discard another's success.
   */
  recordTaskFailure(workflowId: string, reason: string): Promise<number>;
  /**
   * Forget past failures once a task succeeds. Implementations should no-op when
   * the count is already zero: this runs after every successful workflow task,
   * and a durable adapter should not pay a write for the common case.
   */
  clearTaskFailures(workflowId: string): Promise<void>;
  /**
   * Count one failed attempt of the activity at `seq`, returning the new total so
   * the caller can apply the retry policy. Like `recordTaskFailure`, this must not
   * bump `version` — an attempt is not history.
   *
   * `error` is recorded alongside the count and replaces any previous one: what
   * an operator wants is why it is failing *now*, and keeping every message would
   * grow without bound for an activity retrying against a policy with no limit.
   */
  recordActivityAttempt(
    workflowId: string,
    seq: number,
    error?: string,
  ): Promise<number>;
  /**
   * Record when the next attempt of `seq` is due.
   *
   * Separate from `recordActivityAttempt` because the caller cannot know it at
   * that point: the delay comes from the retry policy applied to the count that
   * call returns. Both writes are on the failure path, where a second one costs
   * nothing worth avoiding.
   */
  setActivityNextAttempt(
    workflowId: string,
    seq: number,
    at: number,
  ): Promise<void>;
  /** Forget an activity's attempts once it reaches a terminal event. */
  clearActivityAttempts(workflowId: string, seq: number): Promise<void>;
  /** Replace the execution carryover with what the last workflow task reported. */
  setCarryover(workflowId: string, carryover: Carryover): Promise<void>;
  /** Record the terminal outcome once a workflow task settles the execution. */
  setStatus(
    workflowId: string,
    status: ExecutionStatus,
    outcome?: {result?: unknown; failure?: unknown; failureStack?: string},
  ): Promise<void>;
  /**
   * Continue-as-new: close the current run and begin a fresh one on the SAME
   * workflowId — empty history seeded with `args`, bumped runId, version reset,
   * status stays 'running'. Not a real close, so the result waiter is untouched.
   */
  resetForContinueAsNew(workflowId: string, args: unknown[]): Promise<void>;
}

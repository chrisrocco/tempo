/**
 * @fileoverview
 * The port the server persists executions through. Async, so a filesystem/db
 * adapter (Phase 4) slots in unchanged. `append` is atomic per call and the
 * adapter owns the version bump — under a single writer (drives serialized by
 * pump, external writes serialized by the adapter) that is sufficient. `version`
 * is retained on the record for the Phase-5 optimistic-CAS check, which is where
 * concurrent workers make it meaningful.
 */

import type {
  Carryover,
  ExecutionStatus,
  HistoryEvent,
  ParkedCondition,
} from '../../protocol';

/** One execution's durable state: its identity, history, and terminal outcome. */
export interface ExecutionRecord {
  workflowId: string;
  /**
   * How many times this execution has continued-as-new; the workflowId stays
   * stable across runs. A counter on the surviving record, never part of a key
   * — see `resetForContinueAsNew` for why there is only ever one record.
   */
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
   * What the last workflow task left the execution parked on.
   *
   * Current state, not history — the same category as `taskFailures` and
   * `activityAttempts`, and stored for the same reason. A parked condition
   * writes no event by design (that is what makes `condition` free), so history
   * cannot answer where an execution is waiting, and only the worker that
   * replayed it knows.
   *
   * Replaced wholesale on each task rather than accumulated. Absent on an
   * execution whose tasks predate this, which reads the same as "not parked".
   */
  parked?: ParkedCondition[];
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
  /**
   * Which activity this is — the `name` from its `activityScheduled` event.
   *
   * A copy of something history already holds, which is normally the wrong
   * trade. It earns its place by changing the cost of one specific question:
   * `groupExecutions` reports retries grouped by activity name, and without
   * this it would have to run `pendingWork` over every execution's full history
   * to turn a `seq` into a name — turning an O(executions) scan into an
   * O(total events) one, on the call a dashboard polls.
   *
   * It cannot drift: `activityScheduled` is immutable, this is written from it,
   * and both are discarded together when the activity settles.
   *
   * Optional because it is only as certain as the lookup that produced it. An
   * attempt recorded for a `seq` with no scheduling event in history is a bug
   * rather than a shape to support, but it should not cost a name that is
   * merely a diagnostic.
   */
  name?: string;
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
  /**
   * Does state written here survive the process?
   *
   * On the port rather than inferred by the caller, because the alternative is
   * an `instanceof FileHistoryStore` somewhere in `services/` — which would put
   * a concrete adapter on the wrong side of this seam to answer a question the
   * adapter already knows. It is also the honest source: a server told
   * separately that it is durable can be told wrong, and a health probe that
   * reports durability it does not have is worse than one that reports nothing.
   */
  readonly durable: boolean;
  /**
   * Where this store keeps its state, for an operator reading a health probe.
   *
   * Absent when there is nowhere to point at, which is the in-memory case. Not
   * necessarily a path — a future SQL adapter would put a redacted DSN here —
   * so it is for a human to read and never for a caller to parse.
   */
  readonly location?: string;
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
   *
   * `name` is recorded once and kept — see `ActivityRetryState.name`. It trails
   * `error` because it is the later addition and the parameter it would
   * otherwise displace is written at every call site; a caller that knows
   * neither passes neither.
   */
  recordActivityAttempt(
    workflowId: string,
    seq: number,
    error?: string,
    name?: string,
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
  /**
   * Drop every event from index `keep` onward, so the execution can be replayed
   * from a point before something went wrong.
   *
   * **Bumps `version`**, unlike every other mutation that is "not history". That
   * is the point: a workflow task already polled carries the version it replayed
   * against, and without the bump its `appendIfVersion` would succeed and stack
   * events built from a history that no longer exists on top of the truncated
   * one. With it, the in-flight task fails its CAS and is redelivered against
   * what is actually there.
   *
   * Truncation is destructive and there is no undo: the dropped events are gone
   * from the log, not tombstoned. Callers are expected to have said so.
   */
  truncateHistory(workflowId: string, keep: number): Promise<void>;
  /**
   * Replace what the execution is parked on with what the last task reported.
   *
   * Like `recordTaskFailure`, this must not bump `version` — where a workflow is
   * waiting is not history. Callers are expected to skip the write when nothing
   * changed, which is the common case: most workflows never park a condition, so
   * most tasks would otherwise pay a store write to record the same empty list.
   */
  setParkedConditions(
    workflowId: string,
    parked: ParkedCondition[],
  ): Promise<void>;
  /** Replace the execution carryover with what the last workflow task reported. */
  setCarryover(workflowId: string, carryover: Carryover): Promise<void>;
  /** Record the terminal outcome once a workflow task settles the execution. */
  setStatus(
    workflowId: string,
    status: ExecutionStatus,
    outcome?: {result?: unknown; failure?: unknown; failureStack?: string},
  ): Promise<void>;
  /**
   * Continue-as-new: begin a fresh run on the SAME record — history emptied and
   * reseeded with `args`, bumped runId, version reset, status stays 'running'.
   * Not a real close, so the result waiter is untouched.
   *
   * **The previous run's events are destroyed, and there is no way to read them
   * afterwards.** One `workflowId` is one record; `runId` is a counter on the
   * surviving record rather than part of a key, so an execution that has rolled
   * over five times still has exactly one history — the current one. Nothing
   * anywhere retains the other four.
   *
   * Decided rather than overlooked (ticket 05). Retaining runs is what Temporal
   * does, and it would make run-chain navigation buildable, but it means owning
   * a second problem: total stored bytes, which continue-as-new never addressed
   * and which Temporal reclaims with a time-based retention sweep. The workflows
   * that roll over most are the ones that would cost the most to keep, and
   * nothing has yet needed to read a past run — so this stays one id, one
   * record, and the cost of changing course is a storage migration rather than a
   * design corner.
   *
   * The consequence a caller must know: **`runId` on a summary is a count, not
   * an address.** Seeing `runId: 5` does not mean runs 0–4 can be fetched.
   */
  resetForContinueAsNew(workflowId: string, args: unknown[]): Promise<void>;
}

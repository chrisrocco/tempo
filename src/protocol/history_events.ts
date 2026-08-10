/**
 * @fileoverview
 * Recorded history is the durable log a workflow is replayed against. Every
 * event either completes a command (and is keyed by that command's `seq`) or is
 * an externally injected signal (which is not tied to a command, so has no seq).
 * Keeping those two families in separate unions lets `applyEvent` narrow with a
 * single `type === 'signal'` check instead of hunting for the seq-bearing ones.
 *
 * A third family sits between them: **markers**, which carry a seq but complete
 * nothing. They record that a command was dispatched, which is what stops replay
 * dispatching it twice and what crash recovery rebuilds pending work from. Every
 * command leaves one (see `server_core`), so they are not a union worth naming —
 * but they are the reason "has a seq" and "completes something" are different
 * questions.
 */

import type {ActivityOptions} from './activity_options';

/**
 * What every recorded event carries, whatever kind it is.
 *
 * `ts` is stamped by the server at the moment the event is appended, once, and
 * is thereafter part of the durable record — so replaying the same history
 * yields the same timestamps, and nothing derived from it can diverge. It is the
 * server's clock, not any worker's: workers are stateless and interchangeable,
 * and their clocks are not.
 *
 * Optional because histories written before this field existed have none.
 * Readers must treat a missing `ts` as "unknown", never as zero — an execution
 * that predates this change is not one that happened in 1970.
 *
 * **Deliberately not exposed to workflow code.** A recorded timestamp is
 * deterministic, so a `workflow.now()` built on it would be sound, but that is a
 * primitive with its own design (which event's clock does a bare `now()` read?)
 * rather than a field to reach through `applyEvent` for.
 */
export interface HistoryEventBase {
  /** Epoch milliseconds, from the server, at append time. */
  ts?: number;
}

/** Fields common to events that complete a specific command. */
export interface CompletionEventBase extends HistoryEventBase {
  /** The seq of the command this event completes. */
  seq: number;
}

export interface ActivityCompletedEvent extends CompletionEventBase {
  type: 'activityCompleted';
  result: unknown;
}

export interface ActivityFailedEvent extends CompletionEventBase {
  type: 'activityFailed';
  error: string;
  /**
   * The activity's own stack, from the worker process that ran it. Optional
   * because history written before this field existed has none, and because a
   * thrown non-Error has none to take.
   */
  stack?: string;
}

export interface TimerFiredEvent extends CompletionEventBase {
  type: 'timerFired';
}

/**
 * `childId` is denormalized onto both child outcomes even though the same
 * `seq` already appears on the `childStarted` that dispatched it.
 *
 * Not redundancy: history is *paged* (see `MAX_HISTORY_PAGE`), and a child that
 * ran for a while has its dispatch and its outcome hundreds of events apart. A
 * reader holding one page can pair them only if both carry the id, so without
 * this a failed child is a row saying "child failed" with no way to reach the
 * child — which is exactly the case that most needs reaching, since a failed
 * child permanently burns its workflow id and is never retried.
 *
 * Optional because histories written before this field existed have none.
 * Readers must treat a missing `childId` as "unknown", never as absent — the
 * child existed either way.
 */
export interface ChildCompletedEvent extends CompletionEventBase {
  type: 'childCompleted';
  result: unknown;
  /** The child's workflow id — see the note above. */
  childId?: string;
}

export interface ChildFailedEvent extends CompletionEventBase {
  type: 'childFailed';
  error: string;
  /** The child's workflow id — see the note above. */
  childId?: string;
}

/**
 * Marker: an activity has been dispatched (before it runs). Carries the command's
 * seq but is NOT a completion — it resolves nothing on replay. Its jobs: record
 * "scheduled before running" for crash-recovery idempotency, and advance history
 * past the command so a re-emitted `scheduleActivity` isn't re-dispatched. It also
 * carries the dispatch payload (name/args/options) so a resumed process can
 * re-enqueue the task from history alone. Markers do double duty: they stop a
 * re-emitted command from re-dispatching, and they are the "scheduled before
 * running" record crash recovery reconstructs from.
 */
export interface ActivityScheduledEvent extends HistoryEventBase {
  type: 'activityScheduled';
  seq: number;
  name: string;
  args: unknown[];
  options: ActivityOptions;
}

/**
 * Marker: a timer has been started. Records the absolute `fireAt` so a resumed
 * process re-arms it from history (past-due timers fire at once) — history stays
 * the single source of truth for time, so a workflow's sense of "now" is never
 * read from the host clock at replay. Not workflow-visible; `sleep`
 * still resolves on the `timerFired` completion.
 */
export interface TimerStartedEvent extends HistoryEventBase {
  type: 'timerStarted';
  seq: number;
  fireAt: number;
}

/**
 * Marker: a child workflow has been started. Same role as `activityScheduled` —
 * records the dispatch for recovery and advances history past the `startChild`
 * command so replay doesn't re-launch it.
 *
 * Recorded for **both** kinds of child, because both are dispatched work and the
 * marker invariant is about dispatch, not about completion (see `server_core`).
 * `detached` says which kind, and that is the only thing downstream needs it for:
 * a blocking child's completion arrives later as a `childCompleted` /
 * `childFailed` keyed by the same seq, while a detached child never reports back
 * at all. Recovery must not synthesize a completion for one that is never coming.
 */
export interface ChildStartedEvent extends HistoryEventBase {
  type: 'childStarted';
  seq: number;
  childId: string;
  /** true = fire-and-forget (`startChild`); false = blocking (`executeChild`). */
  detached: boolean;
}

/**
 * Marker: a cancel has been requested for a detached child. Same role as the
 * markers above — it records the dispatch so replay does not re-request — and it
 * is the one command that used to have none.
 *
 * The omission was defensible on its own terms: a cancel's real durable record is
 * the `cancelRequested` event on the *child*, and `requestCancel` short-circuits
 * on finding one, so a re-dispatched cancel is idempotent rather than a second
 * cancellation. That reasoning is about **safety**, and it holds. What it does not
 * give is **observability**: replay decides what to emit by asking whether history
 * holds this seq (see `core/workflow_api`), and a command that leaves no trace
 * cannot answer. Without this event a `cancelChild` reached mid-batch was dropped
 * silently and forever — the wedge of issue #39, in the one place the fix for it
 * could not reach (issue #50).
 *
 * Written **after** the cancel is dispatched, as `childStarted` is. Nothing
 * re-drives a cancel on restart, so replay re-emitting the command is its only
 * recovery, and a marker written first is precisely what would suppress it.
 * `server_core`'s header owns that argument and is honest about how much of the
 * marker-ordering split is actually forced.
 */
export interface ChildCancelRequestedEvent extends HistoryEventBase {
  type: 'childCancelRequested';
  seq: number;
  /** The seq of the `startChild` whose child this cancels. */
  targetSeq: number;
}

/**
 * Marker: a signal has been sent to another execution. Same role as the markers
 * above — it records the dispatch so replay does not send a second one.
 *
 * The asymmetry to hold in mind: **a signal sent is numbered, a signal received
 * is not.** Sending is a command, so it takes a seq in the sender's history like
 * any other dispatch; arriving is an external input, so the `SignalEvent` on the
 * target stays seq-less and is unchanged by this. The two events are the two ends
 * of one delivery and they are deliberately not the same shape.
 *
 * Written **after** the delivery, as `childStarted` and `childCancelRequested`
 * are, and for the same reason: nothing re-drives a signal on restart, so replay
 * re-emitting the command is its only recovery, and a marker written first would
 * suppress it. That ordering is only safe because delivery is idempotent —
 * `SignalEvent.source` is what makes it so.
 */
export interface WorkflowSignaledEvent extends HistoryEventBase {
  type: 'workflowSignaled';
  seq: number;
  /** The execution that was signalled. */
  targetId: string;
  signalName: string;
  /**
   * **The payload is deliberately not here.** `activityScheduled` carries its
   * args because nothing else does — the task is rebuilt from it on recovery —
   * whereas a signal's payload is already durable on the target, which is the
   * copy that gets read. Keeping a second one would double the bytes of the
   * highest-volume command there is (a poller relaying every item it finds) to
   * store something one link away. `describe` on the target is where to look.
   */
  /**
   * Whether the target took it: false when nothing holds that id, or when it has
   * already settled.
   *
   * Recorded rather than dropped, because a signal into the void is the failure
   * mode of this command and the sender cannot see it — `signalWorkflow` does not
   * park, so there is no promise to reject. Temporal reports the same condition as
   * a typed `EXTERNAL_WORKFLOW_EXECUTION_NOT_FOUND` on an awaitable command; this
   * keeps the fact and drops the await (see `core/workflow_api.signalWorkflow`).
   *
   * A duplicate suppressed by `SignalEvent.source` reads `true`: it *was*
   * delivered, by the dispatch this one is repeating.
   */
  delivered: boolean;
}

/**
 * Which dispatch produced a signal, when a workflow sent it.
 *
 * Two jobs, and the second is the load-bearing one:
 *
 * - **Provenance.** A signal is otherwise the one event that says nothing about
 *   where it came from, which is the first question asked of one that arrived
 *   unexpectedly.
 * - **Idempotent delivery.** `signalWorkflow` writes its marker *after* the
 *   delivery, so a process that dies in between leaves replay to re-send. The
 *   server drops a re-send by matching this triple against the target's history,
 *   which turns "at least once" into "once" for the window that matters.
 *
 * `runId` is in the key because a sender's `seq` counter restarts at zero on
 * continue-as-new, and the senders that use this most — pollers — roll over
 * constantly. Without it, item 3 of run 1 and item 3 of run 2 would be the same
 * dispatch and the second would be silently dropped.
 *
 * **The dedup window is the target's current history.** A target that continues
 * as new discards the record along with everything else, so a re-send that
 * straddles its rollover is delivered twice. Narrow — it needs a crash and a
 * rollover interleaved — but real, and the honest claim is "once, except across
 * the target's own rollover" rather than "exactly once".
 */
export interface SignalSource {
  /** The sending execution. */
  workflowId: string;
  /** Which run of it — see the note above. */
  runId: number;
  /** The `signalWorkflow` command's seq in that run. */
  seq: number;
}

/**
 * Externally injected; not tied to a command, so it carries no seq.
 *
 * "Externally" now includes another workflow: a signal from `signalWorkflow`
 * arrives here exactly as a client's does, and carries a `source` saying so. That
 * is deliberate — the target's code, its handlers, and its replay cannot tell the
 * two apart, so a workflow that consumes signals needs no knowledge of who is
 * feeding it.
 */
export interface SignalEvent extends HistoryEventBase {
  type: 'signal';
  name: string;
  payload: unknown;
  /**
   * The dispatch that sent this, when a workflow sent it. Absent on a signal
   * injected by a client — which is what makes its presence the answer to "did
   * this come from inside the system?"
   */
  source?: SignalSource;
}

/**
 * Externally injected cancellation request (from a client, or a parent cancelling
 * a child). Like a signal it carries no seq; applying it rejects the run's
 * outstanding operations with a CancelledFailure. Recorded so the cancel point is
 * fixed in history and replay stays deterministic — cancellation is an event, not
 * a side effect.
 */
export interface CancelRequestedEvent extends HistoryEventBase {
  type: 'cancelRequested';
}

/** Events that complete a command — all carry a `seq`. */
export type CompletionEvent =
  | ActivityCompletedEvent
  | ActivityFailedEvent
  | TimerFiredEvent
  | ChildCompletedEvent
  | ChildFailedEvent;

export type HistoryEvent =
  | CompletionEvent
  | ActivityScheduledEvent
  | TimerStartedEvent
  | ChildStartedEvent
  | ChildCancelRequestedEvent
  | WorkflowSignaledEvent
  | SignalEvent
  | CancelRequestedEvent;

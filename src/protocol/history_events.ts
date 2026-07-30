// Recorded history is the durable log a workflow is replayed against. Every
// event either completes a command (and is keyed by that command's `seq`) or is
// an externally injected signal (which is not tied to a command, so has no seq).
// Keeping those two families in separate unions lets `applyEvent` narrow with a
// single `type === 'signal'` check instead of hunting for the seq-bearing ones.
import type { ActivityOptions } from './activity_options';

/** Fields common to events that complete a specific command. */
export interface CompletionEventBase {
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
}

export interface TimerFiredEvent extends CompletionEventBase {
  type: 'timerFired';
}

export interface ChildCompletedEvent extends CompletionEventBase {
  type: 'childCompleted';
  result: unknown;
}

export interface ChildFailedEvent extends CompletionEventBase {
  type: 'childFailed';
  error: string;
}

/**
 * Marker: an activity has been dispatched (before it runs). Carries the command's
 * seq but is NOT a completion — it resolves nothing on replay. Its jobs: record
 * "scheduled before running" for crash-recovery idempotency, and advance history
 * past the command so a re-emitted `scheduleActivity` isn't re-dispatched. It also
 * carries the dispatch payload (name/args/options) so a resumed process can
 * re-enqueue the task from history alone. See doc 06 / ROADMAP Phase 4.
 */
export interface ActivityScheduledEvent {
  type: 'activityScheduled';
  seq: number;
  name: string;
  args: unknown[];
  options: ActivityOptions;
}

/**
 * Marker: a timer has been started. Records the absolute `fireAt` so a resumed
 * process re-arms it from history (past-due timers fire at once) — history stays
 * the single source of truth for time (doc 03). Not workflow-visible; `sleep`
 * still resolves on the `timerFired` completion.
 */
export interface TimerStartedEvent {
  type: 'timerStarted';
  seq: number;
  fireAt: number;
}

/**
 * Marker: a blocking child workflow has been started (before it completes). Same
 * role as `activityScheduled` — records the dispatch for recovery and advances
 * history past the `startChild` command so replay doesn't re-launch it. The
 * matching completion is a normal `childCompleted` / `childFailed` event keyed by
 * the same seq. (Fire-and-forget children carry no such completion.)
 */
export interface ChildStartedEvent {
  type: 'childStarted';
  seq: number;
  childId: string;
}

/** Externally injected; not tied to a command, so it carries no seq. */
export interface SignalEvent {
  type: 'signal';
  name: string;
  payload: unknown;
}

/**
 * Externally injected cancellation request (from a client, or a parent cancelling
 * a child). Like a signal it carries no seq; applying it rejects the run's
 * outstanding operations with a CancelledFailure. Recorded so the cancel point is
 * fixed in history and replay stays deterministic (doc 03).
 */
export interface CancelRequestedEvent {
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
  | SignalEvent
  | CancelRequestedEvent;

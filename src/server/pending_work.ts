/**
 * @fileoverview
 * Given a history, what is this execution still waiting on? One pure derivation,
 * with two consumers that must never disagree: `resumeFromHistory` re-dispatches
 * exactly this set on boot, and the inspection path (`describeExecution`) reports
 * it to an operator asking why an execution is not moving. Two copies of this
 * reasoning would drift, and the drift would be invisible — a `describe` that
 * disagrees with what resume actually re-drives is worse than no `describe`.
 *
 * The rule is the marker invariant read backwards. Every dispatched operation
 * leaves a marker (`activityScheduled` / `timerStarted` / `childStarted`) and its
 * completion arrives later as a separate event keyed by the same `seq` (see
 * `server_core`). So outstanding work is exactly the markers whose seq carries no
 * terminal event yet — which is why this can be computed from history alone, on
 * any process, with no in-memory state.
 *
 * Detached children are reported like any other, with the flag: they are
 * dispatched work and an operator wants to see them. Only recovery cares about
 * the distinction, because a detached child never reports back and must not have
 * a completion synthesized for it — so filtering is the caller's job, not this
 * module's.
 *
 * `childCancelRequested` and `workflowSignaled` are markers and are deliberately
 * **not** pending work. The others record work that is still owed something — a
 * result, a firing — and a cancel or a sent signal is owed nothing: each is
 * dispatched and finished in the same breath. They exist so replay can tell a
 * dispatch it already made from one it has not (see `core/workflow_api`), which is
 * a different question from what this module answers. Reporting them here would
 * tell an operator the execution is waiting on something it is not, and would have
 * `resume` re-send a cancel or a signal that landed.
 */

import type {
  ActivityScheduledEvent,
  ChildStartedEvent,
  HistoryEvent,
  TimerStartedEvent,
} from '../protocol';

/** The seqs that already carry a terminal event, split by what they completed. */
export interface CompletedSeqs {
  activities: Set<number>;
  timers: Set<number>;
  children: Set<number>;
}

/** Dispatched-but-unfinished work, as the marker events that recorded it. */
export interface PendingWork {
  activities: ActivityScheduledEvent[];
  timers: TimerStartedEvent[];
  /** Both kinds; `detached` says which. Recovery filters, inspection does not. */
  children: ChildStartedEvent[];
  /** Cancellation is a request, not a completion, so it is reported separately. */
  cancelRequested: boolean;
}

export function completedSeqs(history: HistoryEvent[]): CompletedSeqs {
  const activities = new Set<number>();
  const timers = new Set<number>();
  const children = new Set<number>();
  for (const ev of history) {
    if (ev.type === 'activityCompleted' || ev.type === 'activityFailed')
      activities.add(ev.seq);
    else if (ev.type === 'timerFired') timers.add(ev.seq);
    else if (ev.type === 'childCompleted' || ev.type === 'childFailed')
      children.add(ev.seq);
  }
  return {activities, timers, children};
}

/**
 * Markers whose completion has not arrived, in the order they were dispatched.
 * Order matters to `resume`: re-enqueuing in history order keeps the recovered
 * queue in the same shape the workflow built it in.
 */
export function pendingWork(history: HistoryEvent[]): PendingWork {
  const done = completedSeqs(history);
  const activities: ActivityScheduledEvent[] = [];
  const timers: TimerStartedEvent[] = [];
  const children: ChildStartedEvent[] = [];
  let cancelRequested = false;
  for (const ev of history) {
    if (ev.type === 'activityScheduled' && !done.activities.has(ev.seq))
      activities.push(ev);
    else if (ev.type === 'timerStarted' && !done.timers.has(ev.seq))
      timers.push(ev);
    else if (ev.type === 'childStarted' && !done.children.has(ev.seq))
      children.push(ev);
    else if (ev.type === 'cancelRequested') cancelRequested = true;
  }
  return {activities, timers, children, cancelRequested};
}

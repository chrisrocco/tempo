/**
 * @fileoverview
 * How an execution looks to someone asking about it from outside — the read model
 * behind `describeExecution` / `listExecutions`, and so behind `Client.describe()`
 * and `Client.list()`.
 *
 * It lives here, once, because both service implementations answer these
 * questions: `LocalService` in-process and `ServerHost` over RPC. Projecting in
 * each would be two chances to disagree about what "running" means.
 *
 * Everything is **derived, never stored**. Nothing here is written down and kept
 * up to date; each view is computed from the record and its history at the moment
 * it is asked for. A stored read model would be another thing to keep consistent
 * across crash recovery and continue-as-new, and it would be wrong exactly when it
 * mattered most — while an operator is trying to work out why an execution is
 * stuck.
 *
 * The projection is deliberately not the record itself. `ExecutionRecord` carries
 * a `version` that only means something to the optimistic CAS, and a `failure`
 * that is an arbitrary thrown value and need not survive JSON. Both are dropped;
 * the failure becomes a message.
 */

import {
  MAX_HISTORY_PAGE,
  type DescribeOptions,
  type ExecutionDetail,
  type ExecutionSummary,
} from '../protocol';
import {pendingWork} from './pending_work';
import type {ExecutionRecord} from './ports/history_store';
import {maxAttempts} from './retry_policy';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One line of `Client.list()`. */
export function summarizeExecution(rec: ExecutionRecord): ExecutionSummary {
  return {
    workflowId: rec.workflowId,
    runId: rec.runId,
    name: rec.name,
    status: rec.status,
    historyLength: rec.history.length,
    taskQueue: rec.taskQueue,
    createdAt: rec.createdAt,
    taskFailures: rec.taskFailures,
    lastTaskFailure: rec.lastTaskFailure,
  };
}

/**
 * The full view: the summary, the history, and what the execution is waiting on.
 * History is copied — a caller must not be able to mutate the store's array
 * through a view of it, and `MemoryHistoryStore` hands back live references.
 */
/**
 * Where a history page starts and ends.
 *
 * The default — the *last* page rather than the first — is the one decision
 * here. An execution long enough to need paging is long enough that its
 * beginning is rarely the interesting part: a wedged poller's useful events are
 * the most recent ones. Clamped rather than validated, because an offset past
 * the end is a caller paging off the end of a history that has since rolled
 * over, and the useful answer to that is an empty page rather than an error.
 */
function historyWindow(
  total: number,
  options: DescribeOptions,
): {offset: number; limit: number} {
  const limit = Math.min(options.limit ?? MAX_HISTORY_PAGE, MAX_HISTORY_PAGE);
  const offset = options.fromEvent ?? Math.max(0, total - limit); // default: the tail
  return {offset: Math.max(0, Math.min(offset, total)), limit};
}

export function describeExecution(
  rec: ExecutionRecord,
  options: DescribeOptions = {},
): ExecutionDetail {
  const {offset, limit} = historyWindow(rec.history.length, options);
  // Derived from the WHOLE history, never the page. What an execution is
  // waiting on is a fact about all of it: an activity scheduled at event 3 and
  // still unanswered at event 4000 is exactly the case an operator is looking
  // for, and a page-scoped derivation would report it as nothing pending.
  // **Only while it is running.** `pendingWork` is a pure derivation from history —
  // a `timerStarted` with no `timerFired` is pending — and history has no way to say
  // "and then the execution died". So a workflow cancelled while sleeping unwinds
  // through `CancelledFailure`, settles, and goes on reporting that timer as pending
  // forever: a settled execution that looks like it is still waiting on something.
  //
  // That was reported from a dashboard, where it reads as a leak. The engine is not
  // leaking — `onFire` drops a fire for a non-running record and `resumeFromHistory`
  // skips one on restart, and the timer itself is now released when an execution
  // settles (`server_core`) — but the *report* was wrong, and a wrong report about a
  // dead execution is the failure this repo keeps finding.
  //
  // Suppressed rather than relabelled. `pending` means the engine is waiting on this,
  // and for a settled execution it is not; anyone asking the different question of
  // what it was waiting on *when* it died still has the whole history, which is where
  // that answer honestly lives.
  const pending =
    rec.status === 'running'
      ? pendingWork(rec.history)
      : {
          activities: [],
          timers: [],
          children: [],
          // Kept, because it is a fact about what happened rather than about what is
          // outstanding: an operator reading a settled execution wants to know it was
          // cancelled rather than that it failed on its own.
          cancelRequested: pendingWork(rec.history).cancelRequested,
        };
  return {
    ...summarizeExecution(rec),
    props: rec.props,
    ...(rec.parent === undefined ? {} : {parent: rec.parent}),
    history: rec.history.slice(offset, offset + limit),
    historyOffset: offset,
    pending: {
      activities: pending.activities.map((e) => {
        // Absent means nothing has failed yet, which is the common case: the
        // entry is only written once an attempt fails, and cleared the moment
        // the activity settles.
        const retry = rec.activityAttempts[e.seq];
        return {
          seq: e.seq,
          name: e.name,
          attempt: (retry?.attempts ?? 0) + 1,
          maxAttempts: maxAttempts(e.options.retry),
          ...(retry?.lastError === undefined
            ? {}
            : {lastError: retry.lastError}),
          ...(retry?.nextAttemptAt === undefined
            ? {}
            : {nextAttemptAt: retry.nextAttemptAt}),
        };
      }),
      timers: pending.timers.map((e) => ({seq: e.seq, fireAt: e.fireAt})),
      children: pending.children.map((e) => ({
        seq: e.seq,
        childId: e.childId,
        detached: e.detached,
      })),
    },
    parked: rec.parked ?? [],
    cancelRequested: pending.cancelRequested,
    result: rec.status === 'completed' ? rec.result : undefined,
    failure:
      rec.status === 'failed' || rec.status === 'terminated'
        ? errorMessage(rec.failure)
        : undefined,
    carryover: rec.carryover,
    // Only for 'failed': a terminated execution's reason is an operator's
    // sentence, and there is no stack behind it to show.
    failureStack: rec.status === 'failed' ? rec.failureStack : undefined,
  };
}

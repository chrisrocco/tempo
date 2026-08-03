/**
 * @fileoverview
 * How an execution looks to someone asking about it from outside — the read model
 * behind `describeExecution` / `listExecutions`, and so behind `tempo describe`
 * and `tempo list`.
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

import type {ExecutionDetail, ExecutionSummary} from '../protocol';
import {pendingWork} from './pending_work';
import type {ExecutionRecord} from './ports/history_store';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One line of `tempo list`. */
export function summarizeExecution(rec: ExecutionRecord): ExecutionSummary {
  return {
    workflowId: rec.workflowId,
    runId: rec.runId,
    name: rec.name,
    status: rec.status,
    historyLength: rec.history.length,
    taskFailures: rec.taskFailures,
    lastTaskFailure: rec.lastTaskFailure,
  };
}

/**
 * The full view: the summary, the history, and what the execution is waiting on.
 * History is copied — a caller must not be able to mutate the store's array
 * through a view of it, and `MemoryHistoryStore` hands back live references.
 */
export function describeExecution(rec: ExecutionRecord): ExecutionDetail {
  const pending = pendingWork(rec.history);
  return {
    ...summarizeExecution(rec),
    args: rec.args,
    history: rec.history.slice(),
    pending: {
      activities: pending.activities.map((e) => ({seq: e.seq, name: e.name})),
      timers: pending.timers.map((e) => ({seq: e.seq, fireAt: e.fireAt})),
      children: pending.children.map((e) => ({
        seq: e.seq,
        childId: e.childId,
        detached: e.detached,
      })),
    },
    cancelRequested: pending.cancelRequested,
    result: rec.status === 'completed' ? rec.result : undefined,
    failure:
      rec.status === 'failed' || rec.status === 'terminated'
        ? errorMessage(rec.failure)
        : undefined,
  };
}

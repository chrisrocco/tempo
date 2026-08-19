/**
 * @fileoverview
 * Which closed executions a retention sweep may delete.
 *
 * Records grow without bound otherwise: `continueAsNew` caps one execution's
 * history, but nothing caps the number of executions, so a server that runs for
 * months holds every run it has ever finished. Temporal's answer is a time-based
 * retention sweep of closed executions, and — as `resetForContinueAsNew` already
 * notes — that is the mechanism this engine deferred rather than declined. This
 * module is its decision half: a pure function over the records, in the
 * `isStuck`/`isQueueServed` mold, so the rule is statable by a spec without a
 * clock or a store. `server_host` owns the clock, the cadence, and the deleting.
 *
 * ## Eligible means closed, aged out, and owed to nobody
 *
 * Running executions are never touched, however old — an execution that waits a
 * year on a signal is the product working. A terminal one is eligible once its
 * close is older than the caller's cutoff. Close time is `closedAt` where the
 * record has it; records from before the field existed fall back to the last
 * event's timestamp, then to `createdAt` — both err toward reading *older*,
 * which for a sweep is the honest direction: a record with no stamp has been
 * closed at least since the store last wrote it.
 *
 * The "owed to nobody" clause is the one correctness constraint. `resume()`
 * reconstructs a crashed server's bookkeeping partly from a settled child's own
 * record: a parent whose history lacks the child's outcome gets it synthesized
 * from that record on the next boot. Deleting such a child while its parent
 * still runs would leave the parent awaiting an outcome nothing can produce —
 * so a settled child is kept, past any cutoff, until its running parent's
 * history holds the `childCompleted`/`childFailed` for its seq, or the parent
 * itself closes or is gone.
 */

import type {ExecutionRecord} from './ports/history_store';

/**
 * When `rec` closed, as well as the record can say: the stamp, else the last
 * event's timestamp, else creation. Meaningless for a running record — callers
 * check `status` first.
 */
function closedAtOf(rec: ExecutionRecord): number {
  if (rec.closedAt !== undefined) return rec.closedAt;
  for (let i = rec.history.length - 1; i >= 0; i--) {
    const ts = rec.history[i]?.ts;
    if (ts !== undefined) return ts;
  }
  return rec.createdAt;
}

/** Does the parent's history already hold the outcome of the child at `seq`? */
function outcomeConsumed(parent: ExecutionRecord, seq: number): boolean {
  return parent.history.some(
    (e) =>
      (e.type === 'childCompleted' || e.type === 'childFailed') &&
      e.seq === seq,
  );
}

/**
 * The records a sweep may delete: terminal, closed at or before `cutoff`, and
 * not a child whose running parent has yet to consume its outcome.
 *
 * Judged against the full record set, because the parent clause is a relation:
 * a record is only unsweepable on account of a parent that is *present and
 * running*. A parent that is itself terminal, or already deleted, releases the
 * child — its outcome will never be asked for again.
 */
export function expiredExecutions(
  records: readonly ExecutionRecord[],
  cutoff: number,
): ExecutionRecord[] {
  const byId = new Map(records.map((rec) => [rec.workflowId, rec]));
  return records.filter((rec) => {
    if (rec.status === 'running') return false;
    if (closedAtOf(rec) > cutoff) return false;
    if (rec.parent === undefined) return true;
    const parent = byId.get(rec.parent.workflowId);
    if (parent === undefined || parent.status !== 'running') return true;
    return outcomeConsumed(parent, rec.parent.seq);
  });
}

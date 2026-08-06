/**
 * @fileoverview
 * Counting executions by status, grouped by task queue and by workflow name,
 * plus what is between retry attempts by activity — the query behind
 * `groupExecutions`.
 *
 * Separate from `execution_query.ts` because they answer different questions.
 * That module decides *which executions you get*; this one describes *the shape
 * of the whole set*. The distinction is not cosmetic: a paged listing cannot be
 * counted by its caller without the count being about the page rather than the
 * server, and being wrong by exactly the amount that matters once there is
 * enough data to need paging.
 *
 * ## Why the server does this and not the dashboard
 *
 * `listExecutions` caps at `MAX_PAGE_SIZE`. A client tallying what it received
 * would report "3 failed" when there are three hundred, and would report it
 * confidently. Grouping costs the same scan the listing already does — the
 * store is a Map or a directory, and both callers walk it — so moving the tally
 * to the server buys correctness for no extra work.
 *
 * ## The same limitation `execution_query` has, for the same reason
 *
 * This scans. It is the right shape for a store that is a Map or a directory
 * and the wrong one for a database, which should answer a `GROUP BY` instead.
 * A pure function over records is what makes that replaceable: the day the
 * store changes, this module is what gets rewritten rather than every caller.
 * Sorting is part of the contract for the same reason a listing's order is —
 * a dashboard polling every couple of seconds must not have its rows reshuffle
 * underneath the reader between two identical answers.
 */

import {
  isStuck,
  type ActivityRetryGroup,
  type ExecutionGroup,
  type ExecutionGroups,
} from '../protocol';
import {summarizeExecution} from './execution_view';
import type {ExecutionRecord} from './ports/history_store';
import type {ExecutionSummary} from '../protocol';

function emptyGroup(key: string): ExecutionGroup {
  return {
    key,
    total: 0,
    running: 0,
    completed: 0,
    failed: 0,
    terminated: 0,
    stuck: 0,
  };
}

function tally(
  groups: Map<string, ExecutionGroup>,
  key: string,
  execution: ExecutionSummary,
): void {
  let group = groups.get(key);
  if (!group) {
    group = emptyGroup(key);
    groups.set(key, group);
  }
  group.total++;
  group[execution.status]++;
  // Deliberately not `else`: a stuck execution is counted in both `running` and
  // `stuck`, because it is genuinely running. See `ExecutionGroup`.
  if (isStuck(execution)) group.stuck++;
}

/**
 * Most trouble first, then alphabetically.
 *
 * Ordered by what a reader is scanning for rather than by size: a queue with
 * one wedged execution is more interesting than one with four hundred healthy
 * ones, and sorting by `total` would bury it. The name is the final tiebreak so
 * the order is total — two groups with identical counts must not swap places
 * between two polls.
 */
function byTrouble(a: ExecutionGroup, b: ExecutionGroup): number {
  return (
    b.stuck - a.stuck ||
    b.failed - a.failed ||
    b.running - a.running ||
    b.total - a.total ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/**
 * Fold one execution's in-flight retries into the by-activity tally.
 *
 * Reads `activityAttempts`, which the record already carries, rather than
 * deriving anything from history. That is what keeps this an O(executions) scan:
 * resolving a `seq` to an activity name through `pendingWork` would make it
 * O(total events), on the one call a dashboard polls on a timer. The name is on
 * the retry state for this reason — see `ActivityRetryState.name`.
 *
 * An entry with no name is skipped rather than bucketed under a placeholder. It
 * means an attempt was recorded for a `seq` with no scheduling event in history,
 * which is a bug rather than a category, and inventing a row named "unknown"
 * would put it in the one view meant to be scanned for real trouble.
 */
function tallyRetries(
  groups: Map<string, ActivityRetryGroup>,
  record: ExecutionRecord,
): void {
  for (const state of Object.values(record.activityAttempts)) {
    if (state.name === undefined) continue;
    let group = groups.get(state.name);
    if (!group) {
      group = {name: state.name, retrying: 0, attempts: 0};
      groups.set(state.name, group);
    }
    group.retrying++;
    group.attempts += state.attempts;
    // Last one wins on the message, soonest wins on the time. Neither is
    // ordered by the scan, so both are reductions rather than assignments.
    if (state.lastError !== undefined) group.lastError = state.lastError;
    if (
      state.nextAttemptAt !== undefined &&
      (group.nextAttemptAt === undefined ||
        state.nextAttemptAt < group.nextAttemptAt)
    )
      group.nextAttemptAt = state.nextAttemptAt;
  }
}

/**
 * Most attempts burned first, then alphabetically.
 *
 * `attempts` leads rather than `retrying` because it measures wasted work
 * rather than headcount: one activity nine attempts deep has burned more, and
 * is closer to exhausting its budget, than five that have each failed once.
 *
 * It does **not** separate one activity on its ninth attempt from nine on their
 * first — those sum to the same burden, and `retrying` breaks that tie in
 * favour of the wider problem. Name is the final tiebreak so the order is
 * total, for the same reason `byTrouble` ends with one.
 */
function byRetryBurden(a: ActivityRetryGroup, b: ActivityRetryGroup): number {
  return (
    b.attempts - a.attempts ||
    b.retrying - a.retrying ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

export function groupExecutions(
  records: readonly ExecutionRecord[],
): ExecutionGroups {
  const byTaskQueue = new Map<string, ExecutionGroup>();
  const byName = new Map<string, ExecutionGroup>();
  const retrying = new Map<string, ActivityRetryGroup>();

  for (const record of records) {
    const execution = summarizeExecution(record);
    tally(byTaskQueue, execution.taskQueue, execution);
    tally(byName, execution.name, execution);
    tallyRetries(retrying, record);
  }

  return {
    byTaskQueue: [...byTaskQueue.values()].sort(byTrouble),
    byName: [...byName.values()].sort(byTrouble),
    retryingActivities: [...retrying.values()].sort(byRetryBurden),
  };
}

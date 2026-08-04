/**
 * @fileoverview
 * Counting executions by status, grouped by task queue and by workflow name —
 * the query behind `groupExecutions`.
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

import {isStuck, type ExecutionGroup, type ExecutionGroups} from '../protocol';
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

export function groupExecutions(
  records: readonly ExecutionRecord[],
): ExecutionGroups {
  const byTaskQueue = new Map<string, ExecutionGroup>();
  const byName = new Map<string, ExecutionGroup>();

  for (const record of records) {
    const execution = summarizeExecution(record);
    tally(byTaskQueue, execution.taskQueue, execution);
    tally(byName, execution.name, execution);
  }

  return {
    byTaskQueue: [...byTaskQueue.values()].sort(byTrouble),
    byName: [...byName.values()].sort(byTrouble),
  };
}

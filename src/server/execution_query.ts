/**
 * @fileoverview
 * Answering "which executions, and which page of them" — the query behind
 * `listExecutions`.
 *
 * Separate from `execution_view.ts` because they are different jobs. That module
 * decides *what one execution looks like* to an outsider; this one decides
 * *which ones you get*. Keeping them apart means the ordering rules below have a
 * home to be explained in, rather than being three conditions inside a host
 * method.
 *
 * ## Why the order is what it is
 *
 * Newest first, because that is the question a listing is usually asked.
 *
 * Tie-broken by `workflowId`, because a cursor is only meaningful over a **total**
 * order. Two executions created in the same millisecond are common — a fan-out
 * starts a dozen children at once — and under a partial order a cursor pointing
 * between them would either skip rows or repeat them, silently, and only under
 * load. `createdAt` alone is not enough, and neither is insertion order: the file
 * store rebuilds its cache from a directory read, whose order is not defined.
 *
 * ## Why filtering happens here rather than in the caller
 *
 * The caller most likely to want "just the broken ones" is a dashboard polling
 * every couple of seconds. Fetching every execution and discarding all but three
 * of them is the cost this whole interface exists to avoid, so `stuck` is a
 * filter rather than something applied to the result.
 */

import {
  MAX_PAGE_SIZE,
  isStuck,
  type ExecutionFilter,
  type ExecutionPage,
  type ExecutionSummary,
} from '../protocol';
import {summarizeExecution} from './execution_view';
import type {ExecutionRecord} from './ports/history_store';

/**
 * The sort key, as a string that sorts correctly.
 *
 * `createdAt` is padded so that string comparison agrees with numeric — without
 * it, `9` sorts after `10`, and a cursor built from one would land in the wrong
 * place for a couple of weeks every time the epoch gains a digit. 15 digits is
 * comfortably past the year 33000.
 */
function sortKey(execution: {createdAt: number; workflowId: string}): string {
  return `${String(execution.createdAt).padStart(15, '0')}|${execution.workflowId}`;
}

/** Does this execution match every field the filter names? */
function matches(
  execution: ExecutionSummary,
  filter: ExecutionFilter,
): boolean {
  if (filter.status !== undefined && execution.status !== filter.status)
    return false;
  if (filter.name !== undefined && execution.name !== filter.name) return false;
  if (
    filter.taskQueue !== undefined &&
    execution.taskQueue !== filter.taskQueue
  )
    return false;
  if (
    filter.workflowIdPrefix !== undefined &&
    !execution.workflowId.startsWith(filter.workflowIdPrefix)
  )
    return false;
  if (filter.stuck !== undefined && isStuck(execution) !== filter.stuck)
    return false;
  return true;
}

/**
 * Filter, order, and page a set of records.
 *
 * Takes every record rather than a store, so it stays a pure function over data
 * and can be tested without one. That is also its limitation, and an honest one:
 * this scans. It is the right shape for a server whose store is a Map or a
 * directory, and the wrong one for a database, which should push the same filter
 * into a query. The interface is what matters — `ExecutionFilter` is expressible
 * as SQL — so the day the store changes, this module is what gets replaced
 * rather than every caller.
 */
export function queryExecutions(
  records: readonly ExecutionRecord[],
  filter: ExecutionFilter = {},
): ExecutionPage {
  const ordered = records
    .map(summarizeExecution)
    .filter((execution) => matches(execution, filter))
    // Descending: the string keys compare correctly, so this is a plain reverse
    // lexicographic sort rather than two comparisons.
    .sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : -1));

  // The cursor is the key of the last row already delivered, so resuming means
  // dropping everything at or above it. Strictly less-than, or a page boundary
  // would repeat its own last row.
  const after = filter.cursor;
  const remaining =
    after === undefined
      ? ordered
      : ordered.filter((execution) => sortKey(execution) < after);

  const limit = Math.min(filter.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const executions = remaining.slice(0, limit);

  // A cursor only when there is genuinely more: handing one back on the last
  // page makes a caller fetch an empty page to discover it is finished.
  const nextCursor =
    remaining.length > executions.length
      ? sortKey(executions[executions.length - 1]!)
      : undefined;

  return {executions, nextCursor};
}

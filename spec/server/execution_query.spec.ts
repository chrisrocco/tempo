/**
 * @fileoverview
 * Filtering, ordering, and paging a listing.
 *
 * The filters are the easy half. The paging is where the bugs live, and they are
 * the kind that only appear at a page boundary under load: a cursor over a
 * partial order silently skips rows or repeats them, and a `createdAt` compared
 * as a string rather than a number puts everything in the wrong place for a
 * fortnight each time the epoch gains a digit.
 *
 * So the tests that matter are the ones that walk every page and check the whole
 * set came back exactly once — not the ones that fetch one page and eyeball it.
 */

import {queryExecutions} from '../../src/server';
import type {ExecutionRecord} from '../../src/server';
import type {ExecutionFilter, ExecutionStatus} from '../../src/protocol';

/** A record with only the fields a listing reads. */
function record(
  workflowId: string,
  overrides: Partial<ExecutionRecord> = {},
): ExecutionRecord {
  return {
    workflowId,
    runId: 0,
    name: 'greeter',
    args: [],
    taskQueue: 'default',
    createdAt: 1_000,
    history: [],
    version: 0,
    status: 'running' as ExecutionStatus,
    carryover: {},
    taskFailures: 0,
    activityAttempts: {},
    ...overrides,
  };
}

/** Every page, walked to exhaustion — what a paging caller actually does. */
function drain(
  records: readonly ExecutionRecord[],
  filter: ExecutionFilter,
): string[] {
  const seen: string[] = [];
  let cursor: string | undefined;
  // Bounded so a cursor that fails to advance fails the test instead of hanging.
  for (let page = 0; page < 50; page++) {
    const result = queryExecutions(records, {...filter, cursor});
    seen.push(...result.executions.map((e) => e.workflowId));
    if (result.nextCursor === undefined) return seen;
    cursor = result.nextCursor;
  }
  throw new Error('cursor never reached the end');
}

describe('queryExecutions — filtering', () => {
  const records = [
    record('a', {status: 'completed', name: 'greeter', taskQueue: 'default'}),
    record('b', {status: 'running', name: 'poller', taskQueue: 'agents'}),
    record('c', {status: 'running', name: 'poller', taskFailures: 3}),
  ];

  function ids(filter: ExecutionFilter): string[] {
    return queryExecutions(records, filter).executions.map((e) => e.workflowId);
  }

  it('returns everything when nothing is asked for', () => {
    expect(ids({}).sort()).toEqual(['a', 'b', 'c']);
  });

  it('narrows by status, name, and queue', () => {
    expect(ids({status: 'completed'})).toEqual(['a']);
    expect(ids({name: 'poller'}).sort()).toEqual(['b', 'c']);
    expect(ids({taskQueue: 'agents'})).toEqual(['b']);
  });

  it('narrows by workflow id prefix, for the search box', () => {
    expect(ids({workflowIdPrefix: 'a'})).toEqual(['a']);
    expect(ids({workflowIdPrefix: 'zzz'})).toEqual([]);
  });

  /**
   * The filter that justifies filtering server-side at all: without it, finding
   * the one broken execution means fetching all of them.
   */
  it('narrows to stuck executions', () => {
    expect(ids({stuck: true})).toEqual(['c']);
  });

  // Not the same as omitting it — `stuck: false` means "only the healthy ones".
  it('can ask for the not-stuck ones', () => {
    expect(ids({stuck: false}).sort()).toEqual(['a', 'b']);
  });

  it('applies every named field together', () => {
    expect(ids({status: 'running', name: 'poller', stuck: true})).toEqual([
      'c',
    ]);
  });
});

describe('queryExecutions — the time range', () => {
  const records = [
    record('t1000', {createdAt: 1_000}),
    record('t2000', {createdAt: 2_000}),
    record('t3000', {createdAt: 3_000}),
  ];

  function ids(filter: ExecutionFilter): string[] {
    return queryExecutions(records, filter).executions.map((e) => e.workflowId);
  }

  it('narrows to executions created at or after a lower bound', () => {
    expect(ids({createdAfter: 2_000})).toEqual(['t3000', 't2000']);
  });

  it('narrows to executions created strictly before an upper bound', () => {
    expect(ids({createdBefore: 3_000})).toEqual(['t2000', 't1000']);
  });

  it('narrows to a window when given both ends', () => {
    expect(ids({createdAfter: 2_000, createdBefore: 3_000})).toEqual(['t2000']);
  });

  /**
   * The half-open interval, which is the whole reason the two ends differ.
   * Adjacent windows have to tile: an execution created exactly on the join
   * belongs to the later one and to only one of them, or a reader paging
   * through consecutive hours sees it twice.
   */
  it('puts an execution created exactly on a boundary in the later window', () => {
    expect(ids({createdAfter: 1_000, createdBefore: 2_000})).toEqual(['t1000']);
    expect(ids({createdAfter: 2_000, createdBefore: 3_000})).toEqual(['t2000']);
  });

  it('returns nothing for a window that ends before it starts', () => {
    expect(ids({createdAfter: 3_000, createdBefore: 1_000})).toEqual([]);
  });

  it('combines the range with the other filters rather than replacing them', () => {
    const mixed = [
      record('recent-ok', {createdAt: 3_000, status: 'completed'}),
      record('recent-bad', {createdAt: 3_000, status: 'failed'}),
      record('old-bad', {createdAt: 1_000, status: 'failed'}),
    ];
    const page = queryExecutions(mixed, {
      status: 'failed',
      createdAfter: 2_000,
    });
    expect(page.executions.map((e) => e.workflowId)).toEqual(['recent-bad']);
  });
});

describe('queryExecutions — ordering', () => {
  it('returns newest first', () => {
    const records = [
      record('old', {createdAt: 1_000}),
      record('new', {createdAt: 3_000}),
      record('mid', {createdAt: 2_000}),
    ];

    expect(queryExecutions(records, {}).executions.map((e) => e.workflowId)) //
      .toEqual(['new', 'mid', 'old']);
  });

  /**
   * `createdAt` is a number but the sort key is a string, so it is padded. Without
   * that, `900` sorts after `1000` — and since epoch milliseconds gain a digit
   * every so often, this would be correct in testing and wrong in production.
   */
  it('orders by time numerically, not lexicographically', () => {
    const records = [
      record('shorter', {createdAt: 900}),
      record('longer', {createdAt: 1_000}),
    ];

    expect(queryExecutions(records, {}).executions.map((e) => e.workflowId)) //
      .toEqual(['longer', 'shorter']);
  });

  /**
   * A fan-out starts a dozen children in the same millisecond, so ties are the
   * normal case rather than an edge one. Without a tie-break the order between
   * them is whatever the input happened to be, and a cursor pointing into the
   * middle of a tie cannot be honoured.
   */
  it('breaks ties deterministically, whatever order the records arrive in', () => {
    const tied = ['c', 'a', 'b'].map((id) => record(id, {createdAt: 5_000}));
    const shuffled = ['b', 'c', 'a'].map((id) =>
      record(id, {createdAt: 5_000}),
    );

    const one = queryExecutions(tied, {}).executions.map((e) => e.workflowId);
    const other = queryExecutions(shuffled, {}).executions.map(
      (e) => e.workflowId,
    );

    expect(one).toEqual(other);
  });
});

describe('queryExecutions — paging', () => {
  const records = Array.from({length: 25}, (_, i) =>
    record(`wf-${String(i).padStart(2, '0')}`, {createdAt: 1_000 + i}),
  );

  it('returns at most the requested page size', () => {
    expect(queryExecutions(records, {limit: 10}).executions.length).toBe(10);
  });

  it('offers a cursor while there is more, and none at the end', () => {
    expect(queryExecutions(records, {limit: 10}).nextCursor).toBeDefined();
    expect(queryExecutions(records, {limit: 100}).nextCursor).toBeUndefined();
  });

  /**
   * The property paging exists for, and the one a boundary bug breaks: every
   * execution appears exactly once across the pages, none is skipped, and none
   * is repeated.
   */
  it('walks every execution exactly once', () => {
    const seen = drain(records, {limit: 7});

    expect(seen.length).toBe(25);
    expect(new Set(seen).size).toBe(25);
  });

  // Ties are where an off-by-one in the cursor comparison shows up: with `<=`
  // instead of `<`, a page boundary landing inside a tie loses a row.
  it('walks every execution exactly once when they share a timestamp', () => {
    const tied = Array.from({length: 12}, (_, i) =>
      record(`same-${String(i).padStart(2, '0')}`, {createdAt: 7_000}),
    );

    const seen = drain(tied, {limit: 5});

    expect(seen.length).toBe(12);
    expect(new Set(seen).size).toBe(12);
  });

  it('keeps the filter applied across pages', () => {
    const mixed = [
      ...records,
      ...Array.from({length: 5}, (_, i) =>
        record(`other-${i}`, {name: 'other', createdAt: 2_000 + i}),
      ),
    ];

    const seen = drain(mixed, {name: 'other', limit: 2});

    expect(seen.length).toBe(5);
    expect(seen.every((id) => id.startsWith('other-'))).toBeTrue();
  });

  /**
   * The cap is a ceiling, not a default — a caller asking for everything is
   * exactly the one it exists to restrain.
   */
  it('caps an over-large limit rather than honouring it', () => {
    const many = Array.from({length: 300}, (_, i) =>
      record(`m-${String(i).padStart(3, '0')}`, {createdAt: 1_000 + i}),
    );

    const page = queryExecutions(many, {limit: 10_000});

    expect(page.executions.length).toBe(200);
    expect(page.nextCursor).toBeDefined();
  });
});

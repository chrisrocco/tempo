/**
 * @fileoverview
 * Counting executions by status, grouped by queue and by workflow name.
 *
 * Two properties carry the weight here, and both are ways the numbers could be
 * quietly wrong rather than obviously broken:
 *
 * 1. **`stuck` overlaps `running`.** A wedged execution is genuinely running,
 *    so the four statuses sum to `total` and `stuck` does not. Counting it as a
 *    fifth disjoint bucket would make the columns stop adding up; leaving it out
 *    of `running` would make a queue look idle when it is jammed.
 * 2. **The order is total.** A dashboard polls this every couple of seconds, so
 *    two identical answers must produce identical row orders. A comparator that
 *    left ties unbroken would reshuffle rows under the reader's cursor.
 */

import {groupExecutions} from '../../src/server';
import type {ExecutionRecord} from '../../src/server';
import type {ExecutionGroup} from '../../src/protocol';

let created = 0;

/** A record with only the fields the grouping reads. */
function record(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    workflowId: `wf-${++created}`,
    runId: 0,
    name: 'greeter',
    args: [],
    taskQueue: 'default',
    createdAt: created,
    history: [],
    version: 1,
    status: 'running',
    taskFailures: 0,
    activityAttempts: {},
    ...over,
  } as ExecutionRecord;
}

function group(groups: ExecutionGroup[], key: string): ExecutionGroup {
  const found = groups.find((g) => g.key === key);
  if (!found) throw new Error(`no group ${key}`);
  return found;
}

describe('execution groups — counting', () => {
  it('counts each status into its own column', () => {
    const {byTaskQueue} = groupExecutions([
      record({status: 'running'}),
      record({status: 'completed'}),
      record({status: 'failed'}),
      record({status: 'terminated'}),
    ]);

    expect(group(byTaskQueue, 'default')).toEqual({
      key: 'default',
      total: 4,
      running: 1,
      completed: 1,
      failed: 1,
      terminated: 1,
      stuck: 0,
    });
  });

  it('counts a wedged execution as both running and stuck', () => {
    // It really is running — the engine is retrying it on a backoff. Moving it
    // out of `running` would make a jammed queue read as an idle one.
    const {byTaskQueue} = groupExecutions([
      record({status: 'running', taskFailures: 3}),
    ]);
    const g = group(byTaskQueue, 'default');

    expect(g.running).toBe(1);
    expect(g.stuck).toBe(1);
    expect(g.running + g.completed + g.failed + g.terminated).toBe(g.total);
  });

  it('does not count a settled execution as stuck, however it ended', () => {
    // `taskFailures` survives on the record after an operator terminates a
    // wedged execution; only `running` ones are stuck (see `isStuck`).
    const {byTaskQueue} = groupExecutions([
      record({status: 'terminated', taskFailures: 6}),
      record({status: 'failed', taskFailures: 2}),
    ]);

    expect(group(byTaskQueue, 'default').stuck).toBe(0);
  });

  it('groups by task queue and by name in one pass', () => {
    const {byTaskQueue, byName} = groupExecutions([
      record({taskQueue: 'email', name: 'send'}),
      record({taskQueue: 'email', name: 'digest'}),
      record({taskQueue: 'billing', name: 'send'}),
    ]);

    expect(group(byTaskQueue, 'email').total).toBe(2);
    expect(group(byTaskQueue, 'billing').total).toBe(1);
    expect(group(byName, 'send').total).toBe(2);
    expect(group(byName, 'digest').total).toBe(1);
  });

  it('reports nothing for an empty server rather than an empty group', () => {
    expect(groupExecutions([])).toEqual({
      byTaskQueue: [],
      byName: [],
      retryingActivities: [],
    });
  });
});

describe('execution groups — ordering', () => {
  it('puts the queue with stuck executions first, however small it is', () => {
    const records = [
      ...Array.from({length: 20}, () => record({taskQueue: 'busy'})),
      record({taskQueue: 'jammed', status: 'running', taskFailures: 1}),
    ];

    const {byTaskQueue} = groupExecutions(records);

    expect(byTaskQueue[0]!.key).toBe('jammed');
  });

  it('ranks failures above merely-large when nothing is stuck', () => {
    const records = [
      ...Array.from({length: 20}, () => record({taskQueue: 'busy'})),
      record({taskQueue: 'broken', status: 'failed'}),
    ];

    const {byTaskQueue} = groupExecutions(records);

    expect(byTaskQueue[0]!.key).toBe('broken');
  });

  it('breaks a tie by name, so two polls cannot disagree about the order', () => {
    const {byTaskQueue} = groupExecutions([
      record({taskQueue: 'zebra'}),
      record({taskQueue: 'alpha'}),
      record({taskQueue: 'mango'}),
    ]);

    expect(byTaskQueue.map((g) => g.key)).toEqual(['alpha', 'mango', 'zebra']);
  });
});

/**
 * What is between retry attempts, grouped by activity name.
 *
 * The property worth pinning is what this deliberately does *not* count. It
 * reads `activityAttempts`, which the engine clears the moment an activity
 * settles — so a flaky activity that eventually succeeds vanishes from here
 * entirely, and nothing in history would have let it be counted either. A
 * reader who assumes these are cumulative failure totals is reading the wrong
 * number, which is why `ActivityRetryGroup` says so, and why anything
 * rendering it should say "right now" in the heading.
 */
describe('execution groups — activities retrying now', () => {
  function retrying(
    attempts: Record<
      number,
      {
        name?: string;
        attempts: number;
        lastError?: string;
        nextAttemptAt?: number;
      }
    >,
  ): ExecutionRecord {
    return record({activityAttempts: attempts} as Partial<ExecutionRecord>);
  }

  it('reports nothing when no activity is between attempts', () => {
    expect(groupExecutions([record()]).retryingActivities).toEqual([]);
  });

  it('groups retries by activity name across executions', () => {
    const groups = groupExecutions([
      retrying({0: {name: 'charge', attempts: 2}}),
      retrying({0: {name: 'charge', attempts: 3}}),
      retrying({0: {name: 'notify', attempts: 1}}),
    ]).retryingActivities;

    expect(groups.map((g) => [g.name, g.retrying, g.attempts])).toEqual([
      ['charge', 2, 5],
      ['notify', 1, 1],
    ]);
  });

  it('counts several retrying activities within one execution', () => {
    const groups = groupExecutions([
      retrying({
        0: {name: 'charge', attempts: 1},
        1: {name: 'charge', attempts: 1},
      }),
    ]).retryingActivities;

    expect(groups).toEqual([{name: 'charge', retrying: 2, attempts: 2}]);
  });

  /**
   * Attempts, not instances. One activity nine attempts deep has burned more
   * work — and is closer to exhausting its budget — than five that have each
   * failed once, so it leads despite fewer of them retrying.
   */
  it('orders by attempts burned rather than by how many are retrying', () => {
    const several = Array.from({length: 5}, () =>
      retrying({0: {name: 'notify', attempts: 1}}),
    );
    const groups = groupExecutions([
      ...several,
      retrying({0: {name: 'charge', attempts: 9}}),
    ]).retryingActivities;

    expect(groups.map((g) => [g.name, g.retrying, g.attempts])).toEqual([
      ['charge', 1, 9],
      ['notify', 5, 5],
    ]);
  });

  /**
   * The tie the ordering comment must not claim to break: nine activities on
   * their first attempt and one on its ninth have burned the same work, so
   * `attempts` cannot separate them and `retrying` decides.
   */
  it('falls back to how many are retrying when the burden is equal', () => {
    const many = Array.from({length: 9}, () =>
      retrying({0: {name: 'notify', attempts: 1}}),
    );
    const groups = groupExecutions([
      ...many,
      retrying({0: {name: 'charge', attempts: 9}}),
    ]).retryingActivities;

    expect(groups.map((g) => g.name)).toEqual(['notify', 'charge']);
  });

  it('orders ties by name, so two polls cannot reshuffle the rows', () => {
    const groups = groupExecutions([
      retrying({0: {name: 'zeta', attempts: 1}}),
      retrying({0: {name: 'alpha', attempts: 1}}),
    ]).retryingActivities;

    expect(groups.map((g) => g.name)).toEqual(['alpha', 'zeta']);
  });

  it('reports the soonest next attempt among the group, not the last seen', () => {
    const groups = groupExecutions([
      retrying({0: {name: 'charge', attempts: 1, nextAttemptAt: 5_000}}),
      retrying({0: {name: 'charge', attempts: 1, nextAttemptAt: 2_000}}),
      retrying({0: {name: 'charge', attempts: 1, nextAttemptAt: 9_000}}),
    ]).retryingActivities;

    expect(groups[0]!.nextAttemptAt).toBe(2_000);
  });

  it('leaves the next attempt unknown when none has been scheduled', () => {
    const groups = groupExecutions([
      retrying({0: {name: 'charge', attempts: 1}}),
    ]).retryingActivities;

    expect(groups[0]!.nextAttemptAt).toBeUndefined();
  });

  it('carries a failure message so a reader need not open an execution', () => {
    const groups = groupExecutions([
      retrying({
        0: {name: 'charge', attempts: 1, lastError: 'gateway declined'},
      }),
    ]).retryingActivities;

    expect(groups[0]!.lastError).toBe('gateway declined');
  });

  /**
   * An attempt recorded against a seq with no scheduling event is a bug, not a
   * category. A row named "unknown" in the one view meant to be scanned for
   * real trouble is worse than no row.
   */
  it('skips an attempt whose activity cannot be named', () => {
    expect(
      groupExecutions([retrying({0: {attempts: 4}})]).retryingActivities,
    ).toEqual([]);
  });
});

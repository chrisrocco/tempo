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
    expect(groupExecutions([])).toEqual({byTaskQueue: [], byName: []});
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

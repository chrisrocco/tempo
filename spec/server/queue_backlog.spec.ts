/**
 * @fileoverview
 * How much work is waiting, and on which pool.
 *
 * The question `listQueues` could not answer. Its two poll timestamps say
 * whether anything has *asked* for work, and an operator arriving at a quiet
 * dashboard needs the other half: a pool with no recent poll and nothing waiting
 * is idle and fine, and a pool with no recent poll and a hundred tasks waiting is
 * an outage. Both read identically without a backlog count.
 *
 * Two layers, because the interesting failures live in different places:
 *
 * - **The queues themselves** — what counts as waiting. A task a worker holds is
 *   being worked; a task whose lease has lapsed is waiting again even though
 *   nothing has swept it back yet, and on an unpolled pool nothing ever will.
 * - **The assembly in `server_core`** — which rows come back. The worst case is
 *   a pool with work and no workers, which the registry cannot produce at all:
 *   it only knows pools something has polled.
 */

import 'jasmine';
import {ANY_TASK_QUEUE, type ActivityTask} from '../../src/protocol';
import {MemoryTaskQueue, MemoryWorkflowTaskQueue} from '../../src/server';
import {createServerHost} from '../../src/services';

/** An activity task; only its routing matters to a count. */
function task(seq: number): ActivityTask {
  return {
    workflowId: 'wf-1',
    seq,
    name: 'greet',
    args: [],
    options: {},
  };
}

describe('activity backlog — what counts as waiting', () => {
  it('counts queued tasks against the pool they were routed to', () => {
    const queue = new MemoryTaskQueue();

    queue.enqueue(task(1), 'email');
    queue.enqueue(task(2), 'email');
    queue.enqueue(task(3), 'billing');

    expect([...queue.backlog()]).toEqual([
      ['email', 2],
      ['billing', 1],
    ]);
  });

  it('omits pools with nothing waiting rather than reporting a zero', () => {
    // The keys are then "pools that have work", which is what lets the caller
    // discover a pool nothing has ever polled. A zero entry would be a pool that
    // exists in the report and has nothing to say.
    const queue = new MemoryTaskQueue();

    expect([...queue.backlog()]).toEqual([]);

    queue.enqueue(task(1), 'email');
    queue.poll('email', 'w1');

    expect([...queue.backlog()]).toEqual([]);
  });

  it('does not count a task a worker is holding', () => {
    const queue = new MemoryTaskQueue();
    queue.enqueue(task(1), 'email');
    queue.enqueue(task(2), 'email');

    queue.poll('email', 'w1@host');

    // Being worked is not waiting. `leaseHolders` is what reports the other one,
    // and counting it here would make a pool look behind while it is keeping up.
    expect(queue.backlog().get('email')).toBe(1);
  });

  it('counts a task whose lease has lapsed, because it is going back out', () => {
    // A zero-length lease is expired the instant it is taken — the same state a
    // crashed worker leaves behind, without waiting for one.
    const queue = new MemoryTaskQueue(0);
    queue.enqueue(task(1), 'email');
    queue.poll('email', 'w1@host');

    // Expired leases are only swept on the next poll, and on a pool nobody is
    // polling that poll never comes. Reporting this as in-flight would hide work
    // that is waiting, on exactly the pool where it matters most.
    expect(queue.backlog().get('email')).toBe(1);
  });

  it('does not redeliver anything just because it was asked', () => {
    const queue = new MemoryTaskQueue(0);
    queue.enqueue(task(1), 'email');
    queue.poll('email', 'w1@host');

    queue.backlog();
    queue.backlog();

    // Counting must not be the thing that reclaims a lease: two reads in a row
    // have to agree, and a caller polling a dashboard does this every second.
    expect(queue.backlog().get('email')).toBe(1);
    expect(queue.poll('email', 'w2@host')).toBeDefined();
  });
});

describe('workflow backlog — what counts as waiting', () => {
  it('counts executions against the pool they were routed to', () => {
    const queue = new MemoryWorkflowTaskQueue();

    queue.enqueue('wf-1', 'email');
    queue.enqueue('wf-2', 'email');
    queue.enqueue('wf-3', 'billing');

    expect(queue.backlog().get('email')).toBe(2);
    expect(queue.backlog().get('billing')).toBe(1);
  });

  it('counts an unrouted execution on the default pool', () => {
    // The same resolution `poll` uses. If these two disagreed, the count would
    // describe a pool the task would never be served from.
    const queue = new MemoryWorkflowTaskQueue();

    queue.enqueue('wf-1');

    expect(queue.backlog().get('default')).toBe(1);
  });

  it('counts an execution once however many times it was woken', () => {
    // The queue coalesces: a signal, a timer, and a completion arriving together
    // produce one task. Counting wakes would report a queue three deep that is
    // one execution doing exactly what it should.
    const queue = new MemoryWorkflowTaskQueue();

    queue.enqueue('wf-1', 'email');
    queue.enqueue('wf-1', 'email');
    queue.enqueue('wf-1', 'email');

    expect(queue.backlog().get('email')).toBe(1);
  });

  it('does not count a re-run queued behind an in-flight task', () => {
    const queue = new MemoryWorkflowTaskQueue();
    queue.enqueue('wf-1', 'email');
    queue.poll('email', 'w1@host');

    // A wake that arrives mid-task; it will re-enqueue when the task acks.
    queue.enqueue('wf-1', 'email');

    // In flight, not waiting. The re-run is a consequence of the task that is
    // already running rather than a queue depth.
    expect([...queue.backlog()]).toEqual([]);
  });
});

describe('listQueues — the pool nobody is serving', () => {
  it('reports a row for a pool with work and no workers', async () => {
    const host = createServerHost();

    await host.start('greeter', [], {taskQueue: 'email'});

    // The row the registry cannot produce: it only knows pools something has
    // polled, so before this a pool with work and no worker was absent from the
    // one report whose job is to explain a queue nobody is serving.
    const [row] = await host.listQueues();
    expect(row?.taskQueue).toBe('email');
    expect(row?.workers).toEqual([]);
    expect(row?.workflowPolledAt).toBeUndefined();
    expect(row?.pendingWorkflowTasks).toBe(1);
  });

  it('reports the backlog beside the workers once a pool is polled', async () => {
    const host = createServerHost();
    await host.start('greeter', [], {taskQueue: 'email'});
    await host.start('greeter', [], {taskQueue: 'email'});

    await host.pollWorkflowTask({taskQueue: 'email', identity: 'w1@host'});

    const [row] = await host.listQueues();
    // One claimed, one still waiting — the reading that separates "behind" from
    // "unserved", which neither the timestamps nor the worker rows can give.
    expect(row?.pendingWorkflowTasks).toBe(1);
    expect(row?.workers.map((w) => w.identity)).toEqual(['w1@host']);
  });

  it('does not attribute a backlog to the wildcard row', async () => {
    const host = createServerHost();
    await host.start('greeter', [], {taskQueue: 'email'});

    // A worker polling every pool, which the registry files under `*`.
    await host.pollWorkflowTask({identity: 'w1@host'});

    const queues = await host.listQueues();
    const wildcard = queues.find((q) => q.taskQueue === ANY_TASK_QUEUE);
    // `*` is workers that serve every pool, not a pool anything is enqueued to.
    // Reporting a total here would double-count the same tasks against the named
    // rows, so a caller summing the rows would see twice the work that exists.
    expect(wildcard?.pendingWorkflowTasks).toBe(0);
  });

  it('reports nothing waiting once the work is claimed', async () => {
    const host = createServerHost();
    await host.start('greeter', [], {taskQueue: 'email'});

    await host.pollWorkflowTask({taskQueue: 'email', identity: 'w1@host'});

    const [row] = await host.listQueues();
    expect(row?.pendingWorkflowTasks).toBe(0);
    expect(row?.pendingActivities).toBe(0);
  });
});

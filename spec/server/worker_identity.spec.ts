/**
 * @fileoverview
 * Naming the fleet: which worker asked, and whether a quiet one is busy or
 * gone.
 *
 * The registry chapter next door covers *queues* being polled. This one covers
 * the thing identity-on-poll was added to make possible, and the properties
 * that carry the weight are the ones where a row should not appear, or should
 * not appear twice:
 *
 * 1. **A busy worker still serves its queue.** The activity loop is sequential,
 *    so a worker inside a long activity stops polling and goes stale. Before
 *    the lease join it was indistinguishable from one that died, and the pill
 *    had to hedge. Holding a lease is the evidence that separates them.
 * 2. **An anonymous poll names nobody.** `createLocalRuntime` and any
 *    hand-rolled client poll without an identity. That still proves something
 *    is alive, so the aggregate must move — but inventing a row for it would
 *    put a nameless entry in the table whose whole job is naming.
 */

import {
  ANY_TASK_QUEUE,
  QUEUE_STALE_MS,
  isQueueServed,
  workersServing,
  type QueueLiveness,
  type WorkerInfo,
  type WorkerRole,
} from '../../src/protocol';
import {createWorkerRegistry} from '../../src/server';
// Deep, like `retry_policy.spec.ts`: the lease table is an internal the memory
// adapters are built from, not part of what `server/` offers outward.
import {LeaseTable} from '../../src/server/lease';
import {createServerHost} from '../../src/services';

function worker(identity: string, over: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    identity,
    role: 'activity',
    taskQueue: 'email',
    lastPolledAt: 1_000,
    busy: false,
    ...over,
  };
}

describe('worker identity — naming workers', () => {
  it('records a worker row for an identified poll', () => {
    const registry = createWorkerRegistry(() => 1_000);

    registry.recordPoll('workflow', 'email', 'w1@host');

    expect(registry.queues()[0]!.workers).toEqual([
      {
        identity: 'w1@host',
        role: 'workflow',
        taskQueue: 'email',
        lastPolledAt: 1_000,
      },
    ]);
  });

  it('moves the aggregate but names no worker when a poll is anonymous', () => {
    const registry = createWorkerRegistry(() => 1_000);

    registry.recordPoll('workflow', 'email');

    expect(registry.queues()).toEqual([
      {taskQueue: 'email', workflowPolledAt: 1_000, workers: []},
    ]);
  });

  it('counts one worker once however often it polls', () => {
    let now = 1_000;
    const registry = createWorkerRegistry(() => now);

    registry.recordPoll('activity', 'email', 'w1@host');
    now = 2_000;
    registry.recordPoll('activity', 'email', 'w1@host');

    const {workers} = registry.queues()[0]!;
    expect(workers.length).toBe(1);
    expect(workers[0]!.lastPolledAt).toBe(2_000);
  });

  /**
   * One process running both loops is two rows. They poll and fail
   * independently, and a worker whose activity loop is wedged while its
   * workflow loop is healthy is a real state a merged row would hide.
   */
  it('gives a process running both loops a row per role', () => {
    const registry = createWorkerRegistry(() => 1_000);

    registry.recordPoll('workflow', 'email', 'w1@host');
    registry.recordPoll('activity', 'email', 'w1@host');

    expect(
      registry
        .queues()[0]!
        .workers.map((w) => w.role)
        .sort(),
    ).toEqual(['activity', 'workflow']);
  });

  it('keeps two workers on one queue apart', () => {
    const registry = createWorkerRegistry(() => 1_000);

    registry.recordPoll('activity', 'email', 'w1@host');
    registry.recordPoll('activity', 'email', 'w2@host');

    expect(registry.queues()[0]!.workers.length).toBe(2);
  });

  // Whether a worker holds a lease is `server_core`'s join to make; this table
  // watches polls and nothing else. It used to report `busy: false` — honest but
  // still an assertion it had not observed — and now does not carry the field at
  // all, so a caller cannot read a claim that was never made. `ObservedWorker`
  // is what enforces that; this case is what says why.
  it('does not report whether a worker is busy, because it cannot know', () => {
    const registry = createWorkerRegistry(() => 1_000);

    registry.recordPoll('activity', 'email', 'w1@host');

    expect('busy' in registry.queues()[0]!.workers[0]!).toBeFalse();
  });

  it('orders workers by most recent poll, breaking ties by identity', () => {
    let now = 1_000;
    const registry = createWorkerRegistry(() => now);

    registry.recordPoll('activity', 'email', 'zeta@host');
    registry.recordPoll('activity', 'email', 'alpha@host');
    now = 5_000;
    registry.recordPoll('activity', 'email', 'newest@host');

    expect(registry.queues()[0]!.workers.map((w) => w.identity)).toEqual([
      'newest@host',
      'alpha@host',
      'zeta@host',
    ]);
  });

  it('does not leak a worker from one queue into another', () => {
    const registry = createWorkerRegistry(() => 1_000);

    registry.recordPoll('activity', 'email', 'w1@host');
    registry.recordPoll('activity', 'billing', 'w2@host');

    const queues = registry.queues();
    expect(queues.find((q) => q.taskQueue === 'email')!.workers.length).toBe(1);
    expect(
      queues.find((q) => q.taskQueue === 'billing')!.workers[0]!.identity,
    ).toBe('w2@host');
  });

  /**
   * The key is built from role and identity together. An identity containing
   * the separator must not be able to collide with another worker's row —
   * which is why both halves are kept on the value rather than parsed back out.
   */
  it('keeps workers apart when an identity contains the key separator', () => {
    const registry = createWorkerRegistry(() => 1_000);

    registry.recordPoll('activity', 'email', 'workflow w1@host');
    registry.recordPoll('activity', 'email', 'w1@host');

    expect(
      registry
        .queues()[0]!
        .workers.map((w) => w.identity)
        .sort(),
    ).toEqual(['w1@host', 'workflow w1@host']);
  });
});

describe('worker identity — a lease says who is holding it', () => {
  it('reports the identity that took a lease', () => {
    const leases = new LeaseTable<string>('t');

    leases.lease('task-1', 60_000, 'w1@host');

    expect([...leases.holders()]).toEqual(['w1@host']);
  });

  it('reports nothing for a lease taken without an identity', () => {
    const leases = new LeaseTable<string>('t');

    leases.lease('task-1', 60_000);

    expect(leases.holders().size).toBe(0);
  });

  it('forgets a holder once its lease is acked', () => {
    const leases = new LeaseTable<string>('t');

    const token = leases.lease('task-1', 60_000, 'w1@host');
    leases.ack(token);

    expect(leases.holders().size).toBe(0);
  });

  /**
   * The case that would otherwise let a dead worker vouch for itself forever.
   * Expired leases are only swept on the next poll, and on an idle queue
   * nothing polls — so `holders` has to filter by deadline rather than trust
   * the table.
   */
  it('stops reporting a holder whose lease expired, without a sweep', () => {
    const leases = new LeaseTable<string>('t');

    leases.lease('task-1', 50, 'w1@host');

    expect(leases.holders(Date.now() + 1_000).size).toBe(0);
  });

  it('counts one worker once however many leases it holds', () => {
    const leases = new LeaseTable<string>('t');

    leases.lease('task-1', 60_000, 'w1@host');
    leases.lease('task-2', 60_000, 'w1@host');

    expect([...leases.holders()]).toEqual(['w1@host']);
  });
});

describe('worker identity — a busy worker still serves its queue', () => {
  /** Polled long enough ago to be stale on its own. */
  function queue(workers: WorkerInfo[]): QueueLiveness[] {
    return [{taskQueue: 'email', activityPolledAt: 1_000, workers}];
  }

  const STALE_NOW = 1_000 + QUEUE_STALE_MS + 1;

  it('counts a stale but busy worker as serving', () => {
    const queues = queue([worker('w1@host', {busy: true})]);

    expect(isQueueServed(queues, 'email', 'activity', STALE_NOW)).toBe(true);
  });

  it('still reports a stale idle worker as not serving', () => {
    const queues = queue([worker('w1@host', {busy: false})]);

    expect(isQueueServed(queues, 'email', 'activity', STALE_NOW)).toBe(false);
  });

  /**
   * A wedged workflow loop is not excused by a busy activity loop in the same
   * process: nothing would be replaying, so the execution cannot progress.
   */
  it('does not let a busy worker in one role vouch for the other', () => {
    const queues = queue([worker('w1@host', {role: 'activity', busy: true})]);

    expect(isQueueServed(queues, 'email', 'workflow', STALE_NOW)).toBe(false);
  });
});

/**
 * The join, through a real host.
 *
 * Every piece above is tested in isolation, and all of them can pass while the
 * identity fails to travel: the poll records it in one table and the lease
 * records it in another, and only the host holds both. This is the test that
 * fails if it is dropped anywhere along the way.
 */
describe('worker identity — end to end through a server host', () => {
  it('reports a worker holding a task as busy, and as idle once it reports back', async () => {
    const host = createServerHost();
    await host.start('greeter', undefined, {taskQueue: 'email'});

    const task = await host.pollWorkflowTask({
      taskQueue: 'email',
      identity: 'w1@host',
    });
    expect(task).toBeDefined();

    const busyRow = workersServing(
      await host.listQueues(),
      'email',
      'workflow',
    );
    expect(busyRow.map((w) => [w.identity, w.busy])).toEqual([
      ['w1@host', true],
    ]);

    // Handing the task back releases the lease, so the same worker is now only
    // as alive as its last poll — which is the state the aggregate covers.
    await host.completeWorkflowTask(task!.token, {
      done: false,
      result: undefined,
      failed: false,
      failure: undefined,
      commands: [],
    });

    const idleRow = workersServing(
      await host.listQueues(),
      'email',
      'workflow',
    );
    expect(idleRow.map((w) => w.busy)).toEqual([false]);
  });

  it('does not report a worker that only polled an empty queue as busy', async () => {
    const host = createServerHost();

    await host.pollWorkflowTask({taskQueue: 'email', identity: 'w1@host'});

    const [row] = workersServing(await host.listQueues(), 'email', 'workflow');
    expect(row?.identity).toBe('w1@host');
    expect(row?.busy).toBe(false);
  });
});

describe('worker identity — which workers serve a queue', () => {
  it('includes a worker polling every queue', () => {
    const queues: QueueLiveness[] = [
      {taskQueue: 'email', workers: [worker('w1@host')]},
      {
        taskQueue: ANY_TASK_QUEUE,
        workers: [worker('w2@host', {taskQueue: ANY_TASK_QUEUE})],
      },
    ];

    expect(
      workersServing(queues, 'email', 'activity')
        .map((w) => w.identity)
        .sort(),
    ).toEqual(['w1@host', 'w2@host']);
  });

  it('excludes workers on an unrelated queue', () => {
    const queues: QueueLiveness[] = [
      {taskQueue: 'email', workers: [worker('w1@host')]},
      {
        taskQueue: 'billing',
        workers: [worker('w2@host', {taskQueue: 'billing'})],
      },
    ];

    expect(workersServing(queues, 'email', 'activity').length).toBe(1);
  });

  it('excludes the other role', () => {
    const role: WorkerRole = 'workflow';
    const queues: QueueLiveness[] = [
      {taskQueue: 'email', workers: [worker('w1@host', {role})]},
    ];

    expect(workersServing(queues, 'email', 'activity')).toEqual([]);
  });

  /**
   * Staleness is `lastPolledAt`, which the caller can read. Filtering here
   * would hide the worker that went quiet, which is usually the one being
   * looked for.
   */
  it('includes a worker however long ago it last polled', () => {
    const queues: QueueLiveness[] = [
      {
        taskQueue: 'email',
        workers: [worker('ancient@host', {lastPolledAt: 1})],
      },
    ];

    expect(workersServing(queues, 'email', 'activity').length).toBe(1);
  });
});

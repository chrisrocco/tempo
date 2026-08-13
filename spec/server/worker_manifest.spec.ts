/**
 * @fileoverview
 * What a worker says it can run, and the question that answers.
 *
 * `isQueueServed` already told you whether anything was *there*. It could not tell you
 * whether what is there can run the thing being dispatched — so a queue busily served by
 * workers that have never heard of `nightly` looked exactly like a deploy still rolling
 * out, and the two want opposite responses (issue #88).
 *
 * The property worth the most care here is the **three-valued** answer. Collapsing
 * "nobody said" into "no" would report every queue served by a worker that sends no
 * manifest as broken, which is worse than the gap being closed.
 */

import {
  ANY_TASK_QUEUE,
  isNameServed,
  isQueueServed,
  type QueueLiveness,
} from '../../src/protocol';
import {createServerHost} from '../../src/services';

describe('a worker reporting what it can run', () => {
  it('carries the manifest from the poll to the fleet view', async () => {
    const host = createServerHost();
    try {
      await host.pollWorkflowTask({
        taskQueue: 'reports',
        identity: 'w1@host',
        serves: ['nightly', 'weekly'],
      });

      const [queue] = await host.listQueues();
      expect(queue?.taskQueue).toBe('reports');
      expect(queue?.workers[0]?.serves).toEqual(['nightly', 'weekly']);
    } finally {
      host.shutdown();
    }
  });

  /**
   * Overwritten, not merged. A worker redeployed under one identity must not read as
   * serving the union of everything it has ever been able to run — that union is
   * precisely what would hide the version skew this exists to expose (#65).
   */
  it('replaces the manifest on each poll rather than accumulating it', async () => {
    const host = createServerHost();
    try {
      const poll = async (serves: string[]): Promise<void> => {
        await host.pollWorkflowTask({
          taskQueue: 'reports',
          identity: 'w1@host',
          serves,
        });
      };
      await poll(['old']);
      await poll(['new']);

      const [queue] = await host.listQueues();
      expect(queue?.workers[0]?.serves).toEqual(['new']);
    } finally {
      host.shutdown();
    }
  });

  it('reports two workers on one queue separately, which is what makes skew a diff', async () => {
    const host = createServerHost();
    try {
      await host.pollWorkflowTask({
        taskQueue: 'orders',
        identity: 'v1@host',
        serves: ['charge'],
      });
      await host.pollWorkflowTask({
        taskQueue: 'orders',
        identity: 'v2@host',
        serves: ['charge', 'refund'],
      });

      const [queue] = await host.listQueues();
      expect(queue?.workers.map((w) => w.serves)).toEqual([
        ['charge'],
        ['charge', 'refund'],
      ]);
    } finally {
      host.shutdown();
    }
  });

  it('leaves the manifest absent when a worker does not send one', async () => {
    const host = createServerHost();
    try {
      await host.pollWorkflowTask({taskQueue: 'legacy', identity: 'old@host'});

      const [queue] = await host.listQueues();
      expect(queue?.workers[0]?.serves).toBeUndefined();
    } finally {
      host.shutdown();
    }
  });
});

describe('isNameServed', () => {
  const at = 1_000;
  const queue = (
    taskQueue: string,
    workers: {identity: string; serves?: string[]}[],
  ): QueueLiveness => ({
    taskQueue,
    workflowPolledAt: at,
    workers: workers.map((w) => ({
      identity: w.identity,
      role: 'workflow' as const,
      taskQueue,
      lastPolledAt: at,
      busy: false,
      ...(w.serves === undefined ? {} : {serves: w.serves}),
    })),
  });

  it('is true when some worker on the queue registered the name', () => {
    const queues = [queue('reports', [{identity: 'w1', serves: ['nightly']}])];
    expect(isNameServed(queues, 'reports', 'workflow', 'nightly')).toBe(true);
  });

  /**
   * The case the whole issue is about: workers are present and healthy, and none of
   * them can run this. Distinguishable now from a deploy still rolling out, which is
   * the `undefined` below.
   */
  it('is false when the queue is served but by workers without the name', () => {
    const queues = [queue('reports', [{identity: 'w1', serves: ['weekly']}])];

    expect(isQueueServed(queues, 'reports', 'workflow', at)).toBe(true);
    expect(isNameServed(queues, 'reports', 'workflow', 'nightly')).toBe(false);
  });

  it('is undefined when nothing polls the queue at all', () => {
    const queues = [queue('other', [{identity: 'w1', serves: ['nightly']}])];
    expect(
      isNameServed(queues, 'reports', 'workflow', 'nightly'),
    ).toBeUndefined();
  });

  /**
   * Silence from *any* worker makes the whole answer unknown. The quiet one may be
   * the one that can run it, so a `false` derived from its neighbours would be a
   * claim the fleet does not support.
   */
  it('is undefined when any worker on the queue did not say', () => {
    const queues = [
      queue('reports', [
        {identity: 'w1', serves: ['weekly']},
        {identity: 'w2'},
      ]),
    ];
    expect(
      isNameServed(queues, 'reports', 'workflow', 'nightly'),
    ).toBeUndefined();
  });

  // The same rule `isQueueServed` and `workersServing` follow, so the three cannot
  // disagree about how big a fleet is.
  it('counts a worker polling every queue', () => {
    const queues = [
      queue(ANY_TASK_QUEUE, [{identity: 'w1', serves: ['nightly']}]),
    ];
    expect(isNameServed(queues, 'reports', 'workflow', 'nightly')).toBe(true);
  });

  it('does not answer for the wrong role', () => {
    const queues = [queue('reports', [{identity: 'w1', serves: ['nightly']}])];
    // The rows above are workflow workers; nothing here serves activities.
    expect(
      isNameServed(queues, 'reports', 'activity', 'nightly'),
    ).toBeUndefined();
  });
});

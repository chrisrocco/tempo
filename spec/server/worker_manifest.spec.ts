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
import {reportHash} from '../../src/worker';

/** Report `names`, then poll as that worker would — the two halves of the protocol. */
async function servingWorker(
  host: ReturnType<typeof createServerHost>,
  identity: string,
  taskQueue: string,
  names: string[],
): Promise<void> {
  const workflows = names.map((name) => ({name}));
  const hash = reportHash(workflows);
  await host.reportWorkflows({identity, taskQueue, hash, workflows});
  await host.pollWorkflowTask({taskQueue, identity, servesHash: hash});
}

describe('a worker reporting what it can run', () => {
  let host: ReturnType<typeof createServerHost>;

  beforeEach(() => {
    host = createServerHost();
  });

  afterEach(() => {
    host.shutdown();
  });

  it('resolves the report against the digest on the poll', async () => {
    await servingWorker(host, 'w1@host', 'reports', ['nightly', 'weekly']);

    const [queue] = await host.listQueues();
    expect(queue?.taskQueue).toBe('reports');
    expect(queue?.workers[0]?.serves).toEqual(['nightly', 'weekly']);
  });

  /**
   * The staleness check, and the reason the poll carries a digest at all. A worker
   * redeployed since it reported polls with a new hash, so the server's copy stops being
   * reported from that first poll — rather than staying authoritative until a replacement
   * report happens to arrive up to thirty seconds later.
   */
  it('reports nothing while the digest and the report disagree', async () => {
    await servingWorker(host, 'w1@host', 'reports', ['old']);

    // Redeployed: polling with a digest for a set it has not reported yet.
    await host.pollWorkflowTask({
      taskQueue: 'reports',
      identity: 'w1@host',
      servesHash: reportHash([{name: 'new'}]),
    });

    expect((await host.listQueues())[0]?.workers[0]?.serves).toBeUndefined();
  });

  it('resolves again once the new report lands', async () => {
    await servingWorker(host, 'w1@host', 'reports', ['old']);
    await servingWorker(host, 'w1@host', 'reports', ['new']);

    expect((await host.listQueues())[0]?.workers[0]?.serves).toEqual(['new']);
  });

  it('reports two workers on one queue separately, which is what makes skew a diff', async () => {
    await servingWorker(host, 'v1@host', 'orders', ['charge']);
    await servingWorker(host, 'v2@host', 'orders', ['charge', 'refund']);

    const [queue] = await host.listQueues();
    expect(queue?.workers.map((w) => w.serves)).toEqual([
      ['charge'],
      ['charge', 'refund'],
    ]);
  });

  it('reports nothing for a worker that sends no digest', async () => {
    await host.pollWorkflowTask({taskQueue: 'legacy', identity: 'old@host'});

    expect((await host.listQueues())[0]?.workers[0]?.serves).toBeUndefined();
  });

  // A digest with no report behind it is unknown, not empty: the worker is telling us
  // something we cannot yet interpret, which is not the same as telling us nothing runs.
  it('reports nothing for a digest it has never seen a report for', async () => {
    await host.pollWorkflowTask({
      taskQueue: 'reports',
      identity: 'w1@host',
      servesHash: 'never-reported',
    });

    expect((await host.listQueues())[0]?.workers[0]?.serves).toBeUndefined();
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

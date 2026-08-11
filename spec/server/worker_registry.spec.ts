/**
 * @fileoverview
 * Which task queues are being asked for work.
 *
 * The registry itself is a few lines; the properties worth pinning down are the
 * two ways it can quietly report the wrong thing:
 *
 * 1. **Idle polls must count.** A worker sitting on an empty queue is the
 *    strongest evidence of liveness there is. Recording only the polls that
 *    returned a task would report a perfectly healthy idle fleet as absent —
 *    the exact inversion of what this exists to detect.
 * 2. **A wildcard poll serves every queue.** `createLocalRuntime` polls with no
 *    queue at all, so a reading that ignored `ANY_TASK_QUEUE` would report every
 *    queue as unserved in the configuration most of the suite runs in.
 */

import {
  ANY_TASK_QUEUE,
  QUEUE_STALE_MS,
  isQueueServed,
  type QueueLiveness,
} from '../../src/protocol';
import {createWorkerRegistry} from '../../src/server';
import {createServerHost} from '../../src/services';

describe('worker registry — recording polls', () => {
  it('records a queue the first time it is polled', () => {
    const clock = () => 1_000;
    const registry = createWorkerRegistry(clock);

    registry.recordPoll('workflow', 'email');

    expect(registry.queues()).toEqual([
      {taskQueue: 'email', workflowPolledAt: 1_000, workers: []},
    ]);
  });

  it('keeps the two roles apart on one queue', () => {
    let now = 1_000;
    const registry = createWorkerRegistry(() => now);

    registry.recordPoll('workflow', 'email');
    now = 2_000;
    registry.recordPoll('activity', 'email');

    expect(registry.queues()).toEqual([
      {
        taskQueue: 'email',
        workflowPolledAt: 1_000,
        activityPolledAt: 2_000,
        workers: [],
      },
    ]);
  });

  it('advances the timestamp on each later poll', () => {
    let now = 1_000;
    const registry = createWorkerRegistry(() => now);

    registry.recordPoll('workflow', 'email');
    now = 5_000;
    registry.recordPoll('workflow', 'email');

    expect(registry.queues()[0]!.workflowPolledAt).toBe(5_000);
  });

  it('records a poll that names no queue under the wildcard', () => {
    const registry = createWorkerRegistry(() => 1_000);

    registry.recordPoll('workflow', undefined);

    expect(registry.queues()[0]!.taskQueue).toBe(ANY_TASK_QUEUE);
  });

  it('hands out copies, so a reader cannot be mutated under', () => {
    let now = 1_000;
    const registry = createWorkerRegistry(() => now);
    registry.recordPoll('workflow', 'email');

    const before = registry.queues();
    now = 9_000;
    registry.recordPoll('workflow', 'email');

    expect(before[0]!.workflowPolledAt).toBe(1_000);
  });
});

describe('worker registry — reading liveness', () => {
  const at = (ms: number): QueueLiveness[] => [
    {
      taskQueue: 'email',
      workflowPolledAt: ms,
      activityPolledAt: ms,
      workers: [],
    },
  ];

  it('reports a queue polled just now as served', () => {
    expect(isQueueServed(at(1_000), 'email', 'workflow', 1_000)).toBeTrue();
  });

  it('reports a queue polled within the staleness window as served', () => {
    const now = 1_000 + QUEUE_STALE_MS;

    expect(isQueueServed(at(1_000), 'email', 'workflow', now)).toBeTrue();
  });

  it('reports a queue silent for longer than the window as unserved', () => {
    const now = 1_000 + QUEUE_STALE_MS + 1;

    expect(isQueueServed(at(1_000), 'email', 'workflow', now)).toBeFalse();
  });

  it('reports a queue nothing has ever polled as unserved', () => {
    expect(isQueueServed([], 'email', 'workflow', 1_000)).toBeFalse();
  });

  it('does not let one role vouch for the other', () => {
    const queues: QueueLiveness[] = [
      {taskQueue: 'email', workflowPolledAt: 1_000, workers: []},
    ];

    expect(isQueueServed(queues, 'email', 'workflow', 1_000)).toBeTrue();
    expect(isQueueServed(queues, 'email', 'activity', 1_000)).toBeFalse();
  });

  it('does not let one queue vouch for another', () => {
    expect(isQueueServed(at(1_000), 'billing', 'workflow', 1_000)).toBeFalse();
  });

  it('treats a worker polling every queue as serving this one', () => {
    // The in-process runtime, which polls with no queue at all.
    const queues: QueueLiveness[] = [
      {taskQueue: ANY_TASK_QUEUE, workflowPolledAt: 1_000, workers: []},
    ];

    expect(isQueueServed(queues, 'anything', 'workflow', 1_000)).toBeTrue();
  });

  it('lets a stale wildcard poll go stale like any other', () => {
    const queues: QueueLiveness[] = [
      {taskQueue: ANY_TASK_QUEUE, workflowPolledAt: 1_000, workers: []},
    ];
    const now = 1_000 + QUEUE_STALE_MS + 1;

    expect(isQueueServed(queues, 'anything', 'workflow', now)).toBeFalse();
  });
});

/**
 * Through the real poll path, because the registry being correct is worth
 * nothing if `pollWorkflowTask` never tells it anything. This is the wiring the
 * unit tests above cannot see.
 */
describe('worker registry — through the server', () => {
  it('learns a queue from a poll that found no work', async () => {
    const host = createServerHost();

    // Nothing has been started, so this poll comes back empty — which is
    // exactly the case that has to register.
    const task = await host.pollWorkflowTask('email');
    const queues = await host.listQueues();
    host.shutdown();

    expect(task).toBeUndefined();
    expect(queues.map((q) => q.taskQueue)).toEqual(['email']);
    expect(queues[0]!.workflowPolledAt).toBeDefined();
  });

  it('records the role that polled, not merely that something did', async () => {
    const host = createServerHost();

    await host.pollActivityTask('email');
    const queues = await host.listQueues();
    host.shutdown();

    expect(queues[0]!.activityPolledAt).toBeDefined();
    expect(queues[0]!.workflowPolledAt).toBeUndefined();
  });

  it('reports nothing before any worker has polled', async () => {
    const host = createServerHost();

    const queues = await host.listQueues();
    host.shutdown();

    expect(queues).toEqual([]);
  });

  it('keeps separate queues separate, so one worker does not cover another pool', async () => {
    const host = createServerHost();

    await host.pollWorkflowTask('email');
    await host.pollWorkflowTask('billing');
    const queues = await host.listQueues();
    host.shutdown();

    const now = Date.now();
    expect(queues.map((q) => q.taskQueue).sort()).toEqual(['billing', 'email']);
    expect(isQueueServed(queues, 'email', 'workflow', now)).toBeTrue();
    expect(isQueueServed(queues, 'shipping', 'workflow', now)).toBeFalse();
  });
});

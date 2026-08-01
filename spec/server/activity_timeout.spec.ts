/**
 * @fileoverview
 * Start-to-close timeouts, and the duplicate-run behaviour they exist to stop.
 * The first test here is the one that matters: without a timeout, an activity
 * slower than the lease is redelivered and runs a second time *alongside* the
 * first. That is the at-least-once contract working as designed, and it is also
 * the sharpest edge in the system — which is why opting into a bound has to
 * actually remove it, not merely report it sooner.
 */

import type { ActivityOptions } from '../../src';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
} from '../../src/server';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeCore(historyStore: MemoryHistoryStore, leaseMs: number) {
  const activityTaskQueue = new MemoryTaskQueue(leaseMs);
  const core = createServerCore({
    historyStore,
    workflowTaskQueue: new MemoryWorkflowTaskQueue(),
    activityTaskQueue,
    timerService: new MemoryTimerService(),
    launch: () => 'child',
    kickWorkflowWorker: () => {},
    kickActivityWorker: () => {},
  });
  return { core, activityTaskQueue };
}

async function seedScheduledActivity(
  historyStore: MemoryHistoryStore,
  options: ActivityOptions,
): Promise<void> {
  await historyStore.create('wf', 'w', []);
  await historyStore.append('wf', [
    { type: 'activityScheduled', seq: 0, name: 'slow', args: [], options },
  ]);
}

describe('an activity that outlives its lease, with no timeout set', () => {
  // Documents today's default. Not a bug — at-least-once is the contract — but
  // the reason startToCloseTimeoutMs exists.
  it('is handed to a second worker while the first is still running', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, activityTaskQueue } = makeCore(historyStore, 30);
    await seedScheduledActivity(historyStore, {});
    activityTaskQueue.enqueue({
      workflowId: 'wf',
      seq: 0,
      name: 'slow',
      args: [],
      options: {},
    });

    const first = await core.pollActivityTask();
    await wait(60); // the first worker is still going; its lease has expired
    const second = await core.pollActivityTask();

    expect(first).toBeDefined();
    expect(second).toBeDefined(); // same work, dispatched twice, concurrently
    expect(second!.seq).toBe(0);
  });
});

describe('start-to-close timeout', () => {
  it('fails the attempt at the deadline rather than waiting for the worker', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, activityTaskQueue } = makeCore(historyStore, 5000);
    const options: ActivityOptions = { startToCloseTimeoutMs: 30 };
    await seedScheduledActivity(historyStore, options);
    activityTaskQueue.enqueue({
      workflowId: 'wf',
      seq: 0,
      name: 'slow',
      args: [],
      options,
    });

    await core.pollActivityTask();
    await wait(80); // the worker never reports back

    const rec = await historyStore.get('wf');
    const failure = rec!.history.find((e) => e.type === 'activityFailed');
    expect(failure).toBeDefined();
    expect((failure as { error: string }).error).toContain('timed out');
  });

  /**
   * The point of the feature. Failing the attempt is only half of it — the task
   * must also leave the queue, or the lease expires later and redelivers it into
   * exactly the second concurrent run the timeout was meant to prevent.
   */
  it('takes the task out of the queue, so no second worker runs it', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, activityTaskQueue } = makeCore(historyStore, 60);
    const options: ActivityOptions = { startToCloseTimeoutMs: 20 };
    await seedScheduledActivity(historyStore, options);
    activityTaskQueue.enqueue({
      workflowId: 'wf',
      seq: 0,
      name: 'slow',
      args: [],
      options,
    });

    await core.pollActivityTask();
    await wait(150); // well past both the timeout and the lease

    expect(await core.pollActivityTask()).toBeUndefined();
  });

  it('leaves an attempt that finishes in time completely alone', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, activityTaskQueue } = makeCore(historyStore, 5000);
    const options: ActivityOptions = { startToCloseTimeoutMs: 100 };
    await seedScheduledActivity(historyStore, options);
    activityTaskQueue.enqueue({
      workflowId: 'wf',
      seq: 0,
      name: 'slow',
      args: [],
      options,
    });

    const task = await core.pollActivityTask();
    await core.completeActivityTask(task!.token, { ok: true, result: 'done' });
    await wait(150); // the deadline passes with the attempt already settled

    const rec = await historyStore.get('wf');
    expect(rec!.history.filter((e) => e.type === 'activityCompleted').length) //
      .toBe(1);
    expect(rec!.history.some((e) => e.type === 'activityFailed')).toBeFalse();
  });

  /**
   * A timed-out attempt is not stopped, only abandoned — the worker may still be
   * running and may still report. History already has a terminal event for the
   * seq, and the completion dedup drops the late one rather than corrupting it.
   */
  it('ignores a late completion from the attempt it gave up on', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, activityTaskQueue } = makeCore(historyStore, 5000);
    const options: ActivityOptions = { startToCloseTimeoutMs: 20 };
    await seedScheduledActivity(historyStore, options);
    activityTaskQueue.enqueue({
      workflowId: 'wf',
      seq: 0,
      name: 'slow',
      args: [],
      options,
    });

    const task = await core.pollActivityTask();
    await wait(80); // times out
    await core.completeActivityTask(task!.token, { ok: true, result: 'late' });

    const rec = await historyStore.get('wf');
    const terminal = rec!.history.filter(
      (e) => e.type === 'activityCompleted' || e.type === 'activityFailed',
    );
    expect(terminal.length).toBe(1);
    expect(terminal[0].type).toBe('activityFailed');
  });
});

/**
 * @fileoverview
 * The poll-side half of the at-least-once bargain. The queue redelivers on
 * silence alone, and silence cannot tell a dead worker from a slow one — so
 * when the guess is wrong, the original attempt settles the seq while a
 * redelivered copy is still circulating. `reportActivityResult` already drops
 * the copy's *result* as a duplicate; these tests pin that `pollActivityTask`
 * also refuses to hand the copy *out* once history says the seq is settled.
 *
 * Without that check the copy can never leave: an attempt slower than the
 * lease always acks after redelivery, so its ack is a no-op, and the task
 * loops forever — a phantom `activityStarted` per lease period and a real
 * re-execution per loop, for an activity that finished long ago (issue #132).
 */

import type {LogFields} from '../../src/server';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
} from '../../src/server';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function makeCore(historyStore: MemoryHistoryStore, leaseMs: number) {
  const events: {event: string; fields: LogFields}[] = [];
  const activityTaskQueue = new MemoryTaskQueue(leaseMs);
  const core = createServerCore({
    historyStore,
    workflowTaskQueue: new MemoryWorkflowTaskQueue(),
    activityTaskQueue,
    timerService: new MemoryTimerService(),
    launch: () => 'child',
    kickWorkflowWorker: () => {},
    kickActivityWorker: () => {},
    log: (event, fields = {}) => events.push({event, fields}),
  });
  return {core, activityTaskQueue, events};
}

async function seedScheduledActivity(
  historyStore: MemoryHistoryStore,
): Promise<void> {
  await historyStore.create('wf', 'w', []);
  await historyStore.append('wf', [
    {type: 'activityScheduled', seq: 0, name: 'slow', args: [], options: {}},
  ]);
}

function enqueueSlow(activityTaskQueue: MemoryTaskQueue): void {
  activityTaskQueue.enqueue(
    {workflowId: 'wf', seq: 0, name: 'slow', args: [], options: {}},
    'default',
  );
}

describe('a redelivered copy outliving its settled activity', () => {
  it('is discarded at poll rather than dispatched again, and stays gone', async () => {
    const historyStore = new MemoryHistoryStore();
    const {core, activityTaskQueue, events} = makeCore(historyStore, 30);
    await seedScheduledActivity(historyStore);
    enqueueSlow(activityTaskQueue);

    const first = await core.pollActivityTask();
    expect(first?.seq).toBe(0);
    await wait(60); // worker 1 is slow, not dead; its lease expires
    const second = await core.pollActivityTask(); // redelivered to worker 2
    expect(second?.seq).toBe(0);

    // Worker 1 finishes anyway. Its queue ack is a no-op — the task now
    // belongs to worker 2 — but the result is welcome and settles the seq.
    await core.completeActivityTask(first!.token, {ok: true, result: 'done'});

    // Worker 2's copy outlives its lease too (every attempt of this activity
    // does — that is what made it redeliver in the first place), so the copy
    // comes back around. History already answered this seq; handing the task
    // out again would append a phantom `activityStarted` and re-run real work.
    await wait(60);
    expect(await core.pollActivityTask()).toBeUndefined();

    // Discarded means dead, not resting: the copy must not resurface on the
    // next lease period, or the loop has only been slowed down.
    await wait(60);
    expect(await core.pollActivityTask()).toBeUndefined();

    const rec = await historyStore.get('wf');
    expect(
      rec!.history.filter((e) => e.type === 'activityStarted').length,
    ).toBe(2); // the two genuine dispatches, nothing after the completion
    expect(
      rec!.history.filter((e) => e.type === 'activityCompleted').length,
    ).toBe(1);

    // The drop does work by *not* doing work, so without an event the only
    // evidence would be an absence in history — same reasoning as
    // `activity.duplicate_dropped` on the result side.
    const dropped = events.find(
      (e) => e.event === 'activity.stale_delivery_dropped',
    );
    expect(dropped).toBeDefined();
    expect(dropped!.fields['seq']).toBe(0);
  });

  it('is discarded when the execution is no longer running at all', async () => {
    const historyStore = new MemoryHistoryStore();
    const {core, activityTaskQueue} = makeCore(historyStore, 5000);
    await seedScheduledActivity(historyStore);
    enqueueSlow(activityTaskQueue);

    await core.terminate('wf', 'operator gave up');

    expect(await core.pollActivityTask()).toBeUndefined();
    const rec = await historyStore.get('wf');
    expect(rec!.history.some((e) => e.type === 'activityStarted')).toBeFalse();
  });

  /**
   * The trap the guard must not fall into. A retried activity re-enqueues the
   * *same seq* — its failed attempts leave `activityRetryScheduled`, never a
   * terminal event — so "already has a terminal event" is the only safe
   * predicate. A guard on anything looser would swallow every retry.
   */
  it('does not swallow a retry attempt, which reuses the seq of a failed one', async () => {
    const historyStore = new MemoryHistoryStore();
    const {core, activityTaskQueue} = makeCore(historyStore, 5000);
    await historyStore.create('wf', 'w', []);
    await historyStore.append('wf', [
      {type: 'activityScheduled', seq: 0, name: 'slow', args: [], options: {}},
      {
        type: 'activityRetryScheduled',
        seq: 0,
        attempt: 1,
        maxAttempts: 3,
        nextAttemptAt: Date.now(),
        error: 'first attempt failed',
      },
    ]);
    enqueueSlow(activityTaskQueue);

    const task = await core.pollActivityTask();
    expect(task?.seq).toBe(0); // the retry is live work, dispatched normally
  });
});

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
 *
 * The settlement sweep in `reportActivityResult` is the other half of the
 * defense, and which half fires depends on where the copy is when the seq
 * settles: still in the lease table (held or lapsed), and the sweep's ack
 * kills it there; already reclaimed into the queue — it has no token, so the
 * sweep cannot reach it — and this poll-side check is what stands. One test
 * below pins each half.
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
  it('dies with the settlement when it is still in the lease table, and stays gone', async () => {
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
    // Settling is what sweeps worker 2's claim: the copy is still in the
    // lease table, and the sweep's ack takes it out before it can lapse and
    // come back around.
    await core.completeActivityTask(first!.token, {ok: true, result: 'done'});
    const swept = events.find((e) => e.event === 'activity.attempts_swept');
    expect(swept).toBeDefined();
    expect(swept!.fields['seq']).toBe(0);

    // Nothing to redeliver: history already answered this seq, and handing the
    // task out again would append a phantom `activityStarted` and re-run real
    // work. Not on the next lease period either — dead, not resting.
    await wait(60);
    expect(await core.pollActivityTask()).toBeUndefined();
    await wait(60);
    expect(await core.pollActivityTask()).toBeUndefined();

    const rec = await historyStore.get('wf');
    expect(
      rec!.history.filter((e) => e.type === 'activityStarted').length,
    ).toBe(2); // the two genuine dispatches, nothing after the completion
    expect(
      rec!.history.filter((e) => e.type === 'activityCompleted').length,
    ).toBe(1);
  });

  it('is discarded at poll when it was already back in the queue at settlement', async () => {
    const historyStore = new MemoryHistoryStore();
    const {core, activityTaskQueue, events} = makeCore(historyStore, 30);
    await seedScheduledActivity(historyStore);
    enqueueSlow(activityTaskQueue);

    const first = await core.pollActivityTask();
    await wait(60);
    const second = await core.pollActivityTask(); // redelivered to worker 2
    expect(second?.seq).toBe(0);

    // Worker 2's copy outlives its lease too (every attempt of this activity
    // does — that is what made it redeliver in the first place), and any poll
    // on the queue reclaims lapsed leases before routing. A poll for a
    // different task queue plays that part: the copy moves back into the
    // queue proper, tokenless, where the settlement sweep cannot reach it.
    await wait(60);
    expect(
      await core.pollActivityTask({taskQueue: 'another-queue'}),
    ).toBeUndefined();

    await core.completeActivityTask(first!.token, {ok: true, result: 'done'});

    // The queued copy survived the settlement, so the poll-side check is what
    // stands between it and a third dispatch.
    expect(await core.pollActivityTask()).toBeUndefined();
    const rec = await historyStore.get('wf');
    expect(
      rec!.history.filter((e) => e.type === 'activityStarted').length,
    ).toBe(2);

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

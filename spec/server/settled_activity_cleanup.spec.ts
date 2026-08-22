/**
 * @fileoverview
 * What happens to the server's attempt records when the activity they belong
 * to stops being open. The records — lease, deadline timers, heartbeat
 * bookkeeping, queue claim — are kept per attempt *token*, but lease-expiry
 * redelivery means one seq can have several tokens out at once, and only the
 * attempt that reports cleans up after itself. The rule pinned here is that a
 * terminal event for the seq sweeps the rest: a sibling's records must not
 * wait on that worker's ack, because a worker that crashed holding an
 * activity with no startToClose or heartbeat timeout never acks, and its
 * records would otherwise live until a reset or a process restart.
 *
 * The maps themselves are private to the core, so the specs read the sweep's
 * observable edges instead: the `activity.attempts_swept` event, the
 * straggler's ack being turned away at the lease check rather than travelling
 * to the history dedup, and — for the settle/terminate sweeps — the queue no
 * longer redelivering a claim the execution stopped being able to accept.
 */

import type {ActivityOptions} from '../../src';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
  type LogFields,
} from '../../src/server';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

interface Captured {
  event: string;
  fields: LogFields;
}

function makeCore(historyStore: MemoryHistoryStore, leaseMs: number) {
  const events: Captured[] = [];
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
  seq: number,
  options: ActivityOptions = {},
): Promise<void> {
  await historyStore.append('wf', [
    {type: 'activityScheduled', seq, name: 'work', args: [], options},
  ]);
}

describe('a seq settled through a redelivered attempt', () => {
  it('sweeps the expired sibling and turns its late ack away at the lease check', async () => {
    const historyStore = new MemoryHistoryStore();
    const {core, activityTaskQueue, events} = makeCore(historyStore, 10);
    await historyStore.create('wf', 'w', []);
    await seedScheduledActivity(historyStore, 0);
    activityTaskQueue.enqueue(
      {workflowId: 'wf', seq: 0, name: 'work', args: [], options: {}},
      'default',
    );

    const first = await core.pollActivityTask();
    await wait(25); // worker A's lease expires without an ack
    const second = await core.pollActivityTask();
    expect(second?.name).toBe('work'); // redelivered to worker B

    await core.completeActivityTask(second!.token, {ok: true, result: 'w'});

    // The settlement is what swept A's records — one straggler, named.
    const swept = events.find((e) => e.event === 'activity.attempts_swept');
    expect(swept).toBeDefined();
    expect(swept!.fields['workflowId']).toBe('wf');
    expect(swept!.fields['seq']).toBe(0);
    expect(swept!.fields['count']).toBe(1);

    // Worker A — slow, not dead — acks now. With its lease swept, the ack is
    // turned away before it ever becomes a report, so the history dedup has
    // nothing to drop and history keeps exactly one terminal event.
    await core.completeActivityTask(first!.token, {ok: true, result: 'late'});
    expect(events.some((e) => e.event === 'activity.duplicate_dropped')) //
      .toBeFalse();
    const rec = await historyStore.get('wf');
    expect(
      rec!.history.filter(
        (e) => e.type === 'activityCompleted' || e.type === 'activityFailed',
      ).length,
    ).toBe(1);
  });

  it('ignores a heartbeat from the swept sibling', async () => {
    const historyStore = new MemoryHistoryStore();
    const {core, activityTaskQueue, events} = makeCore(historyStore, 10);
    await historyStore.create('wf', 'w', []);
    await seedScheduledActivity(historyStore, 0);
    activityTaskQueue.enqueue(
      {workflowId: 'wf', seq: 0, name: 'work', args: [], options: {}},
      'default',
    );

    const first = await core.pollActivityTask();
    await wait(25);
    const second = await core.pollActivityTask();
    await core.completeActivityTask(second!.token, {ok: true, result: 'w'});

    await core.heartbeatActivityTask(first!.token);

    expect(events.some((e) => e.event === 'activity.heartbeat')).toBeFalse();
  });

  it('leaves the records of a different seq alone', async () => {
    const historyStore = new MemoryHistoryStore();
    const {core, activityTaskQueue, events} = makeCore(historyStore, 5000);
    await historyStore.create('wf', 'w', []);
    await seedScheduledActivity(historyStore, 0);
    await seedScheduledActivity(historyStore, 1);
    for (const seq of [0, 1])
      activityTaskQueue.enqueue(
        {workflowId: 'wf', seq, name: 'work', args: [], options: {}},
        'default',
      );

    const a = await core.pollActivityTask();
    const b = await core.pollActivityTask();
    await core.completeActivityTask(a!.token, {ok: true, result: 'a'});

    // Settling seq 0 swept nothing — its own attempt cleaned up after itself —
    // and seq 1's attempt is still live: its worker completes it normally.
    expect(events.some((e) => e.event === 'activity.attempts_swept')) //
      .toBeFalse();
    await core.completeActivityTask(b!.token, {ok: true, result: 'b'});
    const rec = await historyStore.get('wf');
    expect(
      rec!.history.filter((e) => e.type === 'activityCompleted').length,
    ).toBe(2);
  });
});

describe('an execution settled with an attempt still out', () => {
  it('terminate sweeps the live claim, so the queue never redelivers it', async () => {
    const historyStore = new MemoryHistoryStore();
    const {core, activityTaskQueue, events} = makeCore(historyStore, 30);
    await historyStore.create('wf', 'w', []);
    await seedScheduledActivity(historyStore, 0);
    activityTaskQueue.enqueue(
      {workflowId: 'wf', seq: 0, name: 'work', args: [], options: {}},
      'default',
    );
    const task = await core.pollActivityTask();
    expect(task).toBeDefined();

    await core.terminate('wf', 'operator pulled it');

    const swept = events.find((e) => e.event === 'activity.attempts_swept');
    expect(swept).toBeDefined();
    expect(swept!.fields['count']).toBe(1);

    // Without the sweep the lease would lapse and the queue would hand the
    // task to a second worker, for an execution nothing can report against.
    await wait(60); // well past the lease
    expect(await core.pollActivityTask()).toBeUndefined();
  });

  it('a normal completion sweeps too — the rule is on the disposition, not on terminate', async () => {
    const historyStore = new MemoryHistoryStore();
    const {core, activityTaskQueue, events} = makeCore(historyStore, 30);
    await historyStore.create('wf', 'w', []);
    // The workflow schedules the activity, a worker takes it, and then a later
    // task settles the execution without it — the `Promise.race` shape, where
    // the dispatch loses and nothing ever awaits it.
    await core.applyWorkflowTaskResult('wf', {
      done: false,
      result: undefined,
      failed: false,
      failure: undefined,
      commands: [
        {type: 'scheduleActivity', seq: 0, name: 'work', args: [], options: {}},
      ],
      carryover: {},
      parked: [],
    });
    const task = await core.pollActivityTask();
    expect(task).toBeDefined();

    await core.applyWorkflowTaskResult('wf', {
      done: true,
      result: 'raced past it',
      failed: false,
      failure: undefined,
      commands: [],
      carryover: {},
      parked: [],
    });

    expect(
      events.find((e) => e.event === 'activity.attempts_swept')?.fields[
        'count'
      ],
    ).toBe(1);
    await wait(60);
    expect(await core.pollActivityTask()).toBeUndefined();
  });
});

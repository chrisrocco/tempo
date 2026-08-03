/**
 * @fileoverview
 * The distributed concurrency-control mechanisms, tested directly: optimistic
 * version CAS on the store, lease-expiry redelivery on both queues, the two
 * composing at the seam — a lease-race loser's append is rejected by the version
 * check — and the activity-side equivalent, where a late ack from the worker
 * whose lease expired is dropped by the server's completion dedup. Driven
 * against a headless server_core (no in-proc worker loops); the last test drives
 * replay by hand, because the guarantee it checks is that history stays
 * replayable.
 */

import type { WorkflowTaskResult } from '../../src';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  VersionConflictError,
  createServerCore,
} from '../../src/server';
import { createWorkflowRegistry, createWorkflowWorker } from '../../src/worker';
import { runActivity } from '../../src/workflow';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('optimistic version check (appendIfVersion)', () => {
  it('applies at the expected version and rejects a stale one', async () => {
    const store = new MemoryHistoryStore();
    await store.create('wf', 'w', []);
    const v0 = (await store.get('wf'))!.version;

    await store.appendIfVersion(
      'wf',
      [{ type: 'signal', name: 'a', payload: 1 }],
      v0,
    ); // v0 -> v0+1
    await expectAsync(
      store.appendIfVersion(
        'wf',
        [{ type: 'signal', name: 'b', payload: 2 }],
        v0,
      ),
    ).toBeRejectedWithError(VersionConflictError);

    const rec = await store.get('wf');
    expect(rec!.version).toBe(v0 + 1);
    expect(rec!.history.length).toBe(1); // only the first append landed
  });
});

describe('lease-expiry redelivery', () => {
  it('redelivers a workflow task whose lease expires', async () => {
    const q = new MemoryWorkflowTaskQueue(10); // 10ms lease
    q.enqueue('wf-1');

    const first = q.poll();
    expect(first?.workflowId).toBe('wf-1');
    await wait(25); // lease expires without a complete

    const second = q.poll(); // sweeps the expired lease and redelivers
    expect(second?.workflowId).toBe('wf-1');
    expect(second?.token).not.toBe(first?.token);

    q.complete(first!.token); // the stale (expired) completer is a no-op
    q.complete(second!.token);
    expect(q.poll()).toBeUndefined();
  });

  it('redelivers an activity task whose lease expires', async () => {
    const q = new MemoryTaskQueue(10);
    q.enqueue(
      { workflowId: 'wf', seq: 0, name: 'a', args: [], options: {} },
      'default',
    );

    const first = q.poll();
    expect(first?.name).toBe('a');
    await wait(25);

    const second = q.poll();
    expect(second?.name).toBe('a'); // redelivered
    q.complete(second!.token);
    expect(q.poll()).toBeUndefined();
  });
});

describe('lease race resolved by the version check', () => {
  it('lets the first completer apply and rejects the stale loser', async () => {
    const historyStore = new MemoryHistoryStore();
    const workflowTaskQueue = new MemoryWorkflowTaskQueue(10); // short lease to force a race
    const core = createServerCore({
      historyStore,
      workflowTaskQueue,
      activityTaskQueue: new MemoryTaskQueue(),
      timerService: new MemoryTimerService(),
      launch: () => 'child',
      kickWorkflowWorker: () => {},
      kickActivityWorker: () => {},
    });

    await historyStore.create('wf', 'w', []);
    workflowTaskQueue.enqueue('wf');

    // worker A claims the task (built at version 0)
    const taskA = await core.pollWorkflowTask();
    expect(taskA?.workflowId).toBe('wf');
    await wait(25); // A's lease expires...
    const taskB = await core.pollWorkflowTask(); // ...and the task is redelivered to B (also version 0)
    expect(taskB?.workflowId).toBe('wf');

    // both replayed the same history → both respond with the same command
    const result: WorkflowTaskResult = {
      done: false,
      result: undefined,
      failed: false,
      failure: undefined,
      commands: [
        { type: 'scheduleActivity', seq: 0, name: 'a', args: [], options: {} },
      ],
    };

    await core.completeWorkflowTask(taskA!.token, result); // first: version matches → applies
    expect((await historyStore.get('wf'))!.version).toBe(1);

    await core.completeWorkflowTask(taskB!.token, result); // second: version moved on → rejected
    const rec = await historyStore.get('wf');
    expect(rec!.version).toBe(1); // unchanged — the loser's result was discarded
    expect(
      rec!.history.filter((e) => e.type === 'activityScheduled').length,
    ).toBe(1);
  });
});

describe('late activity ack after redelivery', () => {
  it('drops the ack from the worker whose lease expired, leaving one completion event and a replayable history', async () => {
    const historyStore = new MemoryHistoryStore();
    const workflowTaskQueue = new MemoryWorkflowTaskQueue();
    const activityTaskQueue = new MemoryTaskQueue(10); // short lease to force redelivery
    const core = createServerCore({
      historyStore,
      workflowTaskQueue,
      activityTaskQueue,
      timerService: new MemoryTimerService(),
      launch: () => 'child',
      kickWorkflowWorker: () => {},
      kickActivityWorker: () => {},
    });

    // Two activities, so the workflow is still parked when the late ack lands.
    // With a one-activity workflow a trailing duplicate is absorbed by accident:
    // `replay` stops feeding events once the workflow is done, so it never
    // reaches the event that would have thrown.
    const registry = createWorkflowRegistry();
    registry.set('doer', async () => {
      const a = await runActivity<string>('work');
      const b = await runActivity<string>('more');
      return `${a}+${b}`;
    });
    const workflowWorker = createWorkflowWorker(registry);

    // One turn of the crank the in-proc worker loop would do for us: claim the
    // queued task, replay the real workflow over the recorded history, apply.
    async function driveWorkflow(): Promise<void> {
      const leased = workflowTaskQueue.poll();
      if (!leased) return;
      const task = await core.buildWorkflowTask(leased.workflowId);
      if (task) {
        const result = await workflowWorker.replayTask(
          task.name,
          task.args,
          task.history,
          task.continueAsNewSuggested,
        );
        await core.applyWorkflowTaskResult(leased.workflowId, result);
      }
      workflowTaskQueue.complete(leased.token);
    }

    await historyStore.create('wf', 'doer', []);
    workflowTaskQueue.enqueue('wf');
    await driveWorkflow(); // schedules 'work' (seq 0) and parks

    const first = await core.pollActivityTask();
    expect(first?.name).toBe('work');
    await wait(25); // worker A's lease expires without an ack
    const second = await core.pollActivityTask();
    expect(second?.name).toBe('work'); // redelivered to worker B

    await core.completeActivityTask(second!.token, { ok: true, result: 'w' });
    await driveWorkflow(); // seq 0 resolves; the workflow schedules 'more'

    // Worker A was not dead, only slow: its ack for seq 0 lands now, behind the
    // `activityScheduled` for seq 1.
    await core.completeActivityTask(first!.token, { ok: true, result: 'w' });

    const mid = await historyStore.get('wf');
    expect(
      mid!.history.filter((e) => e.type === 'activityCompleted' && e.seq === 0)
        .length,
    ).toBe(1);

    const more = await core.pollActivityTask();
    expect(more?.name).toBe('more');
    await core.completeActivityTask(more!.token, { ok: true, result: 'm' });

    // A duplicate completion mid-history replays as `nondeterminism: history
    // event for unknown seq 0` — the seq-0 waiter is gone by then — so running
    // the execution out is what proves the late ack really was dropped.
    await driveWorkflow();
    const settled = await historyStore.get('wf');
    expect(settled!.status).toBe('completed');
    expect(settled!.result).toBe('w+m');
  });
});

/**
 * @fileoverview
 * Heartbeating: how an activity that legitimately runs for a long time keeps its
 * claim, and how one whose worker died is caught quickly.
 *
 * Both are the same underlying problem — elapsed time is not evidence a worker is
 * dead — and before heartbeats the engine had to guess. Without a timeout it
 * assumed the worker was gone and redelivered, duplicating live work; with a
 * start-to-close timeout it assumed the deadline was meaningful and cut off
 * healthy attempts. A heartbeat replaces the guess with a statement from the work
 * itself.
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

function coreWith(leaseMs: number, historyStore = new MemoryHistoryStore()) {
  const activityTaskQueue = new MemoryTaskQueue(leaseMs);
  const core = createServerCore({
    historyStore,
    workflowTaskQueue: new MemoryWorkflowTaskQueue(),
    activityTaskQueue,
    timerService: new MemoryTimerService(),
    launch: () => {},
    kickWorkflowWorker: () => {},
    kickActivityWorker: () => {},
  });
  return { core, activityTaskQueue, historyStore };
}

async function seed(
  historyStore: MemoryHistoryStore,
  options: ActivityOptions,
): Promise<void> {
  await historyStore.create('wf', 'w', []);
  await historyStore.append('wf', [
    { type: 'activityScheduled', seq: 0, name: 'agent', args: [], options },
  ]);
}

function enqueue(queue: MemoryTaskQueue, options: ActivityOptions): void {
  queue.enqueue({ workflowId: 'wf', seq: 0, name: 'agent', args: [], options });
}

function terminalEvents(historyStore: MemoryHistoryStore) {
  return historyStore
    .get('wf')
    .then((rec) =>
      rec!.history.filter(
        (e) => e.type === 'activityCompleted' || e.type === 'activityFailed',
      ),
    );
}

describe('an attempt that keeps heartbeating', () => {
  /**
   * The headline: a ten-minute agent under a thirty-second lease. Before this,
   * the only outcomes were a duplicate run or an early failure.
   */
  it('holds its claim past the lease, so no second worker gets the task', async () => {
    const options: ActivityOptions = { heartbeatTimeoutMs: 200 };
    const { core, activityTaskQueue, historyStore } = coreWith(40);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    // Outlive the lease several times over, beating as a working activity would.
    for (let i = 0; i < 5; i++) {
      await wait(25);
      await core.heartbeatActivityTask(task!.token);
    }

    expect(await core.pollActivityTask()).toBeUndefined(); // never redelivered
    expect(await terminalEvents(historyStore)).toEqual([]); // and never failed
  });

  it('still completes normally when the work finally finishes', async () => {
    const options: ActivityOptions = { heartbeatTimeoutMs: 200 };
    const { core, activityTaskQueue, historyStore } = coreWith(40);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    await wait(25);
    await core.heartbeatActivityTask(task!.token);
    await core.completeActivityTask(task!.token, {
      ok: true,
      result: 'thought about it',
    });

    const terminal = await terminalEvents(historyStore);
    expect(terminal.length).toBe(1);
    expect(terminal[0].type).toBe('activityCompleted');
  });
});

describe('an attempt that stops heartbeating', () => {
  it('is failed once the silence passes its heartbeat timeout', async () => {
    const options: ActivityOptions = { heartbeatTimeoutMs: 40 };
    const { core, activityTaskQueue, historyStore } = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    await core.pollActivityTask();
    await wait(100); // worker died without a word

    const terminal = await terminalEvents(historyStore);
    expect(terminal.length).toBe(1);
    expect((terminal[0] as { error: string }).error).toContain(
      'stopped heartbeating',
    );
  });

  /**
   * The detection-speed argument. The lease is what the engine falls back on
   * without heartbeats, and it is deliberately long; a heartbeat timeout can be
   * short because a healthy attempt is expected to speak.
   */
  it('is caught long before its lease would have expired', async () => {
    const options: ActivityOptions = { heartbeatTimeoutMs: 40 };
    const { core, activityTaskQueue, historyStore } = coreWith(10_000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    await core.pollActivityTask();
    await wait(100); // a fraction of the 10s lease

    expect((await terminalEvents(historyStore)).length).toBe(1);
  });

  it('does not redeliver the abandoned attempt to a second worker', async () => {
    const options: ActivityOptions = { heartbeatTimeoutMs: 30 };
    const { core, activityTaskQueue, historyStore } = coreWith(60);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    await core.pollActivityTask();
    await wait(150); // past the heartbeat deadline and the lease

    expect(await core.pollActivityTask()).toBeUndefined();
  });

  it('leaves an activity alone when it declares no heartbeat timeout', async () => {
    const { core, activityTaskQueue, historyStore } = coreWith(5000);
    await seed(historyStore, {});
    enqueue(activityTaskQueue, {});

    await core.pollActivityTask();
    await wait(80);

    expect(await terminalEvents(historyStore)).toEqual([]); // silence is fine
  });
});

describe('heartbeats for an attempt the server gave up on', () => {
  /**
   * A worker that was declared dead may not know it. Its heartbeat must not
   * revive a claim on work that now belongs to someone else, or the duplicate
   * run the timeout prevented would reappear by the back door.
   */
  it('are ignored rather than reviving the claim', async () => {
    const options: ActivityOptions = { heartbeatTimeoutMs: 30 };
    const { core, activityTaskQueue, historyStore } = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    await wait(80); // abandoned
    await core.heartbeatActivityTask(task!.token); // the worker, still going

    const terminal = await terminalEvents(historyStore);
    expect(terminal.length).toBe(1); // still exactly one outcome
    expect(await core.pollActivityTask()).toBeUndefined();
  });

  it('are a no-op for a token that was never leased', async () => {
    const { core } = coreWith(5000);
    await expectAsync(
      core.heartbeatActivityTask('act-never-issued'),
    ).toBeResolved();
  });
});

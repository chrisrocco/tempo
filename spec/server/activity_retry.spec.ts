/**
 * @fileoverview
 * Retry as a server decision. Two things this fixes, and both are invisible from
 * local mode alone:
 *
 * - A distributed activity worker makes **one attempt per delivery** and reports
 *   the result. While retry lived in the local drain loop, `maximumAttempts` was
 *   honoured in local mode and silently ignored everywhere else — the same
 *   workflow behaved differently depending on how it was hosted.
 * - The attempt count lived in a worker's memory, so a worker lost mid-backoff
 *   restarted the budget from zero. It is now on the record, which is what makes
 *   it survive both worker loss and a server restart.
 */

import type {ActivityOptions} from '../../src';
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

/** A fresh core over an existing store — how a server restart looks from here. */
function coreOver(
  historyStore: MemoryHistoryStore,
  activityTaskQueue = new MemoryTaskQueue(),
) {
  const core = createServerCore({
    historyStore,
    workflowTaskQueue: new MemoryWorkflowTaskQueue(),
    activityTaskQueue,
    timerService: new MemoryTimerService(),
    launch: () => 'child',
    kickWorkflowWorker: () => {},
    kickActivityWorker: () => {},
  });
  return {core, activityTaskQueue};
}

async function seed(
  historyStore: MemoryHistoryStore,
  options: ActivityOptions,
): Promise<void> {
  await historyStore.create('wf', 'w', []);
  await historyStore.append('wf', [
    {type: 'activityScheduled', seq: 0, name: 'flaky', args: [], options},
  ]);
}

function enqueue(queue: MemoryTaskQueue, options: ActivityOptions): void {
  queue.enqueue(
    {workflowId: 'wf', seq: 0, name: 'flaky', args: [], options},
    'default',
  );
}

/** Take the task and report it failed, as a worker doing one attempt would. */
async function failOnce(
  core: ReturnType<typeof coreOver>['core'],
): Promise<void> {
  const task = await core.pollActivityTask();
  if (!task) throw new Error('expected a task to be queued');
  await core.completeActivityTask(task.token, {ok: false, error: 'boom'});
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

describe('retry decided by the server', () => {
  const policy: ActivityOptions = {retry: {maximumAttempts: 3}};

  it('re-queues a failed activity instead of failing it immediately', async () => {
    const historyStore = new MemoryHistoryStore();
    const {core, activityTaskQueue} = coreOver(historyStore);
    await seed(historyStore, policy);
    enqueue(activityTaskQueue, policy);

    await failOnce(core);

    expect(await terminalEvents(historyStore)).toEqual([]); // not settled
    expect(await core.pollActivityTask()).toBeDefined(); // dispatched again
  });

  it('fails the activity once the attempt budget is spent', async () => {
    const historyStore = new MemoryHistoryStore();
    const {core, activityTaskQueue} = coreOver(historyStore);
    await seed(historyStore, policy);
    enqueue(activityTaskQueue, policy);

    await failOnce(core); // attempt 1
    await failOnce(core); // attempt 2
    await failOnce(core); // attempt 3 — the budget

    const terminal = await terminalEvents(historyStore);
    expect(terminal.length).toBe(1);
    expect(terminal[0].type).toBe('activityFailed');
    expect(await core.pollActivityTask()).toBeUndefined(); // and no fourth try
  });

  it('makes exactly one attempt when no retry policy is set', async () => {
    const historyStore = new MemoryHistoryStore();
    const {core, activityTaskQueue} = coreOver(historyStore);
    await seed(historyStore, {});
    enqueue(activityTaskQueue, {});

    await failOnce(core);

    expect((await terminalEvents(historyStore))[0].type).toBe('activityFailed');
  });

  it('forgets the attempts once the activity succeeds', async () => {
    const historyStore = new MemoryHistoryStore();
    const {core, activityTaskQueue} = coreOver(historyStore);
    await seed(historyStore, policy);
    enqueue(activityTaskQueue, policy);

    await failOnce(core);
    const retryTask = await core.pollActivityTask();
    await core.completeActivityTask(retryTask!.token, {
      ok: true,
      result: 'eventually',
    });

    const rec = await historyStore.get('wf');
    expect(rec!.activityAttempts[0]).toBeUndefined();
    expect((await terminalEvents(historyStore))[0].type).toBe(
      'activityCompleted',
    );
  });

  it('waits the backoff before offering the task again', async () => {
    const historyStore = new MemoryHistoryStore();
    const slow: ActivityOptions = {
      retry: {maximumAttempts: 3, initialIntervalMs: 40},
    };
    const {core, activityTaskQueue} = coreOver(historyStore);
    await seed(historyStore, slow);
    enqueue(activityTaskQueue, slow);

    await failOnce(core);

    expect(await core.pollActivityTask()).toBeUndefined(); // still backing off
    await wait(80);
    expect(await core.pollActivityTask()).toBeDefined();
  });

  /**
   * Blocker 6. The count is on the record rather than in a worker or a queue, so
   * a restart does not hand the activity a fresh budget — which is what would let
   * a permanently failing activity retry forever across a crash loop.
   */
  it('does not refresh the retry budget when the server restarts', async () => {
    const historyStore = new MemoryHistoryStore();
    const first = coreOver(historyStore);
    await seed(historyStore, policy);
    enqueue(first.activityTaskQueue, policy);

    await failOnce(first.core); // attempt 1
    await failOnce(first.core); // attempt 2

    // Restart: a new core, new queues, same durable store. `resume` re-dispatches
    // the activity because its marker still carries no completion.
    const second = coreOver(historyStore);
    await second.core.resumeFromHistory(await historyStore.list());

    await failOnce(second.core); // attempt 3, counted against the same budget

    const terminal = await terminalEvents(historyStore);
    expect(terminal.length).toBe(1);
    expect(terminal[0].type).toBe('activityFailed');
  });

  it('spends an attempt when the attempt times out rather than fails', async () => {
    const historyStore = new MemoryHistoryStore();
    const timed: ActivityOptions = {
      retry: {maximumAttempts: 2},
      startToCloseTimeoutMs: 20,
    };
    const {core, activityTaskQueue} = coreOver(historyStore);
    await seed(historyStore, timed);
    enqueue(activityTaskQueue, timed);

    await core.pollActivityTask(); // taken, then never reported
    await wait(60); // times out — one attempt spent

    const rec = await historyStore.get('wf');
    expect(rec!.activityAttempts[0]?.attempts).toBe(1);
    expect(await terminalEvents(historyStore)).toEqual([]); // retrying, not failed
  });
});

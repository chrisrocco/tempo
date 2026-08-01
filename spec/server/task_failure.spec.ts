/**
 * @fileoverview
 * What happens when a workflow task cannot be replayed at all. The policy under
 * test is deliberate and easy to "fix" into something worse: the execution keeps
 * running and the task is retried forever, because workflow code is redeployable
 * and settling the execution would destroy work a corrected deploy recovers
 * (planning/sprints/05-phase-6-scope.md). The recovery test at the end is the
 * justification for that policy, so it is pinned rather than assumed.
 */

import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
  workflowTaskBackoffMs,
} from '../../src/server';
import { createWorkflowRegistry, createWorkflowWorker } from '../../src/worker';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeCore(historyStore: MemoryHistoryStore) {
  const workflowTaskQueue = new MemoryWorkflowTaskQueue();
  const core = createServerCore({
    historyStore,
    workflowTaskQueue,
    activityTaskQueue: new MemoryTaskQueue(),
    timerService: new MemoryTimerService(),
    launch: () => 'child',
    kickWorkflowWorker: () => {},
    kickActivityWorker: () => {},
  });
  return { core, workflowTaskQueue };
}

describe('workflow-task backoff', () => {
  it('grows exponentially with consecutive failures', () => {
    expect(workflowTaskBackoffMs(1)).toBe(100);
    expect(workflowTaskBackoffMs(2)).toBe(200);
    expect(workflowTaskBackoffMs(3)).toBe(400);
  });

  it('caps rather than growing without bound, since retries never stop', () => {
    expect(workflowTaskBackoffMs(50)).toBe(30_000);
  });
});

describe('a workflow task the worker could not replay', () => {
  it('records the failure against the execution with its reason', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, workflowTaskQueue } = makeCore(historyStore);
    await historyStore.create('wf', 'w', []);
    workflowTaskQueue.enqueue('wf');

    const task = await core.pollWorkflowTask();
    await core.failWorkflowTask(task!.token, 'nondeterminism at seq 0');

    const rec = await historyStore.get('wf');
    expect(rec!.taskFailures).toBe(1);
    expect(rec!.lastTaskFailure).toBe('nondeterminism at seq 0');
  });

  it('leaves the execution running rather than settling it', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, workflowTaskQueue } = makeCore(historyStore);
    await historyStore.create('wf', 'w', []);
    workflowTaskQueue.enqueue('wf');

    const task = await core.pollWorkflowTask();
    await core.failWorkflowTask(task!.token, 'boom');

    // The policy, asserted: a change that "helpfully" gives up here should fail.
    expect((await historyStore.get('wf'))!.status).toBe('running');
  });

  it('counts consecutive failures rather than overwriting the last', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, workflowTaskQueue } = makeCore(historyStore);
    await historyStore.create('wf', 'w', []);

    for (const reason of ['first', 'second', 'third']) {
      workflowTaskQueue.enqueue('wf');
      const task = await core.pollWorkflowTask();
      await core.failWorkflowTask(task!.token, reason);
      await wait(120); // let the backoff'd wake land before re-polling
    }

    const rec = await historyStore.get('wf');
    expect(rec!.taskFailures).toBe(3);
    expect(rec!.lastTaskFailure).toBe('third');
  });

  it('re-queues the execution after a backoff instead of dropping it', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, workflowTaskQueue } = makeCore(historyStore);
    await historyStore.create('wf', 'w', []);
    workflowTaskQueue.enqueue('wf');

    const task = await core.pollWorkflowTask();
    await core.failWorkflowTask(task!.token, 'boom');

    expect(workflowTaskQueue.poll()).toBeUndefined(); // held back, not immediate
    await wait(150);
    expect(workflowTaskQueue.poll()?.workflowId).toBe('wf'); // and it does come back
  });

  // Without this the count is a high-water mark rather than a measure of what is
  // wrong now, and the backoff would keep growing after the trouble passed.
  it('forgets past failures once a task succeeds', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, workflowTaskQueue } = makeCore(historyStore);
    await historyStore.create('wf', 'w', []);
    workflowTaskQueue.enqueue('wf');

    const failed = await core.pollWorkflowTask();
    await core.failWorkflowTask(failed!.token, 'boom');
    await wait(150);

    const retried = await core.pollWorkflowTask();
    await core.completeWorkflowTask(retried!.token, {
      done: true,
      result: 'ok',
      failed: false,
      failure: undefined,
      commands: [],
    });

    const rec = await historyStore.get('wf');
    expect(rec!.taskFailures).toBe(0);
    expect(rec!.lastTaskFailure).toBeUndefined();
  });

  it('does not bump the version, so a racing worker can still complete', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, workflowTaskQueue } = makeCore(historyStore);
    await historyStore.create('wf', 'w', []);
    workflowTaskQueue.enqueue('wf');
    const before = (await historyStore.get('wf'))!.version;

    const task = await core.pollWorkflowTask();
    await core.failWorkflowTask(task!.token, 'boom');

    expect((await historyStore.get('wf'))!.version).toBe(before);
  });
});

describe('recovering a wedged execution', () => {
  /**
   * The whole justification for retrying forever: the fix is a code deploy. A
   * worker whose registry throws wedges the execution; swapping in a corrected
   * workflow — what rolling the workers does — lets it replay and finish, with no
   * intervention on the execution itself.
   */
  it('completes after the broken workflow code is replaced', async () => {
    const historyStore = new MemoryHistoryStore();
    const { core, workflowTaskQueue } = makeCore(historyStore);

    const broken = createWorkflowRegistry();
    broken.set('doer', () => {
      throw new Error('nondeterminism at seq 0');
    });
    const brokenWorker = createWorkflowWorker(broken);

    const fixed = createWorkflowRegistry();
    fixed.set('doer', async () => 'finished');
    const fixedWorker = createWorkflowWorker(fixed);

    await historyStore.create('wf', 'doer', []);
    workflowTaskQueue.enqueue('wf');

    // The deployed-but-broken worker: replay throws, the failure is reported.
    // Captured rather than try/caught, so a replay that *doesn't* throw fails the
    // test instead of being swallowed by the handler meant for the throw.
    const first = await core.pollWorkflowTask();
    const reason = await brokenWorker
      .replayTask(first!.name, first!.args, first!.history, false)
      .then(
        () => undefined,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
    expect(reason).toBe('nondeterminism at seq 0');

    await core.failWorkflowTask(first!.token, reason!);
    expect((await historyStore.get('wf'))!.status).toBe('running');

    // Roll the workers. The retry lands on corrected code.
    await wait(150);
    const retry = await core.pollWorkflowTask();
    const result = await fixedWorker.replayTask(
      retry!.name,
      retry!.args,
      retry!.history,
      false,
    );
    await core.completeWorkflowTask(retry!.token, result);

    const rec = await historyStore.get('wf');
    expect(rec!.status).toBe('completed');
    expect(rec!.result).toBe('finished');
    expect(rec!.taskFailures).toBe(0);
  });
});

/**
 * @fileoverview
 * The commands a workflow issues in the task that finishes it.
 *
 * One activation can both dispatch and complete — `signalWorkflow(parent, done);
 * return result;` — and the terminal dispositions in `applyWorkflowTaskResult`
 * all return early. A batch reaching them undispatched is discarded: the
 * execution completes normally, having silently not done what its last line said,
 * with nothing raised anywhere. The fire-and-forget commands wear it worst,
 * because they are the ones with no promise whose absence would be noticed.
 *
 * ## Dispatching is not the same as surviving
 *
 * The two child specs below look like a contradiction and are not. Both children
 * are launched — that is the fix. What happens to each *next* is its
 * parent-close policy, applied a moment later by the same close: the default
 * terminates it, `abandon` leaves it running. A child spawned as a workflow's
 * last act under the default policy is a self-contradiction ("serve me, and I am
 * done"), and being launched-then-closed is the honest reading of it. `abandon`
 * is what the fire-and-forget-follow-up shape actually wants, and it is the one
 * that could not work at all before this.
 *
 * The last spec records what is still dropped. A rollover empties history, so a
 * marker written a moment before it is erased — and an armed timer whose
 * `timerStarted` went with it fires into a fresh run that never issued that seq,
 * which is a nondeterminism error rather than lost work. That is a worse failure
 * than the one being fixed, so `continueAsNew` keeps dropping the batch until it
 * has a design of its own. It is a gap, and it is asserted so that closing it is
 * a visible change rather than a silent one.
 */

import {createLocalRuntime} from '../../src';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
} from '../../src/server';
import {condition, startChild} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** A runtime whose parent spawns one child under `policy` and returns at once. */
function spawnerRuntime(
  store: MemoryHistoryStore,
  childId: string,
  policy: 'abandon' | undefined,
) {
  return createLocalRuntime({historyStore: store})
    .registerWorkflow('leaf', async () => {
      await condition(() => false); // never settles on its own
      return 'unreachable';
    })
    .registerWorkflow('spawner', async () => {
      startChild('leaf', {workflowId: childId, parentClosePolicy: policy});
      return 'spawned';
    });
}

describe('commands issued by the task that finishes a workflow', () => {
  it('launches a fire-and-forget child spawned on the way out', async () => {
    const store = new MemoryHistoryStore();
    spawnerRuntime(store, 'leaf-1', 'abandon').start('spawner', undefined, {
      workflowId: 'sp-1',
    });
    await wait(200);

    expect((await store.get('sp-1'))?.status).toBe('completed');
    expect((await store.get('leaf-1'))?.status).toBe('running');
  });

  /**
   * The same dispatch, under the default policy: launched, then closed by the
   * parent that launched it. `terminated` rather than absent is the evidence the
   * command was dispatched at all — a dropped one would leave no record here.
   */
  it('closes that child immediately when it was not asked to outlive its parent', async () => {
    const store = new MemoryHistoryStore();
    spawnerRuntime(store, 'leaf-2', undefined).start('spawner', undefined, {
      workflowId: 'sp-2',
    });
    await wait(200);

    expect((await store.get('leaf-2'))?.status).toBe('terminated');
  });

  /**
   * The gap that remains, asserted rather than only described — driven at the
   * server so the batch's shape is explicit: one dispatch, then the rollover.
   */
  it('still drops a command issued in the same task as a continueAsNew', async () => {
    const store = new MemoryHistoryStore();
    let launched = 0;
    const core = createServerCore({
      historyStore: store,
      workflowTaskQueue: new MemoryWorkflowTaskQueue(),
      activityTaskQueue: new MemoryTaskQueue(),
      timerService: new MemoryTimerService(),
      launch: () => {
        launched += 1;
      },
      kickWorkflowWorker: () => {},
      kickActivityWorker: () => {},
    });
    await store.create('roller', 'w', []);

    await core.applyWorkflowTaskResult('roller', {
      done: false,
      result: undefined,
      failed: false,
      failure: undefined,
      commands: [
        {
          type: 'startChild',
          seq: 0,
          childName: 'leaf',
          childProps: undefined,
          detached: true,
          parentClosePolicy: 'abandon',
        },
        {type: 'continueAsNew', seq: 1, props: undefined},
      ],
    });

    expect(launched).toBe(0);
    expect((await store.get('roller'))!.runId).toBe(1); // the rollover did happen
  });
});

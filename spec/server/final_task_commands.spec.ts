/**
 * @fileoverview
 * The commands a workflow issues in the task that finishes it.
 *
 * One activation can both dispatch and complete — `startChild(worker); return
 * 'done';` — and the terminal dispositions in `applyWorkflowTaskResult` all
 * return early. The batch used to reach them and be discarded: the execution
 * completed normally, having silently not done what its last line said, with
 * nothing raised anywhere. The fire-and-forget commands wear it worst, because
 * they are the ones with no promise whose absence would be noticed.
 *
 * The last spec here records what is still dropped. A rollover empties history,
 * so a marker written a moment before it is erased — and an armed timer whose
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
import {startChild} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('commands issued by the task that finishes a workflow', () => {
  it('launches a detached child spawned on the way out', async () => {
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('leaf', async () => 'ran')
      .registerWorkflow('spawner', async () => {
        startChild('leaf', {workflowId: 'leaf-1'});
        return 'spawned';
      })
      .start('spawner', [], {workflowId: 'sp-1'});
    await wait(200);

    expect((await store.get('leaf-1'))?.status).toBe('completed');
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
          childArgs: [],
          detached: true,
        },
        {type: 'continueAsNew', seq: 1, args: []},
      ],
    });

    expect(launched).toBe(0);
    expect((await store.get('roller'))!.runId).toBe(1); // the rollover did happen
  });
});

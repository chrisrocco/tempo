/**
 * @fileoverview
 * Routing work to a pool of workers. The problem it solves is not exotic: with
 * one global queue, two applications sharing a server hand each other's tasks
 * back and forth, and whichever worker wins a poll decides whether the task can
 * run at all.
 *
 * The default that carries the design is **inheritance** — an activity runs on
 * its execution's queue unless it says otherwise. Without it an app's workflows
 * would land on its workers while its activities went somewhere else, which is
 * the kind of failure that reads as a mystery rather than a misconfiguration.
 */

import type {ActivityOptions} from '../../src';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
} from '../../src/server';

function makeCore(historyStore = new MemoryHistoryStore()) {
  const workflowTaskQueue = new MemoryWorkflowTaskQueue();
  const activityTaskQueue = new MemoryTaskQueue();
  const launched: {workflowId: string; taskQueue: string}[] = [];
  const core = createServerCore({
    historyStore,
    workflowTaskQueue,
    activityTaskQueue,
    timerService: new MemoryTimerService(),
    launch: (workflowId, name, args, taskQueue) => {
      launched.push({workflowId, taskQueue});
      void historyStore
        .create(workflowId, name, args, taskQueue)
        .catch(() => {});
      workflowTaskQueue.enqueue(workflowId, taskQueue);
    },
    kickWorkflowWorker: () => {},
    kickActivityWorker: () => {},
  });
  return {core, workflowTaskQueue, activityTaskQueue, historyStore, launched};
}

function scheduleActivity(seq: number, options: ActivityOptions = {}) {
  return {
    done: false,
    result: undefined,
    failed: false,
    failure: undefined,
    commands: [
      {
        type: 'scheduleActivity' as const,
        seq,
        name: 'work',
        args: [],
        options,
      },
    ],
  };
}

describe('workflow tasks route to their execution', () => {
  it('is offered only to a worker polling its queue', async () => {
    const {core, workflowTaskQueue, historyStore} = makeCore();
    await historyStore.create('wf', 'w', [], 'gpu');
    workflowTaskQueue.enqueue('wf', 'gpu');

    expect(await core.pollWorkflowTask({taskQueue: 'cpu'})).toBeUndefined();
    expect((await core.pollWorkflowTask({taskQueue: 'gpu'}))?.workflowId).toBe(
      'wf',
    );
  });

  // The in-process runtime serves everything with one set of loops, so it must
  // keep working whatever queue names a workflow is started on.
  it('is offered to a poller that names no queue at all', async () => {
    const {core, workflowTaskQueue, historyStore} = makeCore();
    await historyStore.create('wf', 'w', [], 'gpu');
    workflowTaskQueue.enqueue('wf', 'gpu');

    expect((await core.pollWorkflowTask())?.workflowId).toBe('wf');
  });

  it('keeps its routing across a wake that does not mention a queue', async () => {
    const {core, workflowTaskQueue, historyStore} = makeCore();
    await historyStore.create('wf', 'w', [], 'gpu');
    workflowTaskQueue.enqueue('wf', 'gpu');
    const first = await core.pollWorkflowTask({taskQueue: 'gpu'});
    workflowTaskQueue.complete(first!.token);

    // A signal wakes it without repeating the queue — the common case, since
    // most wakes have no idea how the execution was routed.
    await core.appendSignal('wf', 'ping', 1);

    expect(await core.pollWorkflowTask({taskQueue: 'cpu'})).toBeUndefined();
    expect((await core.pollWorkflowTask({taskQueue: 'gpu'}))?.workflowId).toBe(
      'wf',
    );
  });
});

describe('activities inherit their execution queue', () => {
  it('goes to the execution queue when the activity names none', async () => {
    const {core, historyStore} = makeCore();
    await historyStore.create('wf', 'w', [], 'agents');

    await core.applyWorkflowTaskResult('wf', scheduleActivity(0));

    expect(await core.pollActivityTask({taskQueue: 'default'})).toBeUndefined();
    expect((await core.pollActivityTask({taskQueue: 'agents'}))?.name).toBe(
      'work',
    );
  });

  it('goes to the queue the activity names, overriding its execution', async () => {
    const {core, historyStore} = makeCore();
    await historyStore.create('wf', 'w', [], 'agents');

    await core.applyWorkflowTaskResult(
      'wf',
      scheduleActivity(0, {taskQueue: 'gpu'}),
    );

    expect(await core.pollActivityTask({taskQueue: 'agents'})).toBeUndefined();
    expect((await core.pollActivityTask({taskQueue: 'gpu'}))?.name).toBe(
      'work',
    );
  });

  it('still inherits after a restart re-dispatches it from history', async () => {
    const historyStore = new MemoryHistoryStore();
    await historyStore.create('wf', 'w', [], 'agents');
    await historyStore.append('wf', [
      {
        type: 'activityScheduled',
        seq: 0,
        name: 'work',
        args: [],
        options: {},
      },
    ]);

    const restarted = makeCore(historyStore);
    await restarted.core.resumeFromHistory(await historyStore.list());

    expect(
      await restarted.core.pollActivityTask({taskQueue: 'default'}),
    ).toBeUndefined();
    expect(
      (await restarted.core.pollActivityTask({taskQueue: 'agents'}))?.name,
    ).toBe('work');
  });
});

describe('children inherit their parent queue', () => {
  it('runs on the parent queue when the child names none', async () => {
    const {core, historyStore, launched} = makeCore();
    await historyStore.create('parent', 'w', [], 'agents');

    await core.applyWorkflowTaskResult('parent', {
      done: false,
      result: undefined,
      failed: false,
      failure: undefined,
      commands: [
        {
          type: 'startChild',
          seq: 0,
          childName: 'kid',
          childArgs: [],
          detached: true,
          parentClosePolicy: 'abandon',
        },
      ],
    });

    expect(launched).toEqual([{workflowId: 'parent.0.0', taskQueue: 'agents'}]);
  });

  it('runs on the queue the child names', async () => {
    const {core, historyStore, launched} = makeCore();
    await historyStore.create('parent', 'w', [], 'agents');

    await core.applyWorkflowTaskResult('parent', {
      done: false,
      result: undefined,
      failed: false,
      failure: undefined,
      commands: [
        {
          type: 'startChild',
          seq: 0,
          childName: 'kid',
          childArgs: [],
          detached: true,
          parentClosePolicy: 'abandon',
          taskQueue: 'gpu',
        },
      ],
    });

    expect(launched[0].taskQueue).toBe('gpu');
  });
});

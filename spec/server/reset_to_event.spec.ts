/**
 * @fileoverview
 * Rewinding an execution to an earlier point in its own history.
 *
 * `terminate` was the only control that reached a wedged execution, and it ends
 * it. Reset is the one that keeps the work: truncate to before whatever the
 * deployed code cannot replay, and re-drive.
 *
 * The happy path is nearly uninteresting. What these cover is the window the
 * operation opens: everything dispatched after the cut is still out with
 * workers, and a completion landing afterwards would be an outcome for a command
 * the truncated history never issued — which replay throws on, wedging the
 * execution the reset was meant to rescue.
 */

import type {WorkflowFn} from '../../src/core';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
  type HistoryStore,
} from '../../src/server';
import {createLocalService} from '../../src/services';
import {
  createActivityRegistry,
  createActivityWorker,
  createWorkflowRegistry,
  createWorkflowWorker,
  type ActivityFn,
} from '../../src/worker';
import {runActivity, sleep} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * A service with in-process workers, built directly.
 *
 * Not through `createLocalRuntime`: `Runtime` is the author-facing surface and
 * does not expose reset, which is deliberate — whether a workflow author should
 * be able to rewind their own execution is a separate question from whether an
 * operator can. An operator tool reaches this through the RPC, which is this
 * seam.
 */
function serviceOver(
  store: HistoryStore,
  workflows: Record<string, WorkflowFn>,
  activities: Record<string, ActivityFn> = {},
) {
  const workflowRegistry = createWorkflowRegistry();
  const activityRegistry = createActivityRegistry();
  for (const [name, fn] of Object.entries(workflows))
    workflowRegistry.set(name, fn);
  for (const [name, fn] of Object.entries(activities))
    activityRegistry.set(name, fn);
  return createLocalService(
    createWorkflowWorker(workflowRegistry),
    createActivityWorker(activityRegistry),
    store,
  );
}

describe('resetting an execution', () => {
  it('drops the events after the cut and replays from there', async () => {
    const store = new MemoryHistoryStore();
    let calls = 0;
    const service = serviceOver(
      store,
      {
        counter: async () => {
          await runActivity<number>('count');
          await runActivity<number>('count');
          return 'done';
        },
      },
      {count: () => ++calls},
    );

    service.start('counter', [], {workflowId: 'c-1'});
    await wait(200);
    expect((await store.get('c-1'))?.status).toBe('completed');
    const ranBefore = calls;

    // Back to before the first activity was even scheduled.
    service.reset('c-1', 0);
    await wait(300);

    expect((await store.get('c-1'))?.status).toBe('completed');
    // It re-ran the work rather than resuming from the recorded results.
    expect(calls).toBeGreaterThan(ranBefore);
    service.shutdown();
  });

  it('clears the failure count, which is why anyone is resetting', async () => {
    // A wedged execution reads `running` with a non-zero count; leaving the
    // count would keep it looking stuck until a task happened to succeed.
    const store = new MemoryHistoryStore();
    const service = serviceOver(store, {
      waiter: async () => {
        await sleep(60_000);
        return 'done';
      },
    });
    service.start('waiter', [], {workflowId: 'r-1'});
    await wait(150);
    await store.recordTaskFailure('r-1', 'nondeterminism at seq 2');
    expect((await store.get('r-1'))?.taskFailures).toBe(1);

    service.reset('r-1', 0);
    await wait(200);

    expect((await store.get('r-1'))?.taskFailures).toBe(0);
    service.shutdown();
  });

  it('bumps the version, so a task already in flight cannot append onto it', async () => {
    // The window on the workflow-task side: a task polled before the reset
    // carries the version it replayed against, and its CAS has to fail after.
    const store = new MemoryHistoryStore();
    const service = serviceOver(store, {
      waiter: async () => {
        await sleep(60_000);
        return 'done';
      },
    });
    service.start('waiter', [], {workflowId: 'v-1'});
    await wait(150);

    const before = (await store.get('v-1'))!.version;
    service.reset('v-1', 0);
    await wait(200);

    expect((await store.get('v-1'))!.version).toBeGreaterThan(before);
    service.shutdown();
  });

  it('cancels a timer whose marker the cut removed', async () => {
    // Otherwise the old timer fires against a history that no longer scheduled
    // it, and `timerFired` arrives for a seq replay never dispatched.
    const store = new MemoryHistoryStore();
    const service = serviceOver(store, {
      waiter: async () => {
        await sleep(60_000);
        return 'done';
      },
    });
    service.start('waiter', [], {workflowId: 't-1'});
    await wait(150);
    expect(
      (await store.get('t-1'))!.history.some((e) => e.type === 'timerStarted'),
    ).toBeTrue();

    service.reset('t-1', 0);
    await wait(250);

    // Replay re-issued exactly one timer rather than leaving two armed.
    const timers = (await store.get('t-1'))!.history.filter(
      (e) => e.type === 'timerStarted',
    );
    expect(timers.length).toBe(1);
    expect((await store.get('t-1'))!.taskFailures).toBe(0);
    service.shutdown();
  });

  it('reopens a failed execution and clears the outcome it no longer has', async () => {
    // The second reason to reach for this, after a wedged execution: the code
    // was fixed and the work should run again from before it went wrong. A
    // settled record would otherwise swallow the task — `buildWorkflowTask`
    // only builds for a running one — and truncate the history for nothing.
    const store = new MemoryHistoryStore();
    let failing = true;
    const service = serviceOver(
      store,
      {maybe: async () => runActivity<string>('flaky')},
      {
        flaky: () => {
          if (failing) throw new Error('not yet');
          return 'worked';
        },
      },
    );
    service.start('maybe', [], {workflowId: 'f-1'});
    await wait(250);
    expect((await store.get('f-1'))?.status).toBe('failed');

    failing = false; // the fix
    service.reset('f-1', 0);
    await wait(300);

    const rec = await store.get('f-1');
    expect(rec?.status).toBe('completed');
    expect(rec?.result).toBe('worked');
    expect(rec?.failure).toBeUndefined();
    service.shutdown();
  });

  it('leaves an execution alone when the cut is past the end', async () => {
    // A history that grew between reading it and acting on it is ordinary, so
    // an out-of-range cut clamps to a no-op rather than failing.
    const store = new MemoryHistoryStore();
    const service = serviceOver(
      store,
      {short: async () => runActivity<number>('noop')},
      {noop: () => 1},
    );
    service.start('short', [], {workflowId: 's-1'});
    await wait(200);

    const before = (await store.get('s-1'))!.history.length;
    service.reset('s-1', 9_999);
    await wait(200);

    expect((await store.get('s-1'))!.history.length).toBe(before);
    service.shutdown();
  });
});

/**
 * The log line, against a core built directly so a logger can be injected.
 *
 * Worth its own block because the bug it guards is invisible from the outside:
 * `MemoryHistoryStore.get` hands back the *live* record, so any field read after
 * the truncate describes the state after it. The first version of this reported
 * "dropped 0" for every reset, and the count is the only durable trace of what a
 * destructive operation destroyed.
 */
describe('what a reset records about itself', () => {
  it('reports the events it dropped, read before dropping them', async () => {
    const store = new MemoryHistoryStore();
    const lines: {event: string; data: Record<string, unknown> | undefined}[] =
      [];
    const core = createServerCore({
      historyStore: store,
      workflowTaskQueue: new MemoryWorkflowTaskQueue(),
      activityTaskQueue: new MemoryTaskQueue(),
      timerService: new MemoryTimerService(),
      launch: () => {},
      kickWorkflowWorker: () => {},
      kickActivityWorker: () => {},
      log: (event, data) => lines.push({event, data}),
    });

    await store.create('wf', 'w', []);
    await store.append('wf', [
      {type: 'timerStarted', seq: 0, fireAt: Date.now() + 60_000},
      {type: 'timerFired', seq: 0},
      {type: 'signal', name: 'go', payload: undefined},
    ]);
    await store.recordTaskFailure('wf', 'nondeterminism at seq 0');

    await core.resetToEvent('wf', 1);

    const reset = lines.find((l) => l.event === 'execution.reset')?.data ?? {};
    expect(reset['keep']).toBe(1);
    expect(reset['dropped']).toBe(2);
    // Also read before it was cleared, for the same reason.
    expect(reset['taskFailures']).toBe(1);
    expect((await store.get('wf'))!.history.length).toBe(1);
  });
});

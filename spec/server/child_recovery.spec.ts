/**
 * @fileoverview
 * Child dispatch across a restart: that a child workflow is launched exactly once
 * no matter how many times its parent is replayed, and that a parent resumed from
 * history can still reach its children to cancel them.
 *
 * Driven against a headless `server_core` with an injected `launch`, because that
 * is the only seam where a *duplicate dispatch* is directly observable: a second
 * dispatch of the same child now reuses its derived id, so counting executions
 * would show one either way.
 *
 * The fire-and-forget case is the one that regressed: it has no completion event,
 * so its `childStarted` marker is the only thing standing between a resumed parent
 * and a second child. Internals specs, for contributors.
 */

import { createContext, replay, type WorkflowFn } from '../../src/core';
import type { ExecutionRecord } from '../../src/server';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  childExecutionId,
  createServerCore,
  type ServerCore,
} from '../../src/server';
import { condition, executeChild, startChild } from '../../src/workflow';

interface Harness {
  core: ServerCore;
  /** The child workflows this server actually dispatched, in order. */
  launched: string[];
}

/**
 * A fresh server over an existing store — a restarted process. `launch` records
 * what it was asked to start and creates the child's record, as the real
 * composition roots do.
 */
function serverOver(store: MemoryHistoryStore): Harness {
  const launched: string[] = [];
  const core = createServerCore({
    historyStore: store,
    workflowTaskQueue: new MemoryWorkflowTaskQueue(),
    activityTaskQueue: new MemoryTaskQueue(),
    timerService: new MemoryTimerService(),
    // The core now picks the child's id; a host only creates the record.
    launch: (workflowId, name, args) => {
      launched.push(name);
      void store.create(workflowId, name, args).catch(() => {});
    },
    kickWorkflowWorker: () => {},
    kickActivityWorker: () => {},
  });
  return { core, launched };
}

/** One workflow task, exactly as a worker runs it: build, replay, apply. */
async function runTask(
  core: ServerCore,
  workflowId: string,
  fn: WorkflowFn,
): Promise<void> {
  const task = await core.buildWorkflowTask(workflowId);
  if (!task) return;
  const ctx = createContext(
    task.args,
    task.history,
    task.continueAsNewSuggested,
  );
  await replay(ctx, fn);
  await core.applyWorkflowTaskResult(workflowId, {
    done: ctx.done,
    result: ctx.result,
    failed: ctx.failed,
    failure: ctx.failure,
    commands: ctx.commands,
  });
}

/** The monitor shape: spawn a detached child, then park indefinitely. */
const spawner: WorkflowFn = async () => {
  startChild('ticker');
  await condition(() => false);
};

function childOf(records: ExecutionRecord[]): ExecutionRecord {
  const child = records.find((r) => r.name === 'ticker');
  if (!child) throw new Error('no child execution was created');
  return child;
}

describe('server child dispatch — the fire-and-forget marker', () => {
  it('records a childStarted marker for a fire-and-forget child', async () => {
    const store = new MemoryHistoryStore();
    await store.create('par', 'spawner', []);

    await runTask(serverOver(store).core, 'par', spawner);

    const history = (await store.get('par'))!.history;
    expect(history).toEqual([
      {
        type: 'childStarted',
        seq: 0,
        childId: childExecutionId('par', 0, 0),
        detached: true,
      },
    ]);
  });

  /**
   * The regression. Without the marker the `startChild` command stays in front of
   * the live edge forever, so every subsequent replay re-emits it — and a resumed
   * parent silently acquires a second child.
   */
  it('does not launch the child a second time when the parent is replayed', async () => {
    const store = new MemoryHistoryStore();
    await store.create('par', 'spawner', []);
    const first = serverOver(store);
    await runTask(first.core, 'par', spawner);
    expect(first.launched).toEqual(['ticker']);

    await runTask(first.core, 'par', spawner); // a second activation, same history

    expect(first.launched).toEqual(['ticker']);
  });

  it('does not launch the child a second time after the server restarts', async () => {
    const store = new MemoryHistoryStore();
    await store.create('par', 'spawner', []);
    await runTask(serverOver(store).core, 'par', spawner);

    // the process dies; a fresh server comes up on the same durable records
    const restarted = serverOver(store);
    await restarted.core.resumeFromHistory(await store.list());
    await runTask(restarted.core, 'par', spawner);

    expect(restarted.launched).toEqual([]);
  });

  /**
   * `childrenByParent` is in-memory, so cancellation can only reach a detached
   * child after a restart if the marker rebuilt the link — the second thing lost
   * when the event was not recorded.
   */
  it('cascades cancellation to a fire-and-forget child after the server restarts', async () => {
    const store = new MemoryHistoryStore();
    await store.create('par', 'spawner', []);
    await runTask(serverOver(store).core, 'par', spawner);

    const restarted = serverOver(store);
    await restarted.core.resumeFromHistory(await store.list());
    await restarted.core.requestCancel('par');

    const child = childOf(await store.list());
    expect(child.history).toContain({ type: 'cancelRequested' });
  });
});

describe('server child dispatch — blocking children still correlate', () => {
  const blocking: WorkflowFn = async () => executeChild('ticker');

  it('marks a blocking child as not detached', async () => {
    const store = new MemoryHistoryStore();
    await store.create('par', 'blocking', []);

    await runTask(serverOver(store).core, 'par', blocking);

    expect((await store.get('par'))!.history).toEqual([
      {
        type: 'childStarted',
        seq: 0,
        childId: childExecutionId('par', 0, 0),
        detached: false,
      },
    ]);
  });

  /**
   * A blocking child that finished while the server was down still has to hand
   * its result to the parent — the branch the detached case must not fall into.
   */
  it('delivers the result of a blocking child that completed during the outage', async () => {
    const store = new MemoryHistoryStore();
    await store.create('par', 'blocking', []);
    await runTask(serverOver(store).core, 'par', blocking);
    await store.setStatus(childExecutionId('par', 0, 0), 'completed', {
      result: 'child-result',
    });

    const restarted = serverOver(store);
    await restarted.core.resumeFromHistory(await store.list());

    expect((await store.get('par'))!.history).toContain({
      type: 'childCompleted',
      seq: 0,
      result: 'child-result',
    });
  });
});

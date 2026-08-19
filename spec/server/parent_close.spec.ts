/**
 * @fileoverview
 * Parent-close policy: what happens to a child when the execution that started
 * it closes, and what deliberately does not.
 *
 * Four things are being pinned here, and the last two are the ones worth reading
 * before changing any of this:
 *
 * - The three policies, against all three ways of closing.
 * - That the teardown **recurses**, because `terminate` is itself a close.
 * - That a **cancel already in flight wins over `terminate`**. Cancelling a
 *   parent cascades, then the parent's own failure arrives here a moment later —
 *   and terminating the child at that point would cut short the cleanup the
 *   cascade just asked for, quietly turning "cancel a parent" into "terminate its
 *   children".
 * - That a `childStarted` marker with **no policy on it** means abandon. Those
 *   were written before policies existed, when the engine left every child
 *   running, so the absent field records what actually happened rather than what
 *   the default is now — which is what keeps this change from altering the
 *   behaviour of executions that were already in flight when it deployed.
 *
 * The parents here `sleep` before returning. That is not incidental: a
 * `startChild` issued in the same task that finishes the workflow is currently
 * dropped, so the child has to be dispatched by an earlier task for there to be
 * anything to close.
 */

import {createLocalRuntime} from '../../src';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
} from '../../src/server';
import type {ParentClosePolicy} from '../../src/protocol';
import {condition, sleep, startChild} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * A parent that spawns one child under `policy` and then settles however it is
 * told, and a child that runs until something stops it.
 */
function runtimeWith(
  store: MemoryHistoryStore,
  childId: string,
  policy: ParentClosePolicy | undefined,
  finish: () => string,
) {
  return createLocalRuntime({historyStore: store})
    .registerWorkflow('ticker', async () => {
      await condition(() => false);
      return 'unreachable';
    })
    .registerWorkflow('parent', async () => {
      startChild('ticker', {workflowId: childId, parentClosePolicy: policy});
      await sleep(5); // park, so the spawn is dispatched before this run ends
      return finish();
    });
}

function boom(): string {
  throw new Error('parent blew up');
}

describe('a child whose parent has closed', () => {
  it('is terminated by default when the parent completes', async () => {
    const store = new MemoryHistoryStore();
    runtimeWith(store, 'kid-1', undefined, () => 'done').start(
      'parent',
      undefined,
      {
        workflowId: 'par-1',
      },
    );
    await wait(200);

    expect((await store.get('par-1'))?.status).toBe('completed');
    const kid = await store.get('kid-1');
    expect(kid?.status).toBe('terminated');
    // The reason names the parent, so an operator meeting a terminated execution
    // is not left guessing who ended it.
    expect(String((kid?.failure as Error).message)).toContain('par-1');
  });

  it('is terminated when the parent fails', async () => {
    const store = new MemoryHistoryStore();
    runtimeWith(store, 'kid-2', undefined, boom).start('parent', undefined, {
      workflowId: 'par-2',
    });
    await wait(200);

    expect((await store.get('par-2'))?.status).toBe('failed');
    expect((await store.get('kid-2'))?.status).toBe('terminated');
  });

  it('is terminated when the parent is terminated', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerWorkflow('ticker', async () => {
        await condition(() => false);
        return 'unreachable';
      })
      .registerWorkflow('parent', async () => {
        startChild('ticker', {workflowId: 'kid-3'});
        await condition(() => false);
        return 'unreachable';
      });

    const handle = rt.start('parent', undefined, {workflowId: 'par-3'});
    await wait(50);
    handle.terminate('operator pulled it');
    await wait(100);

    expect((await store.get('par-3'))?.status).toBe('terminated');
    expect((await store.get('kid-3'))?.status).toBe('terminated');
  });

  it('keeps running under `abandon`', async () => {
    const store = new MemoryHistoryStore();
    runtimeWith(store, 'kid-4', 'abandon', () => 'done').start(
      'parent',
      undefined,
      {
        workflowId: 'par-4',
      },
    );
    await wait(200);

    expect((await store.get('par-4'))?.status).toBe('completed');
    expect((await store.get('kid-4'))?.status).toBe('running');
  });

  /**
   * `cancel` is the cooperative one: the child is asked, and unwinds through its
   * own control flow rather than being cut off. It ends as `failed` carrying a
   * `CancelledFailure`, which is what an uncaught cancellation looks like
   * anywhere in this engine — the distinction from `terminate` is that the child
   * got to run its `finally` blocks on the way out.
   */
  it('is asked to unwind under `cancel`', async () => {
    const store = new MemoryHistoryStore();
    runtimeWith(store, 'kid-5', 'cancel', () => 'done').start(
      'parent',
      undefined,
      {
        workflowId: 'par-5',
      },
    );
    await wait(200);

    const kid = await store.get('kid-5');
    expect(kid?.history).toContain(
      jasmine.objectContaining({type: 'cancelRequested'}),
    );
    expect(kid?.status).toBe('failed');
  });

  /** Terminating a child is itself a close, so the teardown reaches the whole tree. */
  it('takes a grandchild down with it', async () => {
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('grandchild', async () => {
        await condition(() => false);
        return 'unreachable';
      })
      .registerWorkflow('child', async () => {
        startChild('grandchild', {workflowId: 'grand-1'});
        await condition(() => false);
        return 'unreachable';
      })
      .registerWorkflow('parent', async () => {
        startChild('child', {workflowId: 'kid-6'});
        await sleep(30); // long enough for the grandchild to be dispatched
        return 'done';
      })
      .start('parent', undefined, {workflowId: 'par-6'});
    await wait(300);

    expect((await store.get('kid-6'))?.status).toBe('terminated');
    expect((await store.get('grand-1'))?.status).toBe('terminated');
  });

  /**
   * The interaction that would otherwise turn cancelling a parent into
   * terminating its children: the cascade asks the child to unwind, and the
   * parent's own cancelled failure reaches `closeChildren` while it is still
   * doing so.
   */
  it('is left to unwind when the parent was cancelled rather than closed', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerWorkflow('ticker', async () => {
        try {
          await condition(() => false);
          return 'unreachable';
        } finally {
          // A real cleanup step would go here; what matters is that the child
          // reaches it rather than being cut off mid-flight.
        }
      })
      .registerWorkflow('parent', async () => {
        startChild('ticker', {workflowId: 'kid-7'});
        await condition(() => false);
        return 'unreachable';
      });

    const handle = rt.start('parent', undefined, {workflowId: 'par-7'});
    await wait(50);
    handle.cancel();
    await wait(150);

    const kid = await store.get('kid-7');
    expect(kid?.history).toContain(
      jasmine.objectContaining({type: 'cancelRequested'}),
    );
    expect(kid?.status).toBe('failed'); // unwound, not terminated
  });

  /**
   * A settle nobody asked for still has to reach whoever is waiting. Local mode
   * learns outcomes by watching its own drain loop, and a terminate produces no
   * task — so before `onSettled` existed, a child terminated by its parent's
   * policy read as `running` forever and its `getResult` never returned.
   */
  it('is reported to a caller holding its result promise', async () => {
    const rt = createLocalRuntime()
      .registerWorkflow('ticker', async () => {
        await condition(() => false);
        return 'unreachable';
      })
      .registerWorkflow('parent', async () => {
        startChild('ticker', {workflowId: 'awaited-1'});
        await sleep(5);
        return 'done';
      });

    rt.start('parent', undefined, {workflowId: 'par-8'});
    const child = rt.getHandle('awaited-1');

    await expectAsync(child.result()).toBeRejected();
    expect(child.status()).toBe('terminated');
  });

  it('keeps running when its marker predates parent-close policies', async () => {
    const store = new MemoryHistoryStore();
    const core = createServerCore({
      historyStore: store,
      workflowTaskQueue: new MemoryWorkflowTaskQueue(),
      activityTaskQueue: new MemoryTaskQueue(),
      timerService: new MemoryTimerService(),
      launch: () => {},
      kickWorkflowWorker: () => {},
      kickActivityWorker: () => {},
    });
    await store.create('old-par', 'parent', []);
    await store.create('old-kid', 'ticker', []);
    // A marker as it was written before the field existed — no policy on it.
    await store.append('old-par', [
      {type: 'childStarted', seq: 0, childId: 'old-kid', detached: true},
    ]);
    await core.resumeFromHistory(await store.list());

    await core.terminate('old-par', 'operator pulled it');

    expect((await store.get('old-kid'))?.status).toBe('running');
  });
});

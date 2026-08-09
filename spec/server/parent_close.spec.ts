/**
 * @fileoverview
 * What happens to a child when its parent closes: nothing.
 *
 * This is the behaviour `server_core`'s header used to describe backwards, by
 * contrasting continue-as-new's "children survive" with what "a genuine
 * completion or termination does" — which reads as though closing tears children
 * down. It never has. Cancellation is the only thing that walks downward.
 *
 * Pinned here because it is a default rather than a decision, and issue #58 owns
 * changing it. A parent-close policy landing should make these expectations fail
 * and be rewritten, which is the point: the change should be visible in a diff
 * rather than discovered by an operator whose poller stopped.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import {condition, sleep, startChild} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * A parent that spawns one detached child and then settles however it is told.
 *
 * The `sleep` is load-bearing: it parks the parent, so the spawn is dispatched
 * by one task and the settling happens in the next. Without it both land in one
 * batch, and what that does is a separate question from this one.
 */
function runtimeWith(store: MemoryHistoryStore, finish: () => string) {
  return createLocalRuntime({historyStore: store})
    .registerWorkflow('ticker', async () => {
      await condition(() => false);
      return 'unreachable';
    })
    .registerWorkflow('parent', async () => {
      startChild('ticker', {workflowId: 'kid-1'});
      await sleep(5);
      return finish();
    });
}

describe('a child whose parent has closed', () => {
  it('keeps running after the parent completes', async () => {
    const store = new MemoryHistoryStore();
    runtimeWith(store, () => 'done').start('parent', [], {workflowId: 'par-1'});
    await wait(200);

    expect((await store.get('par-1'))?.status).toBe('completed');
    expect((await store.get('kid-1'))?.status).toBe('running');
    expect((await store.get('kid-1'))?.history).not.toContain(
      jasmine.objectContaining({type: 'cancelRequested'}),
    );
  });

  it('keeps running after the parent fails', async () => {
    const store = new MemoryHistoryStore();
    runtimeWith(store, (): string => {
      throw new Error('parent blew up');
    }).start('parent', [], {workflowId: 'par-2'});
    await wait(200);

    expect((await store.get('par-2'))?.status).toBe('failed');
    expect((await store.get('kid-1'))?.status).toBe('running');
  });

  it('keeps running after the parent is terminated', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerWorkflow('ticker', async () => {
        await condition(() => false);
        return 'unreachable';
      })
      .registerWorkflow('parent', async () => {
        startChild('ticker', {workflowId: 'kid-2'});
        await condition(() => false);
        return 'unreachable';
      });

    const handle = rt.start('parent', [], {workflowId: 'par-3'});
    await wait(50); // let the child start
    handle.terminate('operator pulled it');
    await wait(100);

    expect((await store.get('par-3'))?.status).toBe('terminated');
    expect((await store.get('kid-2'))?.status).toBe('running');
  });
});

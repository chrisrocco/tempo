/**
 * @fileoverview
 * Generated execution ids across a server restart. The workload that finds this
 * is a long-running poller that spawns a child per item: it runs for days, the
 * server restarts at some point, and the very next child collides with one the
 * previous boot already created.
 *
 * Children are the sharp case because a caller cannot avoid it. A client can pass
 * an explicit `workflowId` and sidestep generation entirely; `startChild` has no
 * such option, so whatever the server generates is what a child gets.
 */

import {childExecutionId, MemoryHistoryStore} from '../../src/server';
import {createServerHost} from '../../src/services';

/** Collect unhandled rejections raised while `run` executes. */
async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  // Jasmine installs its own handler; ours runs alongside it.
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    // Rejections are reported on a later turn than the one that created them.
    await new Promise<void>((r) => setTimeout(r, 50));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

describe('generated ids across a restart', () => {
  it('does not reuse an id the previous boot already created', async () => {
    const store = new MemoryHistoryStore();

    const first = createServerHost(store);
    const before = first.start('planner').workflowId;
    await new Promise<void>((r) => setTimeout(r, 10)); // let create() land
    first.shutdown();

    // Restart: a new host over the same durable store.
    const second = createServerHost(store);
    await second.resume();
    const after = second.start('planner').workflowId;
    second.shutdown();

    expect(after).not.toBe(before);
  });

  it('does not raise an unhandled rejection when an id is already taken', async () => {
    const store = new MemoryHistoryStore();

    const rejections = await unhandledDuring(async () => {
      const first = createServerHost(store);
      first.start('planner');
      await new Promise<void>((r) => setTimeout(r, 10));
      first.shutdown();

      const second = createServerHost(store);
      await second.resume();
      second.start('planner');
      await new Promise<void>((r) => setTimeout(r, 10));
      second.shutdown();
    });

    // An unhandled rejection is fatal to a Node process by default, so this is
    // the server dying rather than an error anyone gets to see.
    expect(rejections).toEqual([]);
  });
});

describe('child ids derived from lineage', () => {
  it('gives the same child the same id however often the parent is replayed', () => {
    expect(childExecutionId('poller', 0, 3)).toBe(
      childExecutionId('poller', 0, 3),
    );
  });

  it('separates children of different parents', () => {
    expect(childExecutionId('a', 0, 0)).not.toBe(childExecutionId('b', 0, 0));
  });

  /**
   * The subtle one. Continue-as-new resets history, and with it the `seq`
   * counter — so without the run in the id, the child at seq 3 of run 0 and the
   * child at seq 3 of run 1 would be the same execution. A poller continues as
   * new constantly, which makes this the common case rather than an exotic one.
   */
  it('separates children spawned at the same seq in different runs', () => {
    expect(childExecutionId('poller', 0, 3)).not.toBe(
      childExecutionId('poller', 1, 3),
    );
  });

  it('shows a grandchild its whole ancestry', () => {
    const child = childExecutionId('poller', 0, 3);
    expect(childExecutionId(child, 0, 1)).toBe('poller.0.3.0.1');
  });

  /**
   * The workload this was all for: a poller that spawns a child per item, rolls
   * over with continue-as-new, and outlives a server restart. Every child it ever
   * launches must land on its own execution.
   */
  it('keeps a rolling poller from colliding with its own earlier children', async () => {
    const store = new MemoryHistoryStore();
    await store.create('poller', 'scan', []);
    const ids: string[] = [];

    for (const run of [0, 1, 2]) {
      const host = createServerHost(store);
      await host.resume(); // as a restart between rolls would
      for (const seq of [0, 1]) {
        const id = childExecutionId('poller', run, seq);
        ids.push(id);
        host.start('planner', [], {workflowId: id});
      }
      await new Promise<void>((r) => setTimeout(r, 10));
      host.shutdown();
      await store.resetForContinueAsNew('poller', []); // roll to the next run
    }

    expect(new Set(ids).size).toBe(ids.length); // all distinct
    const created = (await store.list()).filter((r) => r.name === 'planner');
    expect(created.length).toBe(ids.length); // and all of them exist
  });
});

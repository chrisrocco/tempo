/**
 * @fileoverview
 * `pollForever`: the loop, given a differ and a callback.
 *
 * The differs are covered on their own in `diff.spec.ts`. What is left is the
 * loop's contract, which is one sentence — **an item is reported as added once
 * across the poller's life, not once per cycle it remains present** — and that
 * is the thing a hand-written poller gets wrong after a while rather than on the
 * first cycle.
 *
 * These tests measure the callback's **effect**, by having it dispatch an
 * activity and counting executions, rather than counting invocations of the
 * callback. That is not a workaround, it is the actual contract: workflow code
 * runs again on every replay pass, and what happens once is a *command*, because
 * one already in history is suppressed by its marker. Counting invocations would
 * assert something no workflow code can promise.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import {
  byCursor,
  byId,
  pollForever,
  runActivity,
  startChild,
} from '../../src/workflow';

interface Item {
  id: string;
  seq: number;
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('pollForever', () => {
  /**
   * The contract, against the case that breaks a naive loop: an item that is
   * still present on every single poll. It is new once, and silent afterwards.
   */
  it('reacts once to an item that appears in every poll', async () => {
    const handled: string[] = [];
    let polls = 0;
    const rt = createLocalRuntime()
      .registerActivity('handle', (id: string) => {
        handled.push(id);
        return 'ok';
      })
      .registerActivity('fetch', () => {
        polls++;
        return [{id: 'always-here', seq: 1}];
      })
      .registerWorkflow('monitor', async () =>
        pollForever<Item, string[], undefined>({
          everyMs: 5,
          differ: byId((item) => item.id),
          poll: () => runActivity<Item[]>('fetch'),
          onAdded: (item) => void runActivity('handle', item.id),
        }),
      );

    const handle = rt.start('monitor', [], {workflowId: 'mon'});
    await wait(250);
    handle.terminate('done');
    await wait(20);

    expect(polls).toBeGreaterThan(3); // it really did keep polling
    expect(handled).toEqual(['always-here']); // and acted exactly once
    rt.shutdown();
  });

  it('reacts to each item as it appears', async () => {
    const handled: string[] = [];
    const feed: Item[] = [{id: 'a', seq: 1}];
    const rt = createLocalRuntime()
      .registerActivity('handle', (id: string) => {
        handled.push(id);
        return 'ok';
      })
      .registerActivity('fetch', () => [...feed])
      .registerWorkflow('monitor', async () =>
        pollForever<Item, string[], undefined>({
          everyMs: 5,
          differ: byId((item) => item.id),
          poll: () => runActivity<Item[]>('fetch'),
          onAdded: (item) => void runActivity('handle', item.id),
        }),
      );

    const handle = rt.start('monitor', [], {workflowId: 'mon'});
    await wait(120);
    feed.push({id: 'b', seq: 2});
    await wait(200);
    handle.terminate('done');
    await wait(20);

    expect(handled).toEqual(['a', 'b']);
    rt.shutdown();
  });

  /**
   * The half a cursor cannot express. A monitor that spawns a child per item
   * needs this to cancel that child once the item goes away — the shape
   * `startChild`'s own documentation describes.
   */
  it('reports an item that has gone away', async () => {
    const gone: string[] = [];
    let feed: Item[] = [
      {id: 'a', seq: 1},
      {id: 'b', seq: 2},
    ];
    const rt = createLocalRuntime()
      .registerActivity('gone', (id: string) => {
        gone.push(id);
        return 'ok';
      })
      .registerActivity('fetch', () => [...feed])
      .registerWorkflow('monitor', async () =>
        pollForever<Item, string[], undefined>({
          everyMs: 5,
          differ: byId((item) => item.id),
          poll: () => runActivity<Item[]>('fetch'),
          onAdded: () => {},
          onRemoved: (key) => void runActivity('gone', key),
        }),
      );

    const handle = rt.start('monitor', [], {workflowId: 'mon'});
    await wait(120);
    feed = feed.filter((item) => item.id !== 'b'); // b is resolved, drops out
    await wait(200);
    handle.terminate('done');
    await wait(20);

    expect(gone).toEqual(['b']);
    rt.shutdown();
  });

  /**
   * The stream half, and the reason `query` exists: the mark goes to the source,
   * so a feed that can filter never resends what has been seen. Doubles as the
   * regression test for carryover determinism — the poll argument is derived
   * from carried state, which is exactly what used to wedge replay.
   */
  it('hands the cursor to the source and advances it', async () => {
    const handled: number[] = [];
    const seenSince: (number | undefined)[] = [];
    const feed: Item[] = [
      {id: 'a', seq: 1},
      {id: 'b', seq: 2},
    ];
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('handle', (seq: number) => {
        handled.push(seq);
        return 'ok';
      })
      .registerActivity('fetch', (since?: number) => {
        seenSince.push(since);
        return feed.filter((item) => since === undefined || item.seq > since);
      })
      .registerWorkflow('monitor', async () =>
        pollForever<Item, number | undefined, number | undefined>({
          everyMs: 5,
          differ: byCursor((item) => item.seq),
          poll: (since) => runActivity<Item[]>('fetch', since),
          onAdded: (item) => void runActivity('handle', item.seq),
        }),
      );

    const handle = rt.start('monitor', [], {workflowId: 'mon'});
    await wait(250);
    handle.terminate('done');
    await wait(20);

    expect(handled).toEqual([1, 2]);
    expect(seenSince).toContain(2); // the mark reached the source
    const rec = await store.get('mon');
    expect(rec!.carryover['pollForever.state']).toBe(2);
    expect(rec!.taskFailures).toBe(0); // branching on it did not break replay
    rt.shutdown();
  });

  /**
   * A steady state must cost nothing per item. Dispatching per item every cycle
   * would write a history event each time — a repeat `startChild` claim is a
   * no-op at the server but still leaves its marker — so history would grow with
   * the size of the feed forever. Nothing new means nothing dispatched.
   */
  it('dispatches nothing in a cycle that finds no change', async () => {
    const feed: Item[] = Array.from({length: 20}, (_, i) => ({
      id: `i${i}`,
      seq: i + 1,
    }));
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('fetch', () => feed)
      .registerWorkflow('handle', async () => 'ok')
      .registerWorkflow('monitor', async () =>
        pollForever<Item, string[], undefined>({
          everyMs: 5,
          differ: byId((item) => item.id),
          poll: () => runActivity<Item[]>('fetch'),
          onAdded: (item) =>
            startChild('handle', {workflowId: `c-${item.id}`, args: [item]}),
        }),
      );

    const handle = rt.start('monitor', [], {workflowId: 'mon'});
    await wait(250);
    handle.terminate('done');
    await wait(20);

    const rec = await store.get('mon');
    // Whatever run it is sitting in polls and waits; it claims nothing.
    expect(rec!.history.filter((e) => e.type === 'childStarted').length).toBe(
      0,
    );
    expect(rec!.history.length).toBeLessThan(15);
    rt.shutdown();
  });

  /**
   * With no `args` given, the next run gets what this one was started with.
   *
   * The old default — no arguments at all — restarted `monitor(label)` as
   * `monitor(undefined)`. The execution stays healthy-looking, so the damage
   * shows up as a poller that has quietly stopped watching anything, one
   * rollover after the omission that caused it.
   *
   * The feed keeps changing so this rolls over repeatedly: the arguments have to
   * survive being passed on by a run that was itself started by a rollover, not
   * just the first one.
   */
  it('defaults to carrying the arguments this run was given', async () => {
    const store = new MemoryHistoryStore();
    const feed: Item[] = [];
    let n = 0;
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('fetch', () => {
        feed.push({id: `i${n}`, seq: ++n}); // something new every cycle
        return [...feed];
      })
      .registerWorkflow('monitor', async (label: string) =>
        pollForever<Item, string[], undefined>({
          everyMs: 5,
          // no `args` — the point of the test
          differ: byId((item) => item.id),
          poll: () => runActivity<Item[]>('fetch'),
          onAdded: () => {},
        }),
      );

    const handle = rt.start('monitor', ['hotlist'], {workflowId: 'mon'});
    await wait(250);
    handle.terminate('done');
    await wait(20);

    const rec = await store.get('mon');
    expect(rec!.runId).toBeGreaterThan(1); // several rollovers, not just one
    expect(rec!.args).toEqual(['hotlist']); // still monitoring what it was told to
    rt.shutdown();
  });

  it('carries the poller arguments into the run it rolls over into', async () => {
    const store = new MemoryHistoryStore();
    const feed: Item[] = [{id: 'a', seq: 1}];
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('fetch', () => [...feed])
      .registerWorkflow('monitor', async (label: string) =>
        pollForever<Item, string[], undefined>({
          everyMs: 5,
          args: [label],
          differ: byId((item) => item.id),
          poll: () => runActivity<Item[]>('fetch'),
          onAdded: () => {},
        }),
      );

    const handle = rt.start('monitor', ['hotlist'], {workflowId: 'mon'});
    await wait(250);
    handle.terminate('done');
    await wait(20);

    const rec = await store.get('mon');
    expect(rec!.runId).toBeGreaterThan(0); // guard: only meaningful after one
    expect(rec!.args).toEqual(['hotlist']);
    rt.shutdown();
  });

  it('stops when the execution is cancelled', async () => {
    let polls = 0;
    const rt = createLocalRuntime()
      .registerActivity('fetch', () => {
        polls++;
        return [];
      })
      .registerWorkflow('monitor', async () =>
        pollForever<Item, string[], undefined>({
          everyMs: 5,
          differ: byId((item) => item.id),
          poll: () => runActivity<Item[]>('fetch'),
          onAdded: () => {},
        }),
      );

    const handle = rt.start('monitor', [], {workflowId: 'mon'});
    await wait(60);
    handle.cancel();
    await wait(60);
    const atCancel = polls;
    await wait(80);

    expect(polls).toBe(atCancel); // stopped, rather than merely slowed
    rt.shutdown();
  });
});

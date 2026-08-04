/**
 * @fileoverview
 * `pollForever`, the monitor-workflow shape in one call.
 *
 * The behaviour worth pinning is not "it loops" — it is the three things a
 * hand-written poller gets wrong, each of which only shows up after the workflow
 * has been running a while:
 *
 *   - an item present in ten consecutive polls must produce **one** child;
 *   - history must stay bounded, or the execution eventually cannot replay;
 *   - the poller's own arguments must survive the rollover that bounds it.
 *
 * The dedupe is the interesting one, because it is not the helper's doing: the
 * child's id is a claim, and the server correlates a repeated claim to the
 * existing execution. That is what makes it survive the rollover — a set kept in
 * workflow state would be erased by exactly the mechanism keeping history small.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import {pollForever, runActivity} from '../../src/workflow';

interface Item {
  id: string;
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * A runtime whose poller watches `feed`, recording each child that runs. The
 * store is handed back so tests can read runId and history length off the
 * record — neither is visible through a handle.
 */
function harness(feed: () => Item[]) {
  const started: string[] = [];
  const store = new MemoryHistoryStore();
  const rt = createLocalRuntime({historyStore: store})
    .registerActivity('fetch', feed)
    .registerWorkflow('handle', async (item: Item) => {
      started.push(item.id);
      return 'handled';
    })
    .registerWorkflow('monitor', async (label: string) =>
      pollForever<Item>({
        everyMs: 5,
        args: [label],
        poll: () => runActivity<Item[]>('fetch'),
        child: 'handle',
        childId: (item) => `item-${item.id}`,
      }),
    );
  return {rt, store, started};
}

describe('pollForever', () => {
  it('starts one child per item it finds', async () => {
    const {rt, started} = harness(() => [{id: 'a'}, {id: 'b'}]);
    const handle = rt.start('monitor', ['hotlist'], {workflowId: 'mon'});

    await wait(120);
    handle.terminate('done');
    await wait(20);

    expect(new Set(started)).toEqual(new Set(['a', 'b']));
    rt.shutdown();
  });

  /**
   * The property the whole design turns on. A real hotlist returns the same open
   * bug on every poll; without id-derived dedupe this is one child per bug per
   * cycle, forever.
   */
  it('starts one child for an item that appears in every poll', async () => {
    let cycles = 0;
    const {rt, started} = harness(() => {
      cycles++;
      return [{id: 'always-here'}];
    });
    const handle = rt.start('monitor', ['hotlist'], {workflowId: 'mon'});

    await wait(200);
    handle.terminate('done');
    await wait(20);

    expect(cycles).toBeGreaterThan(3); // it really did poll repeatedly
    expect(started).toEqual(['always-here']); // and acted exactly once
    rt.shutdown();
  });

  it('keeps history bounded by rolling the run over', async () => {
    const {rt, store} = harness(() => [{id: 'a'}]);
    const handle = rt.start('monitor', ['hotlist'], {workflowId: 'mon'});

    await wait(300);
    handle.terminate('done');
    await wait(20);

    const rec = await store.get('mon');
    expect(rec!.runId).toBeGreaterThan(0); // it rolled over at least once
    // The point of rolling over: history is a function of one cycle, not of how
    // long the poller has been alive.
    expect(rec!.history.length).toBeLessThan(15);
    rt.shutdown();
  });

  // A rollover that dropped these would leave the next run monitoring nothing —
  // and it would look like the poller simply stopped finding items.
  it('carries the poller arguments into the run it rolls over into', async () => {
    const {rt, store} = harness(() => [{id: 'a'}]);
    const handle = rt.start('monitor', ['hotlist'], {workflowId: 'mon'});

    await wait(300);
    handle.terminate('done');
    await wait(20);

    const rec = await store.get('mon');
    expect(rec!.runId).toBeGreaterThan(0); // guard: the assertion below is only
    expect(rec!.args).toEqual(['hotlist']); // meaningful after a rollover
    rt.shutdown();
  });

  /**
   * Why `cursor` is not an optimization.
   *
   * A repeat claim starts no child, but it still writes a `childStarted` marker
   * — the marker is what stops replay re-dispatching it. So without a cursor a
   * feed of twenty unchanged items writes twenty events *every cycle*, forever,
   * and history is bounded only by rolling over constantly. With one, a cycle
   * that finds nothing new writes no markers at all.
   */
  it('stops writing a marker per item once the cursor has passed them', async () => {
    const started: string[] = [];
    const store = new MemoryHistoryStore();
    const feed = Array.from({length: 20}, (_, i) => ({
      id: `i${i}`,
      seq: i + 1,
    }));
    const rt = createLocalRuntime({historyStore: store})
      // A source that cannot filter: it returns everything, every time. The
      // skipping has to happen here.
      .registerActivity('fetch', () => feed)
      .registerWorkflow('handle', async (item: {id: string}) => {
        started.push(item.id);
        return 'ok';
      })
      .registerWorkflow('monitor', async () =>
        pollForever<{id: string; seq: number}, number>({
          everyMs: 5,
          poll: () => runActivity<{id: string; seq: number}[]>('fetch'),
          child: 'handle',
          childId: (item) => `c-${item.id}`,
          cursor: (item) => item.seq,
        }),
      );

    const handle = rt.start('monitor', [], {workflowId: 'mon'});
    await wait(250);
    handle.terminate('done');
    await wait(20);

    const rec = await store.get('mon');
    expect(new Set(started).size).toBe(20); // every item handled, once
    expect(rec!.carryover['pollForever.cursor']).toBe(20);
    // The steady state: the run it is sitting in claims nothing.
    expect(rec!.history.filter((e) => e.type === 'childStarted').length).toBe(
      0,
    );
    rt.shutdown();
  });

  /**
   * The regression test for the bug this design was built around. A cursor read
   * feeds the poll activity's argument, so with per-task carryover reads the
   * second task passed a different argument than history recorded and the
   * execution wedged on `nondeterminism at seq N` — while still reporting
   * "running".
   */
  it('does not wedge when the cursor feeds the poll arguments', async () => {
    const store = new MemoryHistoryStore();
    const feed = [
      {id: 'a', seq: 1},
      {id: 'b', seq: 2},
    ];
    const seenSince: (number | undefined)[] = [];
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('fetch', (since?: number) => {
        seenSince.push(since);
        return since === undefined ? feed : feed.filter((i) => i.seq > since);
      })
      .registerWorkflow('handle', async () => 'ok')
      .registerWorkflow('monitor', async () =>
        pollForever<{id: string; seq: number}, number>({
          everyMs: 5,
          poll: (since) =>
            runActivity<{id: string; seq: number}[]>('fetch', since),
          child: 'handle',
          childId: (item) => `c-${item.id}`,
          cursor: (item) => item.seq,
        }),
      );

    const handle = rt.start('monitor', [], {workflowId: 'mon'});
    await wait(250);
    handle.terminate('done');
    await wait(20);

    const rec = await store.get('mon');
    expect(rec!.taskFailures).toBe(0);
    expect(rec!.lastTaskFailure).toBeUndefined();
    // And the cursor really did reach the source, rather than staying undefined.
    expect(seenSince).toContain(2);
    rt.shutdown();
  });

  it('picks up an item that appears above the cursor', async () => {
    const started: string[] = [];
    const feed = [{id: 'a', seq: 1}];
    const rt = createLocalRuntime()
      .registerActivity('fetch', (since?: number) =>
        feed.filter((i) => since === undefined || i.seq > since),
      )
      .registerWorkflow('handle', async (item: {id: string}) => {
        started.push(item.id);
        return 'ok';
      })
      .registerWorkflow('monitor', async () =>
        pollForever<{id: string; seq: number}, number>({
          everyMs: 5,
          poll: (since) =>
            runActivity<{id: string; seq: number}[]>('fetch', since),
          child: 'handle',
          childId: (item) => `c-${item.id}`,
          cursor: (item) => item.seq,
        }),
      );

    const handle = rt.start('monitor', [], {workflowId: 'mon'});
    await wait(120);
    feed.push({id: 'b', seq: 2}); // a new item arrives mid-flight
    await wait(160);
    handle.terminate('done');
    await wait(20);

    expect(started).toEqual(['a', 'b']);
    rt.shutdown();
  });

  it('stops when the execution is cancelled', async () => {
    let cycles = 0;
    const {rt} = harness(() => {
      cycles++;
      return [];
    });
    const handle = rt.start('monitor', ['hotlist'], {workflowId: 'mon'});

    await wait(60);
    handle.cancel();
    await wait(60);
    const atCancel = cycles;
    await wait(80);

    expect(cycles).toBe(atCancel); // it really stopped, rather than slowing down
    rt.shutdown();
  });
});

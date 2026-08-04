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

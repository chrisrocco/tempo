/**
 * @fileoverview
 * `createWatcher`: the poller-child-behind-an-async-iterable, as one primitive.
 *
 * The parts are certified on their own — `pollForever` in `poller.spec.ts`,
 * the differs in `diff.spec.ts`, `signalStream` in `signal_stream.spec.ts`.
 * What these tests pin is the *assembly*: an item the poll surfaces crosses
 * two histories (the child's `signalWorkflow` command, the parent's signal)
 * and comes out of `watch()` once, in order, with the watch's `input` having
 * reached the poll; the child is claimed under the documented deterministic
 * id; `start` defaults to `'new'`; `stop()` actually kills the poller; two
 * subscriptions on one watcher, told apart by `as`, do not cross wires; and a
 * poller that dies terminally fails its waiting parent instead of going deaf.
 *
 * ## Registration happens in `beforeAll`, deliberately
 *
 * `createWatcher` registers its poll activity and child workflow into the
 * process-global registries at call time — declaring is registering, same as
 * `proxyActivities`. Done at module scope it would leak into every suite that
 * runs after this file loads, so this suite declares at run time and restores
 * both registries after — the same fidelity as
 * `spec/support/isolate_workflow_registry.ts`, at suite scope.
 */

import {createLocalRuntime, type Runtime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import {
  registeredActivityImpls,
  registerActivityImpls,
  resetActivityRegistry,
} from '../../src/activity_registry';
import {
  registeredWorkflowImpls,
  resetWorkflowRegistry,
} from '../../src/workflow_registry';
import {
  byCursor,
  createWatcher,
  createWorkflow,
  type AnyWorkflowFn,
  type WatcherRef,
} from '../../src/workflow';

interface Msg {
  id: number;
  body: string;
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Poll a host-side fact until it holds — never the engine's job. */
async function eventually(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

describe('createWatcher', () => {
  let rt: Runtime;
  let store: MemoryHistoryStore;
  let savedWorkflows: ReturnType<typeof registeredWorkflowImpls> = [];
  let savedActivities: ReturnType<typeof registeredActivityImpls> = [];

  // Host-side feeds, one per watcher so the counters stay per-test.
  const stream: Msg[] = [];
  const streamInputs: unknown[] = [];
  const fresh: Msg[] = [];
  let freshPolls = 0;
  const ticks: Msg[] = [];
  let tickPolls = 0;
  const dual: Msg[] = [];
  let doomedPolls = 0;

  let streamWatcher: WatcherRef<Msg, number | undefined, {topic: string}>;

  beforeAll(() => {
    savedWorkflows = registeredWorkflowImpls();
    savedActivities = registeredActivityImpls();

    streamWatcher = createWatcher('watcher-spec.stream', {
      poll: (since: number | undefined, input: {topic: string}) => {
        streamInputs.push(input);
        return stream.filter((m) => since === undefined || m.id > since);
      },
      diff: byCursor((m) => m.id),
      every: 25,
    });

    const freshWatcher = createWatcher('watcher-spec.fresh', {
      poll: (since: number | undefined) => {
        freshPolls++;
        return fresh.filter((m) => since === undefined || m.id > since);
      },
      diff: byCursor<Msg, number>((m) => m.id),
      every: 25,
    });

    const tickWatcher = createWatcher('watcher-spec.ticks', {
      poll: (since: number | undefined) => {
        tickPolls++;
        return ticks.filter((m) => since === undefined || m.id > since);
      },
      diff: byCursor<Msg, number>((m) => m.id),
      every: 25,
    });

    const doomedWatcher = createWatcher('watcher-spec.doomed', {
      poll: (): Msg[] => {
        doomedPolls++;
        throw new Error('the feed is gone');
      },
      diff: byCursor<Msg, number>((m) => m.id),
      every: 25,
      // Fail fast under test; the default budget takes most of a minute.
      options: {retry: {maximumAttempts: 2, initialIntervalMs: 5}},
    });

    const dualWatcher = createWatcher('watcher-spec.dual', {
      poll: (since: number | undefined, input: {parity: number}) =>
        dual.filter(
          (m) =>
            m.id % 2 === input.parity && (since === undefined || m.id > since),
        ),
      diff: byCursor<Msg, number>((m) => m.id),
      every: 25,
    });

    const collect = createWorkflow({
      key: 'collect',
      async run({count}: {count: number}) {
        const sub = streamWatcher.watch({
          start: 'all',
          input: {topic: 'alerts'},
        });
        const got: Msg[] = [];
        for await (const msg of sub) {
          got.push(msg);
          if (got.length >= count) break;
        }
        sub.stop();
        return got;
      },
    });

    const firstFresh = createWorkflow({
      key: 'firstFresh',
      async run() {
        const sub = freshWatcher.watch(); // start defaults to 'new'
        const msg = await sub.next();
        sub.stop();
        return msg;
      },
    });

    const stopper = createWorkflow({
      key: 'stopper',
      async run() {
        const sub = tickWatcher.watch({start: 'all'});
        const msg = await sub.next();
        sub.stop();
        await sub.next(); // parks forever: the poller is gone
        return msg;
      },
    });

    const doomed = createWorkflow({
      key: 'doomed',
      async run() {
        const sub = doomedWatcher.watch({start: 'all'});
        return await sub.next(); // the feed never delivers; the failure must
      },
    });

    const bothParities = createWorkflow({
      key: 'bothParities',
      async run() {
        const even = dualWatcher.watch({
          start: 'all',
          as: 'even',
          input: {parity: 0},
        });
        const odd = dualWatcher.watch({
          start: 'all',
          as: 'odd',
          input: {parity: 1},
        });
        const evenMsg = await even.next();
        const oddMsg = await odd.next();
        even.stop();
        odd.stop();
        return {
          evenId: evenMsg.id,
          oddId: oddMsg.id,
          distinctSignals: even.signalName !== odd.signalName,
        };
      },
    });

    store = new MemoryHistoryStore();
    rt = createLocalRuntime({historyStore: store});
    for (const watcher of [
      streamWatcher,
      freshWatcher,
      tickWatcher,
      dualWatcher,
      doomedWatcher,
    ]) {
      const regs = watcher.registrations();
      for (const [name, fn] of Object.entries(regs.activities)) {
        rt.registerActivity(name, fn);
      }
      for (const [name, fn] of Object.entries(regs.workflows)) {
        rt.registerWorkflow(name, fn);
      }
    }
    rt.registerWorkflow('collect', collect);
    rt.registerWorkflow('firstFresh', firstFresh);
    rt.registerWorkflow('stopper', stopper);
    rt.registerWorkflow('bothParities', bothParities);
    rt.registerWorkflow('doomed', doomed);
  });

  afterAll(() => {
    rt.shutdown();
    resetWorkflowRegistry();
    for (const [key, fn] of savedWorkflows) {
      createWorkflow({key, run: fn as AnyWorkflowFn});
    }
    resetActivityRegistry();
    registerActivityImpls(Object.fromEntries(savedActivities));
  });

  it('delivers items once, in order, with the input reaching every poll', async () => {
    stream.push({id: 1, body: 'one'}, {id: 2, body: 'two'});
    const handle = rt.start('collect', {count: 3}, {workflowId: 'collector'});

    await eventually(() => streamInputs.length > 0, 'the first poll');
    stream.push({id: 3, body: 'three'});

    const got = (await handle.result()) as Msg[];
    expect(got.map((m) => m.id)).toEqual([1, 2, 3]); // backlog then live, no repeats
    expect(streamInputs.length).toBeGreaterThan(0);
    for (const input of streamInputs) {
      expect(input).toEqual({topic: 'alerts'}); // the watch's input, on every poll
    }

    // The child was claimed under the documented deterministic id — the
    // property that makes a replayed `watch()` reattach instead of respawn.
    const child = await store.get('collector/watch/watcher-spec.stream/watch');
    expect(child).toBeTruthy();
  });

  it("defaults to start 'new': the backlog stays silent, later items fire", async () => {
    fresh.push({id: 1, body: 'old'});
    const handle = rt.start('firstFresh', undefined, {workflowId: 'ff'});

    await eventually(() => freshPolls > 0, 'the baseline poll');
    fresh.push({id: 2, body: 'new'});

    const got = (await handle.result()) as Msg;
    expect(got).toEqual({id: 2, body: 'new'});
  });

  it('stop() cancels the poller child', async () => {
    ticks.push({id: 1, body: 'tick'});
    const handle = rt.start('stopper', undefined, {workflowId: 'stopper'});

    await eventually(() => tickPolls > 0, 'the poller to start');
    // The workflow stops the watch right after its first item; give the
    // cancellation a moment to land, then verify polling has actually ceased.
    await wait(150);
    const frozen = tickPolls;
    await wait(200);
    expect(tickPolls).toBe(frozen);

    handle.terminate('done'); // the parent is parked on a dead stream
    await wait(20);
  });

  it('two watches on one watcher, named by `as`, do not cross wires', async () => {
    dual.push({id: 1, body: 'odd'}, {id: 2, body: 'even'});
    const handle = rt.start('bothParities', undefined, {workflowId: 'bp'});

    const got = (await handle.result()) as {
      evenId: number;
      oddId: number;
      distinctSignals: boolean;
    };
    expect(got.evenId).toBe(2);
    expect(got.oddId).toBe(1);
    expect(got.distinctSignals).toBe(true);
  });

  /**
   * A poller that dies must not leave its parent parked forever on a signal
   * that will never come: the child's last act is a failure marker on the same
   * signal, and the handle turns it into a typed throw at the waiting `await`.
   */
  it('a terminal poll failure fails the waiting parent, loudly', async () => {
    const handle = rt.start('doomed', undefined, {workflowId: 'doomed'});

    await expectAsync(handle.result()).toBeRejectedWithError(
      /watcher 'watcher-spec\.doomed' failed.*the feed is gone/,
    );
    expect(doomedPolls).toBe(2); // the retry budget was spent before giving up
  });

  it('declares its registrations for hosts that register explicitly', () => {
    const regs = streamWatcher.registrations();
    expect(Object.keys(regs.workflows)).toEqual(['watcher-spec.stream']);
    expect(Object.keys(regs.activities)).toEqual(['watcher-spec.stream.poll']);
  });
});

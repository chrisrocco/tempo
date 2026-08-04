/**
 * @fileoverview
 * Every recorded event carries the time it was appended.
 *
 * This is the field the whole observability story rests on: without it there is
 * no duration, no timeline, and no "how long has this been stuck". So the test
 * that matters is not "timestamps exist" but **"no event kind is missing one"** —
 * a single append path that bypasses the stamping point leaves a gap exactly
 * where someone will later look for it. `appendSignal` was such a path until
 * this landed, which would have left externally injected signals as the one kind
 * with no time on them.
 *
 * The second property is that a timestamp is a *fact about the past*: recorded
 * once, never recomputed. If it moved on read, two replays of one history would
 * disagree, and the field would be worse than useless.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import type {HistoryEvent} from '../../src/protocol';
import {
  defineSignal,
  executeChild,
  runActivity,
  setHandler,
  sleep,
} from '../../src/workflow';

const go = defineSignal('go');

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * One execution exercising every event kind: an activity that fails and one that
 * succeeds, a timer, a blocking child, an injected signal, and a cancellation.
 */
async function historyOfEveryKind(): Promise<HistoryEvent[]> {
  const store = new MemoryHistoryStore();
  const rt = createLocalRuntime({historyStore: store})
    .registerActivity('ok', () => 'fine')
    .registerActivity('boom', () => {
      throw new Error('nope');
    })
    .registerWorkflow('child', async () => 'child done')
    .registerWorkflow('wf', async () => {
      let released = false;
      setHandler(go, () => {
        released = true;
      });
      await runActivity('ok');
      try {
        await runActivity('boom');
      } catch {
        // recorded as activityFailed, then carry on
      }
      await executeChild('child');
      await sleep(5);
      while (!released) await sleep(2);
      await sleep(10_000); // park, so cancel has something to interrupt
      return 'unreachable';
    });

  const handle = rt.start('wf', [], {workflowId: 'wf-1'});
  await wait(60);
  handle.signal(go);
  await wait(40);
  handle.cancel();
  await wait(40);

  const rec = await store.get('wf-1');
  rt.shutdown();
  return rec!.history;
}

describe('history event timestamps', () => {
  let history: HistoryEvent[];

  beforeAll(async () => {
    history = await historyOfEveryKind();
  });

  it('exercises every event kind, so the check below means something', () => {
    const kinds = new Set(history.map((e) => e.type));

    // If this fails the workflow above stopped covering something, and the
    // "every event" assertion silently got weaker.
    expect(kinds.has('activityScheduled')).toBeTrue();
    expect(kinds.has('activityCompleted')).toBeTrue();
    expect(kinds.has('activityFailed')).toBeTrue();
    expect(kinds.has('timerStarted')).toBeTrue();
    expect(kinds.has('timerFired')).toBeTrue();
    expect(kinds.has('childStarted')).toBeTrue();
    expect(kinds.has('childCompleted')).toBeTrue();
    expect(kinds.has('signal')).toBeTrue();
    expect(kinds.has('cancelRequested')).toBeTrue();
  });

  it('stamps every event, whatever kind and however it was appended', () => {
    const unstamped = history.filter((e) => e.ts === undefined);

    expect(unstamped.map((e) => e.type)).toEqual([]);
  });

  it('stamps them with a plausible wall-clock time', () => {
    const first = history[0]!.ts!;

    // Not zero, not a counter, not a relative offset — an actual epoch time.
    expect(first).toBeGreaterThan(Date.now() - 60_000);
    expect(first).toBeLessThanOrEqual(Date.now());
  });

  it('records them in order, so the sequence can be read as a timeline', () => {
    const times = history.map((e) => e.ts!);
    const sorted = [...times].sort((a, b) => a - b);

    expect(times).toEqual(sorted);
  });

  /**
   * The durability property. A timestamp that were recomputed on read would make
   * two reads of one history disagree — and every duration derived from it would
   * be a measure of when someone asked rather than of what happened.
   */
  it('does not move between reads', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('ok', () => 'fine')
      .registerWorkflow('wf', async () => runActivity('ok'));

    await rt.start('wf', [], {workflowId: 'wf-1'}).result();
    const before = (await store.get('wf-1'))!.history.map((e) => e.ts);
    await wait(25);
    const after = (await store.get('wf-1'))!.history.map((e) => e.ts);

    expect(after).toEqual(before);
    rt.shutdown();
  });
});

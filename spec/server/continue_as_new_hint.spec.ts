/**
 * @fileoverview
 * `continueAsNewSuggested`: when the server tells a workflow its history has
 * grown enough to roll over.
 *
 * This has teeth now that `pollForever` acts on the hint automatically. The
 * threshold spent a long time at 4 — fine while nothing read it, and a rollover
 * per poll cycle once something did. So what is pinned here is that the default
 * is production-sized rather than test-sized, and that a test wanting a small
 * one has to ask for it.
 */

import {
  DEFAULT_CONTINUE_AS_NEW_SUGGEST_THRESHOLD,
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
} from '../../src/server';
import type {HistoryEvent} from '../../src/protocol';

function makeCore(
  historyStore: MemoryHistoryStore,
  continueAsNewSuggestThreshold?: number,
) {
  return createServerCore({
    historyStore,
    workflowTaskQueue: new MemoryWorkflowTaskQueue(),
    activityTaskQueue: new MemoryTaskQueue(),
    timerService: new MemoryTimerService(),
    launch: () => {},
    kickWorkflowWorker: () => {},
    kickActivityWorker: () => {},
    continueAsNewSuggestThreshold,
  });
}

/** `n` events, so history length can be set without running anything. */
function events(n: number): HistoryEvent[] {
  return Array.from({length: n}, (_, i) => ({
    type: 'timerStarted' as const,
    seq: i,
    fireAt: 0,
  }));
}

describe('continue-as-new suggestion', () => {
  /**
   * The regression guard. A default low enough to be convenient in tests makes
   * every long-lived workflow roll over constantly in production — a fresh run
   * and a full record rewrite per cycle.
   */
  it('defaults to a production-sized threshold', () => {
    expect(DEFAULT_CONTINUE_AS_NEW_SUGGEST_THRESHOLD).toBeGreaterThanOrEqual(
      1000,
    );
  });

  it('does not suggest rolling over for a short history', async () => {
    const store = new MemoryHistoryStore();
    const core = makeCore(store);
    await store.create('wf', 'w', []);
    await store.append('wf', events(50)); // long by test standards, short in truth

    const task = await core.buildWorkflowTask('wf');
    expect(task!.continueAsNewSuggested).toBeFalse();
  });

  it('suggests rolling over once history reaches the threshold', async () => {
    const store = new MemoryHistoryStore();
    const core = makeCore(store);
    await store.create('wf', 'w', []);
    await store.append('wf', events(DEFAULT_CONTINUE_AS_NEW_SUGGEST_THRESHOLD));

    const task = await core.buildWorkflowTask('wf');
    expect(task!.continueAsNewSuggested).toBeTrue();
  });

  // The seam that lets the default stay honest: a test that wants to reach the
  // hint quickly lowers it here rather than in the server.
  it('honours an injected threshold', async () => {
    const store = new MemoryHistoryStore();
    const core = makeCore(store, 4);
    await store.create('wf', 'w', []);
    await store.append('wf', events(4));

    const task = await core.buildWorkflowTask('wf');
    expect(task!.continueAsNewSuggested).toBeTrue();
  });
});

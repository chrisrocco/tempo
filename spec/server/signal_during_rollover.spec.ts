/**
 * @fileoverview
 * A signal that lands while a task is out survives that task rolling the execution over.
 *
 * ## Why this is worth a spec of its own
 *
 * The property holds today, and it holds **incidentally**. `completeWorkflowTask` checks
 * `rec.version === lease.version` before applying anything, and its comment explains that
 * check as a guard against a *lease race* — a slow worker whose task was redelivered. It
 * says nothing about signals. But appending a signal bumps the same version, so a task
 * result that arrives after one is discarded and the retry replays against history that
 * includes it.
 *
 * That is load-bearing and undocumented, which is the combination worth pinning. A
 * refactor that narrowed the check to what its comment describes — comparing lease
 * identity, say, rather than record version — would keep every existing spec green and
 * silently reintroduce the failure: a rollover empties history, so an unconsumed signal
 * would go with it, and a paused schedule would keep firing with nothing raised anywhere.
 *
 * Issue #82 was filed claiming exactly that failure, on a measurement taken against a
 * scheduler that was spinning through runs for unrelated reasons. It was wrong. This is
 * the spec that would have answered the question in one run instead.
 *
 * ## What is deliberately not claimed
 *
 * The window is narrowed, not closed. `completeWorkflowTask` reads the version, checks it,
 * and then awaits through the rollover — a signal appended between the check and the reset
 * is still lost. That is the ordinary consequence of a store with no transaction around
 * the pair, and closing it needs a compare-and-swap on the write rather than before it.
 * Nothing here asserts otherwise.
 */

import type {WorkflowTaskResult} from '../../src/protocol';
import {MemoryHistoryStore} from '../../src/server';
import {createServerHost} from '../../src/services';

/** A result that rolls the execution over and does nothing else. */
const rollover: WorkflowTaskResult = {
  done: false,
  result: undefined,
  failed: false,
  failure: undefined,
  commands: [{type: 'continueAsNew', args: [1], seq: 0}],
  carryover: {},
  parked: [],
};

describe('a signal racing a rollover', () => {
  let store: MemoryHistoryStore;
  let host: ReturnType<typeof createServerHost>;

  beforeEach(async () => {
    store = new MemoryHistoryStore();
    host = createServerHost(store);
    await host.start('w', [0], {workflowId: 'x'});
  });

  afterEach(() => {
    host.shutdown();
  });

  /**
   * The contrast, first, so the assertion below cannot pass for the boring reason that
   * `continueAsNew` never works in this harness.
   */
  it('rolls over normally when nothing interrupts the task', async () => {
    const task = await host.pollWorkflowTask({identity: 'w1'});
    await host.completeWorkflowTask(task!.token, rollover);

    const after = await store.get('x');
    expect(after?.runId).toBe(1);
    expect(after?.args).toEqual([1]);
  });

  it('discards the task result rather than rolling over, so the signal is kept', async () => {
    const task = await host.pollWorkflowTask({identity: 'w1'});
    // The race: the task is out, holding history as it was at dispatch, and a signal
    // arrives that it therefore cannot have seen.
    await host.signal('x', 'pauseSchedule', undefined);

    await host.completeWorkflowTask(task!.token, rollover);

    const after = await store.get('x');
    // Not rolled over: the version moved under the task, so its result was dropped.
    expect(after?.runId).toBe(0);
    // And the signal is still there for the retry to replay.
    expect(after?.history.filter((e) => e.type === 'signal').length).toBe(1);
  });

  // The point of keeping it: the next task delivers it. A signal that survived the store
  // but never reached the workflow would be no better than one that was dropped.
  it('delivers the kept signal on the next task', async () => {
    const first = await host.pollWorkflowTask({identity: 'w1'});
    await host.signal('x', 'pauseSchedule', undefined);
    await host.completeWorkflowTask(first!.token, rollover);

    const second = await host.pollWorkflowTask({identity: 'w1'});
    expect(second?.history.map((e) => e.type)).toContain('signal');
  });
});

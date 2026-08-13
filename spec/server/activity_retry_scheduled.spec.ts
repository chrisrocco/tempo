/**
 * @fileoverview
 * `activityRetryScheduled`: the gap between two attempts, in history.
 *
 * `activityStarted` made attempts legible and left the space between them blank. A
 * started attempt with no completion after it means either "a worker is running
 * this right now" or "it failed and the seq is idle until its backoff expires",
 * and those are opposite readings of the same silence — the first flattering, the
 * second the one worth acting on.
 *
 * `PendingActivityView.nextAttemptAt` distinguishes them and is cleared when the
 * activity settles, so it answers only about a retry happening now. These tests
 * pin the properties that make the *retrospective* answer possible: one event per
 * retry rather than per failure, the per-attempt error that nothing else keeps,
 * and the interleaving that lets a reader close the gap it opens.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import type {ActivityRetryScheduledEvent} from '../../src/protocol';
import {proxyActivities} from '../../src/workflow';
import {isolateActivityRegistry} from '../support/isolate_activity_registry';

function retryEvents(
  rec: {history: {type: string}[]} | undefined,
): ActivityRetryScheduledEvent[] {
  return (rec?.history ?? []).filter(
    (ev): ev is ActivityRetryScheduledEvent =>
      ev.type === 'activityRetryScheduled',
  );
}

// Retry options only reach an activity through `proxyActivities` — `runActivity`
// always dispatches with `{}`, and the default is one attempt — so every case here
// needs the process-global registry and has to own it while it runs.
describe('activityRetryScheduled', () => {
  isolateActivityRegistry();

  it('appends one per retry, not one per attempt and not one per failure', async () => {
    const store = new MemoryHistoryStore();
    let attempts = 0;
    const flaky = (): string => {
      attempts += 1;
      if (attempts < 3) throw new Error('not yet');
      return 'third time';
    };
    const act = proxyActivities(
      {flaky},
      {retry: {maximumAttempts: 5, initialIntervalMs: 1}},
    );
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('flaky', flaky)
      .registerWorkflow('w', async () => act.flaky());

    await rt.start('w', [], {workflowId: 'rs-1'}).result();

    // Three attempts, two gaps. The count is the point: an event per *failure*
    // would be three, and the third failure is not a gap — it is a success.
    const retries = retryEvents(await store.get('rs-1'));
    expect(retries.length).toBe(2);
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    // The attempt that failed, not the one about to run — the opposite convention
    // from `PendingActivityView.attempt`, and the off-by-one both docs warn about.
    expect(retries.every((e) => e.maxAttempts === 5)).toBe(true);
  });

  it('keeps the per-attempt error that nothing else survives to tell', async () => {
    const store = new MemoryHistoryStore();
    let attempts = 0;
    const flapping = (): string => {
      attempts += 1;
      if (attempts === 1) throw new Error('connection reset');
      if (attempts === 2) throw new Error('429 slow down');
      return 'through';
    };
    const act = proxyActivities(
      {flapping},
      {retry: {maximumAttempts: 5, initialIntervalMs: 1}},
    );
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('flapping', flapping)
      .registerWorkflow('w', async () => act.flapping());

    await rt.start('w', [], {workflowId: 'rs-2'}).result();

    // The activity succeeded, so `activityFailed` was never written and the attempt
    // counter was cleared on settling. Without these events an activity that failed
    // two different ways keeps neither — and the first failure is usually the one
    // that explains the flap.
    expect(retryEvents(await store.get('rs-2')).map((e) => e.error)).toEqual([
      'connection reset',
      '429 slow down',
    ]);
  });

  it('closes the gap a started attempt opens', async () => {
    const store = new MemoryHistoryStore();
    let attempts = 0;
    const twice = (): string => {
      attempts += 1;
      if (attempts < 2) throw new Error('once');
      return 'ok';
    };
    const act = proxyActivities(
      {twice},
      {retry: {maximumAttempts: 3, initialIntervalMs: 20}},
    );
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('twice', twice)
      .registerWorkflow('w', async () => act.twice());

    await rt.start('w', [], {workflowId: 'rs-3'}).result();

    const history = (await store.get('rs-3'))!.history;
    const shape = history
      .map((e) => e.type)
      .filter((t) => t !== 'activityScheduled');
    // Started, then the gap, then started again. This ordering is what a reader
    // folds into two spans with a backoff between them; before the middle event
    // existed the same history was one span with nothing to break it.
    expect(shape).toEqual([
      'activityStarted',
      'activityRetryScheduled',
      'activityStarted',
      'activityCompleted',
    ]);

    const retry = retryEvents(await store.get('rs-3'))[0]!;
    const secondPickup = history.filter(
      (e) => e.type === 'activityStarted',
    )[1]!;
    // The due time is a claim about the future when written, so the attempt it
    // predicts cannot have been picked up before it.
    expect(retry.nextAttemptAt).toBeGreaterThanOrEqual(retry.ts!);
    expect(secondPickup.ts!).toBeGreaterThanOrEqual(retry.ts!);
  });

  it('writes nothing when the policy allows no retry', async () => {
    const store = new MemoryHistoryStore();
    const doomed = (): string => {
      throw new Error('no second chance');
    };
    const act = proxyActivities({doomed}, {retry: {maximumAttempts: 1}});
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('doomed', doomed)
      .registerWorkflow('w', async () => act.doomed());

    await expectAsync(
      rt.start('w', [], {workflowId: 'rs-4'}).result(),
    ).toBeRejected();

    // A failure that ends the activity is `activityFailed`, which already carries
    // the error and a stack. Adding a gap event for a gap that never happens would
    // be the per-failure stream the design deliberately does not have.
    expect(retryEvents(await store.get('rs-4')).length).toBe(0);
  });
});

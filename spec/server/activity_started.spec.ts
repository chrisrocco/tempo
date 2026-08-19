/**
 * @fileoverview
 * `activityStarted`: when a worker actually picked the task up.
 *
 * Without it an activity has two timestamps in history — `activityScheduled.ts` and
 * its completion's — so every reader sees one span covering **queue time plus
 * execution time**, and for a retried activity, plus every attempt and every backoff
 * gap. Those have opposite remedies: queue time means the worker pool is saturated,
 * execution time means the activity is slow.
 *
 * Two properties are being pinned, and they are the two the design was chosen for:
 *
 * - it is written **at pickup, not at completion**, so an attempt that is still
 *   running is already visible;
 * - there is **one per attempt**, so a retry is legible rather than hidden inside a
 *   single span.
 *
 * The second means this is the only event type of which several can share one `seq`.
 * Anything reading history by seq has to tolerate that.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import type {ActivityStartedEvent} from '../../src/protocol';
import {proxyActivities, runActivity} from '../../src/workflow';
import {isolateActivityRegistry} from '../support/isolate_activity_registry';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function startedEvents(
  rec: {history: {type: string}[]} | undefined,
): ActivityStartedEvent[] {
  return (rec?.history ?? []).filter(
    (ev): ev is ActivityStartedEvent => ev.type === 'activityStarted',
  );
}

describe('activityStarted', () => {
  it('is in history before the activity has finished', async () => {
    const store = new MemoryHistoryStore();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((r) => {
      release = r;
    });

    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('slow', async () => {
        await blocked;
        return 'eventually';
      })
      .registerWorkflow('w', async () => runActivity<string>('slow'));

    const handle = rt.start('w', undefined, {workflowId: 'inflight-1'});
    await wait(120);

    // The whole point of writing it at pickup: the attempt is still running, and
    // history already says when it began. A value carried on the completion event
    // would have nothing to say here.
    const started = startedEvents(await store.get('inflight-1'));
    expect(started.length).toBe(1);
    expect(typeof started[0]?.ts).toBe('number');
    expect(
      (await store.get('inflight-1'))?.history.some(
        (e) => e.type === 'activityCompleted',
      ),
    ).toBe(false);

    release?.();
    await expectAsync(handle.result()).toBeResolvedTo('eventually');
  });

  it('separates the wait from the work, which one span could not', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('work', async () => {
        await wait(60);
        return 'done';
      })
      .registerWorkflow('w', async () => runActivity<string>('work'));

    await rt.start('w', undefined, {workflowId: 'span-1'}).result();

    const history = (await store.get('span-1'))!.history;
    const at = (type: string): number =>
      history.find((e) => e.type === type)!.ts!;

    // Three points now, where there used to be two — so queue time and execution
    // time are separately measurable rather than summed into one bar.
    expect(at('activityStarted')).toBeGreaterThanOrEqual(
      at('activityScheduled'),
    );
    expect(at('activityCompleted')).toBeGreaterThanOrEqual(
      at('activityStarted'),
    );
  });

  // Retry options only reach an activity through `proxyActivities` — `runActivity`
  // always dispatches with `{}`, and the default is one attempt — so this case needs
  // the process-global registry and therefore has to own it while it runs.
  describe('across retries', () => {
    isolateActivityRegistry();

    it('appends one per attempt, so a retry is not hidden in one span', async () => {
      const store = new MemoryHistoryStore();
      let attempts = 0;
      const flaky = (): string => {
        attempts += 1;
        if (attempts < 3) throw new Error('not yet');
        return 'third time';
      };
      // The same function under both routes, so the registry records no conflict.
      const act = proxyActivities(
        {flaky},
        {retry: {maximumAttempts: 5, initialIntervalMs: 1}},
      );
      const rt = createLocalRuntime({historyStore: store})
        .registerActivity('flaky', flaky)
        .registerWorkflow('w', async () => act.flaky());

      await rt.start('w', undefined, {workflowId: 'retry-1'}).result();

      const started = startedEvents(await store.get('retry-1'));
      expect(started.length).toBe(3);
      // Several events, one seq — the only place in the model where that happens,
      // and what anything reading history by seq has to tolerate.
      expect(new Set(started.map((e) => e.seq)).size).toBe(1);
    });
  });
});

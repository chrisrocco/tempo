/**
 * @fileoverview
 * A child's outcome event names the child.
 *
 * `childCompleted` and `childFailed` carry a `childId` even though the
 * `childStarted` that dispatched them already has one under the same `seq`.
 * The reason is paging: `describeExecution` returns at most `MAX_HISTORY_PAGE`
 * events, and a child that ran for a while has its dispatch and its outcome far
 * enough apart to land on different pages. A reader holding one of them can
 * pair the two only if both name the child.
 *
 * That matters most in the case it is hardest to notice: a failed child
 * permanently burns its workflow id — `startChild` dedupes against any existing
 * record, including a failed one — so the item is never retried, and the
 * parent's history is the only place the failure is visible at all.
 *
 * The property under test is that **no path emits an anonymous outcome**.
 * `childOutcomeEvent` funnels three of them (a child settling now, one that
 * settled during an outage, and an id claimed after it had already finished),
 * and a fourth path added later that skipped the funnel would reintroduce
 * exactly the gap this closes.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import type {HistoryEvent} from '../../src/protocol';
import {executeChild} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function historyOf(
  parent: () => Promise<unknown>,
  child: () => Promise<unknown>,
): Promise<HistoryEvent[]> {
  const store = new MemoryHistoryStore();
  const rt = createLocalRuntime({historyStore: store})
    .registerWorkflow('child', child)
    .registerWorkflow('parent', parent);

  rt.start('parent', undefined, {workflowId: 'p-1'});
  await wait(120);

  const rec = await store.get('p-1');
  rt.shutdown();
  return rec!.history;
}

describe('child outcome events — naming the child', () => {
  it('names the child on the event that reports it completed', async () => {
    const history = await historyOf(
      async () => executeChild('child', {workflowId: 'kid-ok'}),
      async () => 'done',
    );
    const completed = history.find((e) => e.type === 'childCompleted');

    expect(completed).toBeDefined();
    expect((completed as {childId?: string}).childId).toBe('kid-ok');
  });

  it('names the child on the event that reports it failed', async () => {
    const history = await historyOf(
      async () => {
        try {
          await executeChild('child', {workflowId: 'kid-bad'});
        } catch {
          // The parent survives it; the point is what got recorded.
        }
        return 'parent done';
      },
      async () => {
        throw new Error('child blew up');
      },
    );
    const failed = history.find((e) => e.type === 'childFailed');

    expect(failed).toBeDefined();
    expect((failed as {childId?: string}).childId).toBe('kid-bad');
  });

  it('names the same child the dispatch named, so the two can be paired', async () => {
    const history = await historyOf(
      async () => executeChild('child', {workflowId: 'kid-pair'}),
      async () => 'done',
    );
    const started = history.find((e) => e.type === 'childStarted');
    const completed = history.find((e) => e.type === 'childCompleted');

    // Same seq is what makes them a pair; same id is what lets a reader who has
    // only one of the two pages follow it.
    expect((started as {seq: number}).seq).toBe(
      (completed as {seq: number}).seq,
    );
    expect((started as {childId?: string}).childId).toBe(
      (completed as {childId?: string}).childId,
    );
  });
});

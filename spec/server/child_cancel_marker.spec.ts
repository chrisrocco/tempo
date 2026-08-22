/**
 * @fileoverview
 * `cancelChild` leaves a marker, like every other command.
 *
 * It was the one exception, and the reasoning for it was about safety: a cancel's
 * durable record is the `cancelRequested` on the *child*, and `requestCancel`
 * short-circuits on finding one, so re-dispatching a cancel does no harm. True,
 * and beside the point once replay began deciding what to emit by asking whether
 * history holds a command's seq (`core/workflow_api`). A record on another
 * execution cannot answer that question, so a cancel the workflow reached while
 * history remained was dropped — and unlike every other command, not even a gap in
 * the seqs was left to notice it by. Issue #50, the remainder of issue #39.
 *
 * The second spec is that bug, end to end and without a race: a signal landing
 * before the worker's first poll gives task one a history of `[signal]`, so the
 * initial run reaches `cancel()` with history left to consume. Without the marker
 * the child simply runs on, cancelled by nobody, with the parent believing it did.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import {condition, setHandler, startChild} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('cancelling a detached child', () => {
  it('records a childCancelRequested marker on the parent', async () => {
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('child', async () => {
        await condition(() => false);
        return 'never';
      })
      .registerWorkflow('parent', async () => {
        startChild('child', {workflowId: 'kid-1'}).cancel();
        await wait(30);
        return 'cancelled it';
      })
      .start('parent', undefined, {workflowId: 'p-1'});
    await wait(200);

    const history = (await store.get('p-1'))?.history ?? [];
    expect(history).toContain(
      jasmine.objectContaining({
        type: 'childCancelRequested',
        seq: 1,
        targetSeq: 0,
      }),
    );
  });

  it('reaches the child when the cancel is issued with history still unconsumed', async () => {
    const ping = 'ping';
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerWorkflow('child', async () => {
        await condition(() => false);
        return 'never';
      })
      .registerWorkflow('parent', async () => {
        setHandler(ping, () => {});
        startChild('child', {workflowId: 'kid-2'}).cancel();
        await condition(() => false);
        return 'never';
      });

    // The signal lands before the first task is polled, so that task carries a
    // history of `[signal]` and the cancel is issued before any of it is applied.
    const handle = rt.start('parent', undefined, {workflowId: 'p-2'});
    await handle.signal('ping', 'early');
    await wait(200);

    const childHistory = (await store.get('kid-2'))?.history ?? [];
    expect(childHistory).toContain(
      jasmine.objectContaining({type: 'cancelRequested'}),
    );
  });
});

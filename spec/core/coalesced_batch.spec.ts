/**
 * @fileoverview
 * What happens when one activation carries **more than one** new event.
 *
 * The live edge assumes a shape that most activations have: the batch's last
 * event is the one that unblocks the workflow, so anything the workflow issues
 * afterwards is genuinely new and everything before it is already durable. A
 * batch with a trailing event breaks that assumption — an earlier completion can
 * advance the workflow to a *new* command while `isLive` is still false.
 *
 * This is not a rare shape. The workflow-task queue coalesces a wake that lands
 * mid-task into exactly one more task, so any signal arriving while an activity
 * completion is in flight produces exactly this batch. It is what a workflow with
 * a signal-consuming branch beside a polling main line does constantly.
 *
 * The failure it produced was the worst kind: the command was dropped silently,
 * so the workflow parked on a promise nothing would ever resolve, the execution
 * stayed `running` with `taskFailures: 0`, and nothing anywhere reported it.
 */

import {createContext} from '../../src/core/context';
import {replay} from '../../src/core/replay';
import {defineSignal, setHandler} from '../../src/core/signals';
import {runActivity, sleep} from '../../src/core/workflow_api';
import type {HistoryEvent} from '../../src/protocol';

const ping = defineSignal('ping');

/**
 * The shape under test: react to an activity completion by starting a timer,
 * while a handler consumes signals alongside. Deliberately minimal — the same
 * structure as a reconcile loop with a supervisor branch, with everything that
 * is not load-bearing removed.
 */
async function pollThenWait(): Promise<string> {
  const seen: string[] = [];
  setHandler(ping, (payload: string) => seen.push(payload));
  await runActivity<string>('look');
  await sleep(1000);
  return seen.join(',');
}

describe('an activation carrying several new events', () => {
  it('emits a command issued in response to an event that is not the batch’s last', async () => {
    // The batch the queue coalesces: the activity completed, and a signal landed
    // before the worker got to respond.
    const history: HistoryEvent[] = [
      {type: 'activityScheduled', seq: 0, name: 'look', args: [], options: {}},
      {type: 'activityCompleted', seq: 0, result: 'ok'},
      {type: 'signal', name: 'ping', payload: 'hello'},
    ];

    const ctx = await replay(createContext([], history), pollThenWait);

    // The workflow reached `sleep` — it allocated seq 1 for it — so the timer is
    // work the server has not been told about. Dropping it wedges the execution.
    expect(ctx.requested.has(1)).toBe(true);
    expect(ctx.commands.map((c) => c.seq)).toContain(1);
    expect(ctx.commands.find((c) => c.seq === 1)!.type).toBe('startTimer');
  });

  it('still suppresses a command history already records, so nothing double-dispatches', async () => {
    // Same workflow, but this time the timer *was* dispatched: its marker is in
    // history. Re-emitting it would start a second timer for one `sleep`.
    const history: HistoryEvent[] = [
      {type: 'activityScheduled', seq: 0, name: 'look', args: [], options: {}},
      {type: 'activityCompleted', seq: 0, result: 'ok'},
      {type: 'timerStarted', seq: 1, fireAt: 1000},
      {type: 'signal', name: 'ping', payload: 'hello'},
    ];

    const ctx = await replay(createContext([], history), pollThenWait);

    expect(ctx.requested.has(1)).toBe(true);
    expect(ctx.commands.map((c) => c.seq)).not.toContain(1);
  });
});

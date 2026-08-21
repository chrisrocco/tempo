/**
 * @fileoverview
 * A workflow learning its own id, and what that is for.
 *
 * The gap this closes is narrow and was visible in the code before it was filled:
 * `WorkflowContext.parent` noted that "an id the engine derived from lineage is not
 * visible to the workflow that owns it", so a workflow could address whoever started
 * it and not itself.
 *
 * The use that forces it is the callback: an activity hands an external system
 * somewhere to signal when it is done, and only the workflow can supply that address
 * — an activity has no ambient access to it, by design (`activity.ts` exports
 * `heartbeat` and nothing else). So the middle spec runs the whole loop rather than
 * reading a field, because reading a field proves nothing about whether the value
 * works as an address.
 *
 * A signal is the same bare name on both sides of the wire — `setHandler` inside
 * the workflow, `.signal()` outside it — so the address an activity hands to an
 * external system is a `workflowId` and a string, nothing more.
 */

import {createLocalRuntime} from '../../src';
import {
  condition,
  continueAsNew,
  runActivity,
  setHandler,
  sleep,
  workflowInfo,
} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// A plain string, and untyped on purpose: a signal here carries one JSON payload,
// delivered as `fn(payload)`, and the handler's own signature is the assertion
// about its shape. `core/signals.ts` records why the `defineSignal` wrapper this
// used to be was deleted, and what a *typed* definition would have to look like
// to earn its way back.
const jobDone = 'jobDone';

describe('a workflow knows its own id', () => {
  it('reports the id a client started it under', async () => {
    const seen: string[] = [];
    const rt = createLocalRuntime().registerWorkflow('reporter', async () => {
      seen.push(workflowInfo().workflowId);
      return 'ok';
    });

    await rt.start('reporter', undefined, {workflowId: 'chosen-id'}).result();

    expect(seen).toEqual(['chosen-id']);
  });

  /**
   * The round trip, and the reason the field exists. The activity stands in for
   * anything that outlives its own call — a spawned process, a queued job, a webhook
   * registration — and the only thing it is given is the address.
   */
  it('gives an activity an address an outside caller can signal back on', async () => {
    // What the "external system" retains. It learns this from the activity, which
    // learned it from the workflow; nothing else in this test is told it.
    let callbackId: string | undefined;

    const rt = createLocalRuntime()
      .registerActivity('launchJob', (address: string) => {
        callbackId = address;
        return 'launched';
      })
      .registerWorkflow('waiter', async () => {
        let outcome: string | undefined;
        setHandler(jobDone, (value: string) => {
          outcome = value;
        });
        // The one line the whole feature is for.
        await runActivity('launchJob', workflowInfo().workflowId);
        await condition(() => outcome !== undefined);
        return outcome;
      });

    const handle = rt.start('waiter', undefined, {workflowId: 'waiter-1'});
    await wait(150);

    expect(callbackId).toBe('waiter-1');
    // Signalled from outside, by id, the way a callback would arrive.
    rt.getHandle(callbackId!).signal('jobDone', 'finished');

    await expectAsync(handle.result()).toBeResolvedTo('finished');
  });

  /**
   * The id belongs to the execution, not the run, and that distinction is what makes
   * it usable as a callback address at all: a rollover replaces the run, so an
   * address pinned to one would go stale in precisely the long-lived workflows that
   * hand addresses out.
   */
  it('is unchanged across continue-as-new', async () => {
    const seen: string[] = [];
    const rt = createLocalRuntime().registerWorkflow(
      'roller',
      async (pass: number) => {
        seen.push(workflowInfo().workflowId);
        if (pass === 0) {
          await sleep(1); // a task boundary, so the rollover is its own dispatch
          return continueAsNew(1);
        }
        return 'done';
      },
    );

    await rt.start('roller', 0, {workflowId: 'stable-id'}).result();

    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen)).toEqual(new Set(['stable-id']));
  });
});

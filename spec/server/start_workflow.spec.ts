/**
 * @fileoverview
 * `startWorkflow`: starting an execution that is not a child.
 *
 * The command exists for one property that no combination of the others has, and
 * the contrast specs below are the argument for it. `parentClosePolicy` looks like
 * it should cover this and covers only half: it governs what happens when a starter
 * **closes**, while cancelling a starter cascades to its children regardless of the
 * policy. So `abandon` buys a child that survives its parent completing, not one
 * that survives its parent being called off.
 *
 * For a scheduler that is the difference between working and not — cancelling a
 * schedule has to stop the schedule and leave the runs it already dispatched alone.
 * Each `it` here is paired with the `startChild` behaviour it differs from, because
 * the point is never "this works" but "this works where the alternative does not".
 *
 * The starters `sleep` before returning for the reason `parent_close.spec.ts` gives:
 * a start issued in the same task that finishes the workflow is currently dropped,
 * so it has to be dispatched by an earlier task for there to be anything to observe.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import type {WorkflowStartedEvent} from '../../src/protocol';
import {condition, sleep, startChild, startWorkflow} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** A starter that dispatches `runner` under a chosen id and then parks forever. */
function parkingStarter(store: MemoryHistoryStore, targetId: string) {
  return createLocalRuntime({historyStore: store})
    .registerWorkflow('runner', async () => {
      await condition(() => false);
      return 'unreachable';
    })
    .registerWorkflow('starter', async () => {
      startWorkflow(targetId, 'runner');
      await condition(() => false);
      return 'unreachable';
    });
}

describe('startWorkflow — an execution that is nobody’s child', () => {
  it('survives its starter being cancelled, where a child would not', async () => {
    const store = new MemoryHistoryStore();
    const handle = parkingStarter(store, 'indep-1').start('starter', [], {
      workflowId: 'starter-1',
    });
    await wait(80);
    handle.cancel();
    await wait(120);

    // `failed`, not `cancelled`: a cancel rejects what the run is awaiting and the
    // run unwinds, so it lands where any unwound execution lands. Same reading as
    // `parent_close.spec.ts` — "unwound, not terminated".
    expect((await store.get('starter-1'))?.status).toBe('failed');
    // The whole point. A cancel cascade reaches every child unconditionally; this
    // is not a child, so there is nothing for it to reach.
    expect((await store.get('indep-1'))?.status).toBe('running');
  });

  // The contrast, in the same file so the difference is not taken on trust. Note
  // `abandon` — the policy that is supposed to mean "outlive me" — and it still
  // does not survive, because cancellation is not a close.
  it('is the case `startChild` cannot express, even under abandon', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerWorkflow('runner', async () => {
        await condition(() => false);
        return 'unreachable';
      })
      .registerWorkflow('starter', async () => {
        startChild('runner', {
          workflowId: 'kid-1',
          parentClosePolicy: 'abandon',
        });
        await condition(() => false);
        return 'unreachable';
      });

    const handle = rt.start('starter', [], {workflowId: 'starter-2'});
    await wait(80);
    handle.cancel();
    await wait(120);

    // Reached by the cascade and unwound, exactly as if `abandon` had not been
    // asked for. The policy was never consulted, because no policy fires on a
    // cancel.
    expect((await store.get('kid-1'))?.status).toBe('failed');
  });

  it('survives its starter completing, with no policy to opt into', async () => {
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('runner', async () => {
        await condition(() => false);
        return 'unreachable';
      })
      .registerWorkflow('starter', async () => {
        startWorkflow('indep-2', 'runner');
        await sleep(5); // park, so the start is dispatched before this run ends
        return 'done';
      })
      .start('starter', [], {workflowId: 'starter-3'});
    await wait(200);

    expect((await store.get('starter-3'))?.status).toBe('completed');
    // A child here would be `terminated`, that being the default policy.
    expect((await store.get('indep-2'))?.status).toBe('running');
  });

  it('records no parent link, so nothing points back at the starter', async () => {
    const store = new MemoryHistoryStore();
    parkingStarter(store, 'indep-3').start('starter', [], {
      workflowId: 'starter-4',
    });
    await wait(120);

    // Not merely unused: absent. `closeChildren` reads this, so a link recorded
    // here would be a cascade waiting to happen.
    expect((await store.get('indep-3'))?.parent).toBeUndefined();
  });
});

describe('startWorkflow — the claimed id is the dedup', () => {
  it('starts one execution when the same id is claimed twice', async () => {
    const store = new MemoryHistoryStore();
    const starts: number[] = [];
    createLocalRuntime({historyStore: store})
      .registerWorkflow('runner', async () => {
        starts.push(1);
        await condition(() => false);
        return 'unreachable';
      })
      .registerWorkflow('starter', async () => {
        startWorkflow('indep-4', 'runner');
        await sleep(5); // a task boundary, so the second claim is a separate dispatch
        startWorkflow('indep-4', 'runner');
        await sleep(5);
        return 'done';
      })
      .start('starter', [], {workflowId: 'starter-5'});
    await wait(250);

    expect(starts.length).toBe(1);
  });

  it('records which of the two happened, because “already there” is expected', async () => {
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('runner', async () => {
        await condition(() => false);
        return 'unreachable';
      })
      .registerWorkflow('starter', async () => {
        startWorkflow('indep-5', 'runner');
        await sleep(5);
        startWorkflow('indep-5', 'runner');
        await sleep(5);
        return 'done';
      })
      .start('starter', [], {workflowId: 'starter-6'});
    await wait(250);

    const markers = ((await store.get('starter-6'))?.history ?? []).filter(
      (ev): ev is WorkflowStartedEvent => ev.type === 'workflowStarted',
    );
    expect(markers.length).toBe(2);
    expect(markers.map((m) => m.created)).toEqual([true, false]);
    // The name is kept on the marker because the id alone does not say what ran,
    // and this execution holds no other record of it — there is no parent link on
    // the target pointing back here.
    expect(markers[0]?.name).toBe('runner');
    expect(markers[0]?.targetId).toBe('indep-5');
  });
});

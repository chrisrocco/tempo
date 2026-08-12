/**
 * @fileoverview
 * Deploying changed workflow code while an execution of it is running. This is the
 * capability adoption blocker 3 in ROADMAP.md describes, whose mitigation today is
 * *"drain in-flight executions before deploying"* — which for a long-lived execution
 * means deleting the thing a user depends on and building it again.
 *
 * These are behaviour specs, so the register is the author's: each `it` states one
 * guarantee, and the workflows are inline so the whole example reads in one place.
 * What they add over `spec/core/patched.spec.ts` is the part a unit spec cannot
 * demonstrate — that the change happens **while the execution is running**, against
 * the real server, worker and store.
 *
 * ## How a redeploy is spelled here
 *
 * `registerWorkflow` on a live runtime, called a second time with the same name and
 * a different function. That is exactly what a rolling deploy does from the engine's
 * point of view: the next task for this execution is served by a worker holding
 * different code for the same workflow type, and the history it must replay was
 * written by the code that is going away. Nothing is faked — same server, same
 * store, same replay path, one process instead of two.
 */

import {createLocalRuntime} from '../../src';
import {
  condition,
  defineSignal,
  patched,
  runActivity,
  setHandler,
  sleep,
} from '../../src/workflow';

// real-time wait, for letting the async drives make progress
function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

const tick = defineSignal('tick');

describe('workflow versioning — changing a running workflow', () => {
  /**
   * The acceptance case. A workflow that lives long enough to be redeployed —
   * iterating for as long as it is fed — gains a branch mid-life, and the guarantee
   * is that the iterations already recorded in history keep the shape they were
   * recorded with while everything from the frontier on gets the new code. No drain,
   * no task failure, no restart.
   */
  it('keeps recorded iterations on the old branch and runs new ones on the new one', async () => {
    const calls: string[] = [];
    const rt = createLocalRuntime()
      .registerActivity('probe', () => {
        calls.push('probe');
        return 'plain';
      })
      .registerActivity('probeWithRetry', () => {
        calls.push('probeWithRetry');
        return 'retried';
      })
      // v1: one probe per tick, and no notion of a patch.
      .registerWorkflow('watcher', async () => {
        let ticks = 0;
        const seen: string[] = [];
        setHandler(tick, () => ticks++);
        while (seen.length < 3) {
          await condition(() => ticks > seen.length);
          seen.push(await runActivity<string>('probe'));
        }
        return seen.join(',');
      });

    const handle = rt.start<string>('watcher', [], {workflowId: 'w-1'});
    rt.getHandle('w-1').signal(tick);
    await wait(100);

    // The deploy: same workflow type, new body, execution untouched and running.
    rt.registerWorkflow('watcher', async () => {
      let ticks = 0;
      const seen: string[] = [];
      setHandler(tick, () => ticks++);
      while (seen.length < 3) {
        await condition(() => ticks > seen.length);
        seen.push(
          patched('probe-with-retry')
            ? await runActivity<string>('probeWithRetry')
            : await runActivity<string>('probe'),
        );
      }
      return seen.join(',');
    });

    rt.getHandle('w-1').signal(tick);
    await wait(100);
    rt.getHandle('w-1').signal(tick);

    // The first iteration was already in history, so it stays a plain probe; the two
    // that had not happened yet take the patched call.
    await expectAsync(handle.result()).toBeResolvedTo('plain,retried,retried');
    const detail = await rt.getHandle('w-1').describe();
    expect(detail!.taskFailures).toBe(0);
    rt.shutdown();
  });

  it('records the decision in history, so an operator can see which changes an execution adopted', async () => {
    const rt = createLocalRuntime().registerWorkflow('once', async () => {
      if (patched('new-shape')) return 'new';
      return 'old';
    });

    const handle = rt.start<string>('once', [], {workflowId: 'w-2'});
    await expectAsync(handle.result()).toBeResolvedTo('new');

    const detail = await rt.getHandle('w-2').describe();
    expect(detail!.history).toContain(
      jasmine.objectContaining({
        type: 'patchRecorded',
        seq: 0,
        patchId: 'new-shape',
      }),
    );
    rt.shutdown();
  });

  /**
   * The harder direction: *removing* a step. A running execution has a timer armed
   * that the new code no longer starts, and it must go on waiting for it — while an
   * execution started after the deploy skips the wait entirely. One source, two
   * behaviours, decided by what each execution's own history records.
   */
  it('lets a new execution skip a step a running one is still waiting on', async () => {
    const rt = createLocalRuntime()
      .registerActivity('prepare', () => 'ready')
      // v1: prepare, then wait before finishing.
      .registerWorkflow('waiter', async () => {
        await runActivity('prepare');
        await sleep(400);
        return 'waited';
      });

    const running = rt.start<string>('waiter', [], {workflowId: 'w-3'});
    await wait(120); // long enough to dispatch the activity and arm the timer

    // The deploy: the wait is gone for anything that has not already started it.
    rt.registerWorkflow('waiter', async () => {
      await runActivity('prepare');
      if (!patched('drop-the-wait')) await sleep(400);
      return 'waited';
    });

    const fresh = rt.start<string>('waiter', [], {workflowId: 'w-4'});

    await expectAsync(fresh.result()).toBeResolvedTo('waited');
    // Still running: its timer is real and it is still owed.
    expect(running.status()).toBe('running');
    await expectAsync(running.result()).toBeResolvedTo('waited');
    expect((await rt.getHandle('w-3').describe())!.taskFailures).toBe(0);
    rt.shutdown();
  });
});

describe('workflow versioning — an unversioned change is loud', () => {
  /**
   * The failure issue #52 was filed for. The new code drops a step whose work is
   * still in flight, so the replay reaches `return` with a timer armed that nothing
   * is waiting on. Before this check the execution **completed**, with the wrong
   * result and no error anywhere; now the task fails, which is the outcome the
   * poison-task path is built for — the execution stays running and a corrected
   * deploy recovers it.
   */
  it('fails the task rather than settling an execution whose recorded work it dropped', async () => {
    const rt = createLocalRuntime()
      .registerActivity('prepare', () => 'ready')
      .registerWorkflow('waiter', async () => {
        setHandler(tick, () => {});
        await runActivity('prepare');
        await sleep(60_000);
        return 'waited';
      });

    const handle = rt.start<string>('waiter', [], {workflowId: 'w-5'});
    await wait(120);

    // The same deploy as above, minus the `patched` guard — the mistake.
    rt.registerWorkflow('waiter', async () => {
      setHandler(tick, () => {});
      await runActivity('prepare');
      return 'abandoned';
    });

    rt.getHandle('w-5').signal(tick); // force a replay under the new code
    await wait(150);

    const detail = await rt.getHandle('w-5').describe();
    // Not `completed` with `result: 'abandoned'`, which is what this did before the
    // check existed — the measured line from issue #52, verbatim.
    expect(detail!.status).toBe('running');
    expect(detail!.result).toBeUndefined();
    expect(detail!.taskFailures).toBeGreaterThan(0);
    expect(detail!.lastTaskFailure).toContain('nondeterminism at seq 1');
    expect(detail!.lastTaskFailure).toContain('timerStarted');
    // The abandoned timer is still there, still owed, and still reported.
    expect(detail!.pending.timers.map((t) => t.seq)).toEqual([1]);
    rt.shutdown();
  });

  it('recovers the execution when the change is redeployed behind a patch', async () => {
    const rt = createLocalRuntime()
      .registerActivity('prepare', () => 'ready')
      .registerWorkflow('waiter', async () => {
        setHandler(tick, () => {});
        await runActivity('prepare');
        await sleep(300);
        return 'waited';
      });

    const handle = rt.start<string>('waiter', [], {workflowId: 'w-6'});
    await wait(120);

    rt.registerWorkflow('waiter', async () => {
      setHandler(tick, () => {});
      await runActivity('prepare');
      return 'abandoned';
    });
    rt.getHandle('w-6').signal(tick);
    await wait(120);
    expect(
      (await rt.getHandle('w-6').describe())!.taskFailures,
    ).toBeGreaterThan(0);

    // The fix, deployed on top of the broken one. Nothing durable was written by the
    // failed tasks, so the execution replays past them.
    rt.registerWorkflow('waiter', async () => {
      setHandler(tick, () => {});
      await runActivity('prepare');
      if (!patched('drop-the-wait')) await sleep(300);
      return 'waited';
    });

    await expectAsync(handle.result()).toBeResolvedTo('waited');
    rt.shutdown();
  });
});

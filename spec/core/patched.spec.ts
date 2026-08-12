/**
 * @fileoverview
 * `patched` / `deprecatePatch` at the layer where the danger lives: seq allocation.
 * Internals specs, for contributors.
 *
 * Every test here is written as an assertion about **which seq each command got**,
 * because that is the only thing a version branch can get wrong. A branch that
 * returns the wrong boolean is a behaviour bug in one execution; a branch that
 * shifts the seqs after it corrupts every completion in the rest of the history,
 * and does it silently. So the histories are hand-written and the expectations name
 * seqs explicitly rather than counting commands.
 *
 * The author-facing guarantee — a running workflow survives its body gaining a
 * branch — is demonstrated end to end in
 * `spec/integration/workflow_versioning.spec.ts`. This file is the mechanism.
 */

import {
  createContext,
  deprecatePatch,
  NondeterminismError,
  patched,
  replay,
  runActivity,
  sleep,
} from '../../src/core';
import type {HistoryEvent} from '../../src/protocol';

/** One activity marker, the shape pre-patch code leaves behind at a seq. */
function scheduled(seq: number, name: string): HistoryEvent {
  return {type: 'activityScheduled', seq, name, args: [], options: {}};
}

/** The worked example: a delay that gains jitter. */
function jitterWorkflow(taken: boolean[]) {
  return async function delayThenTick(): Promise<string> {
    const jittered = patched('schedule-jitter');
    taken.push(jittered);
    if (jittered) await runActivity('jittered-delay');
    else await sleep(1000);
    await runActivity('tick');
    return 'ticked';
  };
}

describe('core patched — a fresh execution', () => {
  it('takes the patched branch and records the decision at its own seq', async () => {
    const taken: boolean[] = [];
    const ctx = createContext([], []);

    await replay(ctx, jitterWorkflow(taken));

    expect(taken).toEqual([true]);
    expect(ctx.commands).toEqual([
      {type: 'recordPatch', patchId: 'schedule-jitter', seq: 0},
      {
        type: 'scheduleActivity',
        name: 'jittered-delay',
        args: [],
        options: {},
        seq: 1,
      },
    ]);
  });

  it('re-reads the recorded decision instead of deciding again', async () => {
    const taken: boolean[] = [];
    const events: HistoryEvent[] = [
      {type: 'patchRecorded', seq: 0, patchId: 'schedule-jitter'},
      scheduled(1, 'jittered-delay'),
      {type: 'activityCompleted', seq: 1, result: null},
    ];
    const ctx = createContext([], events);

    await replay(ctx, jitterWorkflow(taken));

    expect(taken).toEqual([true]);
    // Nothing re-emitted: the marker is already durable, so the only new command
    // is the one the workflow reached past it.
    expect(ctx.commands).toEqual([
      {type: 'scheduleActivity', name: 'tick', args: [], options: {}, seq: 2},
    ]);
  });
});

describe('core patched — an execution that already ran the old code', () => {
  /**
   * The case the primitive exists for. History holds a timer at seq 0, so seq 0 is
   * spoken for by pre-patch code — and the answer has to be `false` *before* the
   * branch allocates anything, or the `sleep` would land at seq 1 and every later
   * completion would find the wrong waiter.
   */
  it('takes the pre-patch branch, and leaves its seq to the pre-patch command', async () => {
    const taken: boolean[] = [];
    const events: HistoryEvent[] = [
      {type: 'timerStarted', seq: 0, fireAt: 1},
      {type: 'timerFired', seq: 0},
    ];
    const ctx = createContext([], events);

    await replay(ctx, jitterWorkflow(taken));

    expect(taken).toEqual([false]);
    expect(ctx.commands).toEqual([
      {type: 'scheduleActivity', name: 'tick', args: [], options: {}, seq: 1},
    ]);
    // The `sleep` claimed seq 0 — suppressed, because history holds it — which is
    // the whole reason `tick` lands on 1 and matches the history that follows.
    expect(ctx.requested.get(0)).toEqual({
      type: 'startTimer',
      ms: 1000,
      seq: 0,
    });
  });

  it('consumes no seq at all when it answers false', async () => {
    const ctx = createContext([], [scheduled(0, 'tick')]);

    await replay(ctx, async () => {
      if (patched('never-adopted')) await runActivity('other');
      await runActivity('tick');
    });

    expect([...ctx.requested.keys()]).toEqual([0]);
  });
});

describe('core patched — a long-lived execution mid-flight', () => {
  /**
   * The acceptance case, at the seq level: two iterations are already in history
   * and stay exactly as they were recorded, while the iteration nothing has reached
   * yet adopts the change. Both facts are the same rule — *what does this seq
   * already hold?* — and it is what makes the branch stable under replay: the third
   * iteration's answer is written down the moment it is made, so the next replay
   * reads `true` there rather than re-deciding, and the first two keep reading
   * `false`.
   */
  it('keeps recorded iterations on the old branch and adopts the change on the next', async () => {
    const taken: boolean[] = [];
    const events: HistoryEvent[] = [
      {type: 'timerStarted', seq: 0, fireAt: 1},
      {type: 'timerFired', seq: 0},
      scheduled(1, 'tick'),
      {type: 'activityCompleted', seq: 1, result: null},
      {type: 'timerStarted', seq: 2, fireAt: 2},
      {type: 'timerFired', seq: 2},
      scheduled(3, 'tick'),
      {type: 'activityCompleted', seq: 3, result: null},
    ];
    const ctx = createContext([], events);

    await replay(ctx, async () => {
      while (true) {
        const jittered = patched('schedule-jitter');
        taken.push(jittered);
        if (jittered) await runActivity('jittered-delay');
        else await sleep(1000);
        await runActivity('tick');
      }
    });

    expect(taken).toEqual([false, false, true]);
    expect(ctx.commands).toEqual([
      {type: 'recordPatch', patchId: 'schedule-jitter', seq: 4},
      {
        type: 'scheduleActivity',
        name: 'jittered-delay',
        args: [],
        options: {},
        seq: 5,
      },
    ]);
  });
});

describe('core patched — several patches in one workflow', () => {
  /**
   * A second patch added in front of a first one must not steal its seq. Each call
   * asks about the seq it is standing on and compares the id it finds, so the
   * pinned patch answers `true` wherever in the source it now appears and the new
   * one answers `false` for an execution that has already passed the point.
   */
  it('answers for the patch it names, not for whichever patch is recorded there', async () => {
    const ctx = createContext(
      [],
      [{type: 'patchRecorded', seq: 0, patchId: 'first'}],
    );
    const answers: boolean[] = [];

    await replay(ctx, async () => {
      answers.push(patched('second'));
      answers.push(patched('first'));
      await runActivity('tick');
    });

    expect(answers).toEqual([false, true]);
    expect(ctx.commands).toEqual([
      {type: 'scheduleActivity', name: 'tick', args: [], options: {}, seq: 1},
    ]);
  });

  it('records a distinct marker per patch on a fresh execution', async () => {
    const ctx = createContext([], []);

    await replay(ctx, async () => {
      patched('first');
      patched('second');
      await runActivity('tick');
    });

    expect(ctx.commands).toEqual([
      {type: 'recordPatch', patchId: 'first', seq: 0},
      {type: 'recordPatch', patchId: 'second', seq: 1},
      {type: 'scheduleActivity', name: 'tick', args: [], options: {}, seq: 2},
    ]);
  });
});

describe('core deprecatePatch — retiring a patch', () => {
  it('keeps the seq of a recorded patch accounted for once the branch is gone', async () => {
    const events: HistoryEvent[] = [
      {type: 'patchRecorded', seq: 0, patchId: 'schedule-jitter'},
      scheduled(1, 'jittered-delay'),
      {type: 'activityCompleted', seq: 1, result: null},
    ];
    const ctx = createContext([], events);

    await replay(ctx, async () => {
      deprecatePatch('schedule-jitter');
      await runActivity('jittered-delay');
      await runActivity('tick');
    });

    // seq 0 claimed but not re-emitted, so `tick` still lands on 2 and history's
    // shape is unchanged for an execution that carries the marker.
    expect(ctx.requested.get(0)).toEqual({
      type: 'recordPatch',
      patchId: 'schedule-jitter',
      seq: 0,
    });
    expect(ctx.commands).toEqual([
      {type: 'scheduleActivity', name: 'tick', args: [], options: {}, seq: 2},
    ]);
  });

  it('records nothing and costs no seq on an execution that has no marker', async () => {
    const ctx = createContext([], []);

    await replay(ctx, async () => {
      deprecatePatch('schedule-jitter');
      await runActivity('jittered-delay');
    });

    expect(ctx.commands).toEqual([
      {
        type: 'scheduleActivity',
        name: 'jittered-delay',
        args: [],
        options: {},
        seq: 0,
      },
    ]);
  });

  /**
   * Why `deprecatePatch` exists at all. Deleting the `if` without leaving this
   * behind hands the marker's seq to the next command, shifting everything after
   * it — so the primitive that looks like a no-op is the one that keeps a retired
   * patch from being a silent renumbering.
   */
  it('is what a removed patch needs: dropping the call outright is a divergence', async () => {
    const events: HistoryEvent[] = [
      {type: 'patchRecorded', seq: 0, patchId: 'schedule-jitter'},
      scheduled(1, 'jittered-delay'),
    ];
    const ctx = createContext([], events);

    await expectAsync(
      replay(ctx, async () => {
        await runActivity('jittered-delay');
      }),
    ).toBeRejectedWithError(NondeterminismError);
  });
});

describe('core patched — divergence', () => {
  it('names the patch and the command that took its seq', async () => {
    const ctx = createContext(
      [],
      [{type: 'patchRecorded', seq: 0, patchId: 'schedule-jitter'}],
    );

    let thrown: NondeterminismError | undefined;
    try {
      await replay(ctx, async () => {
        await runActivity('tick');
      });
    } catch (e) {
      thrown = e as NondeterminismError;
    }

    expect(thrown).toBeInstanceOf(NondeterminismError);
    expect(thrown!.seq).toBe(0);
    expect(thrown!.actual).toContain('patchRecorded schedule-jitter');
    expect(thrown!.expected).toContain('scheduleActivity tick');
  });

  /**
   * A rename is not a new patch, it is the same call site claiming a different
   * answer. Caught rather than treated as an unrecorded patch, because silently
   * re-deciding is how an execution ends up taking both branches.
   */
  it('stops replay when a patch is renamed under a recorded execution', async () => {
    const events: HistoryEvent[] = [
      {type: 'patchRecorded', seq: 0, patchId: 'old-name'},
      scheduled(1, 'jittered-delay'),
    ];
    const ctx = createContext([], events);

    await expectAsync(
      replay(ctx, async () => {
        if (patched('new-name')) await runActivity('jittered-delay');
        else await sleep(1000);
      }),
    ).toBeRejectedWithError(NondeterminismError);
  });
});

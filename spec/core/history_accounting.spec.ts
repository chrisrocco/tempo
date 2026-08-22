/**
 * @fileoverview
 * The check that a run which settles has accounted for the work history says is
 * still outstanding (`apply_event.assertHistoryAccounted`). Internals specs, for
 * contributors.
 *
 * This is the failure measured on issue #52 and the reason that issue exists: an
 * execution replayed by code that no longer issues a command history holds a marker
 * for did not throw, did not wedge, and did not stall. It **completed**, with
 * `done=true`, zero commands, and a result computed without the work it abandoned.
 * The activity in that history is still running; nothing will ever read its result;
 * nothing was reported. Every other divergence in this engine is loud, and this one
 * was the exception.
 *
 * So the specs come in two halves, and the second half is the load-bearing one. It
 * is easy to make this check fire; the difficulty is making it fire *only* on the
 * cases that are wrong, because the same shape — a run that stops short of a seq
 * history holds — is legitimate mid-flight, legitimate under cancellation, and
 * legitimate for a completed step a shortened loop no longer consumes.
 */

import {
  createContext,
  NondeterminismError,
  replay,
  runActivity,
} from '../../src/core';
import type {HistoryEvent} from '../../src/protocol';

function scheduled(seq: number, name: string): HistoryEvent {
  return {type: 'activityScheduled', seq, name, args: [], options: {}};
}

/** The workflow as it was: two stages, the second still in flight. */
const IN_FLIGHT_STAGE_TWO: HistoryEvent[] = [
  scheduled(0, 'stage1'),
  {type: 'activityCompleted', seq: 0, result: 'first'},
  scheduled(1, 'stage2'),
];

describe('core replay — a settled run that dropped recorded work', () => {
  /**
   * The measured failure, reproduced: the code has lost its second stage, and the
   * execution reaches `return` with that stage still running. Without this check the
   * replay succeeds and the server settles the execution as completed.
   */
  it('stops a run that finished while history still has work outstanding', async () => {
    const ctx = createContext([], IN_FLIGHT_STAGE_TWO);

    await expectAsync(
      replay(ctx, async () => {
        await runActivity('stage1');
        return 'abandoned';
      }),
    ).toBeRejectedWithError(NondeterminismError);
  });

  it('names the seq and the dispatch nothing claimed', async () => {
    const ctx = createContext([], IN_FLIGHT_STAGE_TWO);

    let thrown: NondeterminismError | undefined;
    try {
      await replay(ctx, async () => {
        await runActivity('stage1');
        return 'abandoned';
      });
    } catch (e) {
      thrown = e as NondeterminismError;
    }

    expect(thrown).toBeInstanceOf(NondeterminismError);
    expect(thrown!.seq).toBe(1);
    expect(thrown!.actual).toContain('activityScheduled stage2');
  });

  /**
   * A failing run is stopped too, and for a sharper reason than a completing one: a
   * task failure is retried after a redeploy, whereas a *failed execution* is
   * terminal. Publishing a failure derived from a replay that skipped recorded work
   * destroys work a corrected deploy would have recovered.
   */
  it('stops a run that failed while history still has work outstanding', async () => {
    const ctx = createContext([], IN_FLIGHT_STAGE_TWO);

    await expectAsync(
      replay(ctx, async () => {
        await runActivity('stage1');
        throw new Error('boom');
      }),
    ).toBeRejectedWithError(NondeterminismError);
  });

  /**
   * A detached child has no completion event ever, so "outstanding" is its
   * permanent state — and it is running work that a parent which no longer issues
   * the spawn cannot even cancel, because `cancelChild` names the spawning seq and
   * that seq now belongs to something else.
   */
  it('counts a detached child, which is outstanding by construction', async () => {
    const events: HistoryEvent[] = [
      {type: 'childStarted', seq: 0, childId: 'kid-1', detached: true},
    ];
    const ctx = createContext([], events);

    await expectAsync(replay(ctx, async () => 'done')).toBeRejectedWithError(
      NondeterminismError,
    );
  });

  it('reports the earliest divergence, not the last', async () => {
    const events: HistoryEvent[] = [
      scheduled(0, 'stage1'),
      {type: 'activityCompleted', seq: 0, result: 'first'},
      scheduled(1, 'stage2'),
      scheduled(2, 'stage3'),
    ];
    const ctx = createContext([], events);

    let thrown: NondeterminismError | undefined;
    try {
      await replay(ctx, async () => {
        await runActivity('stage1');
        return 'abandoned';
      });
    } catch (e) {
      thrown = e as NondeterminismError;
    }

    expect(thrown!.seq).toBe(1);
  });
});

describe('core replay — absences that are not divergence', () => {
  /**
   * The rule the whole check turns on: an unaccounted seq is a *question* while the
   * run is still parked. It may simply not have reached that seq yet, and there is
   * no way to tell from history which it is — so nothing is claimed until the run
   * commits to an outcome.
   */
  it('says nothing about a parked run that has not reached a recorded seq', async () => {
    const events: HistoryEvent[] = [
      scheduled(0, 'stage1'),
      scheduled(1, 'stage2'),
    ];
    const ctx = createContext([], events);

    await expectAsync(
      replay(ctx, async () => {
        await runActivity('stage1');
        return 'both';
      }),
    ).toBeResolved();
    expect(ctx.done).toBeFalse();
  });

  /**
   * Cancellation is the sanctioned way to stop allocating seqs mid-run: everything
   * outstanding is rejected and every later primitive rejects on creation, so an
   * unwinding run legitimately never issues seqs its history holds. This is the
   * case `apply_event`'s "absence is not divergence" was written for, and it stays
   * exempt when the run settles.
   */
  it('says nothing about a cancelled run that unwound past recorded work', async () => {
    const events: HistoryEvent[] = [
      scheduled(0, 'stage1'),
      scheduled(1, 'stage2'),
      {type: 'cancelRequested'},
    ];
    const ctx = createContext([], events);

    await expectAsync(
      replay(ctx, async () => {
        try {
          await runActivity('stage1');
          return 'both';
        } catch {
          return 'unwound';
        }
      }),
    ).toBeResolved();
    expect(ctx.result).toBe('unwound');
  });

  /**
   * The exclusion that keeps a *correct* workflow passing.
   * `continueAsNewSuggested` is a server-provided input
   * that flips partway through a run, so `while (!workflowInfo().continueAsNewSuggested)`
   * legitimately runs fewer iterations on a later task than it ran on an earlier
   * one, leaving completed activities behind that nothing consumes any more.
   *
   * Nothing is orphaned by that: the effect happened and its result is recorded. A
   * run that no longer reads a finished result has ignored a value, which is a
   * different thing from abandoning a job — and only the second one is worth
   * failing an execution over.
   */
  it('says nothing about work that already finished, however it was reached', async () => {
    const events: HistoryEvent[] = [
      scheduled(0, 'stage1'),
      {type: 'activityCompleted', seq: 0, result: 'first'},
      scheduled(1, 'stage2'),
      {type: 'activityCompleted', seq: 1, result: 'second'},
    ];
    const ctx = createContext([], events);

    await expectAsync(
      replay(ctx, async () => {
        await runActivity('stage1');
        return 'stopped early';
      }),
    ).toBeResolved();
    expect(ctx.done).toBeTrue();
  });

  it('says nothing about a run that accounted for everything and finished', async () => {
    const events: HistoryEvent[] = [
      scheduled(0, 'stage1'),
      {type: 'activityCompleted', seq: 0, result: 'first'},
    ];
    const ctx = createContext([], events);

    await expectAsync(
      replay(ctx, async () => runActivity<string>('stage1')),
    ).toBeResolved();
    expect(ctx.result).toBe('first');
  });
});

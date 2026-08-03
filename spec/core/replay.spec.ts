/**
 * @fileoverview
 * The replay loop, tested at the layer it actually lives at: `(history) ->
 * (commands)`, with hand-written histories and no runtime, no server, no I/O.
 * That this is possible at all is the determinism boundary paying off — see
 * `src/workflow.ts`.
 *
 * These are internals specs (per AGENTS.md's two-kinds split): they pin the
 * invariants the engine rests on, for contributors. The author-facing programming
 * model is documented by `spec/integration/local.spec.ts`.
 */

import {
  createContext,
  NondeterminismError,
  replay,
  runActivity,
  sleep,
} from '../../src/core';
import type {HistoryEvent} from '../../src/protocol';

describe('core replay — empty history', () => {
  it('emits a command for the primitive a workflow calls first', async () => {
    const ctx = createContext([], []);

    await replay(ctx, async () => {
      await runActivity('greet', 'world');
    });

    expect(ctx.commands).toEqual([
      {
        type: 'scheduleActivity',
        name: 'greet',
        args: ['world'],
        options: {},
        seq: 0,
      },
    ]);
  });

  it('parks the workflow rather than finishing it when work is outstanding', async () => {
    const ctx = createContext([], []);

    await replay(ctx, async () => {
      await runActivity('never-completes');
      return 'unreachable';
    });

    expect(ctx.done).toBeFalse();
    expect(ctx.result).toBeUndefined();
  });

  it('finishes inside the first task when the workflow never awaits', async () => {
    const ctx = createContext([], []);

    await replay(ctx, async () => 'immediate');

    expect(ctx.done).toBeTrue();
    expect(ctx.result).toBe('immediate');
  });

  it('passes the run arguments to the workflow function', async () => {
    const ctx = createContext(['world'], []);

    await replay(ctx, async (name: string) => `hello ${name}`);

    expect(ctx.result).toBe('hello world');
  });

  /**
   * The driver observes the workflow promise with `.then` rather than awaiting
   * it, so a workflow that throws records a terminal failure instead of blowing
   * up the task. `replay` itself must resolve.
   */
  it('records a thrown failure instead of rejecting out of replay', async () => {
    const ctx = createContext([], []);

    await replay(ctx, async () => {
      throw new Error('boom');
    });

    expect(ctx.failed).toBeTrue();
    expect((ctx.failure as Error).message).toBe('boom');
    expect(ctx.done).toBeFalse();
  });
});

describe('core replay — the live edge', () => {
  /**
   * The central guarantee. A command already recorded in history must NOT be
   * re-emitted, or the runtime would dispatch it a second time. Only calls made
   * after history runs out are new work.
   */
  it('suppresses commands that history has already recorded', async () => {
    // Two recorded completions, three calls: only the third is new work. The
    // second event matters — with a single one, a driver that went live too
    // early would be indistinguishable from a correct one.
    const events: HistoryEvent[] = [
      {type: 'activityCompleted', seq: 0, result: 'first'},
      {type: 'activityCompleted', seq: 1, result: 'second'},
    ];
    const ctx = createContext([], events);

    await replay(ctx, async () => {
      await runActivity('a');
      await runActivity('b');
      await runActivity('c');
    });

    // 'a' and 'b' were already durable, so only 'c' is dispatched.
    expect(ctx.commands.length).toBe(1);
    expect(ctx.commands[0]).toEqual(
      jasmine.objectContaining({name: 'c', seq: 2}),
    );
  });

  it('emits nothing when history replays the workflow all the way to done', async () => {
    const events: HistoryEvent[] = [
      {type: 'activityCompleted', seq: 0, result: 1},
      {type: 'activityCompleted', seq: 1, result: 2},
    ];
    const ctx = createContext([], events);

    await replay(ctx, async () => {
      const a = await runActivity<number>('a');
      const b = await runActivity<number>('b');
      return a + b;
    });

    expect(ctx.commands).toEqual([]);
    expect(ctx.done).toBeTrue();
    expect(ctx.result).toBe(3);
  });

  it('goes live once the last recorded event is consumed', async () => {
    const ctx = createContext([], [{type: 'timerFired', seq: 0}]);

    await replay(ctx, async () => {
      await sleep(5);
      await sleep(10);
    });

    expect(ctx.isLive).toBeTrue();
    expect(ctx.commands.map((c) => c.seq)).toEqual([1]);
  });

  it('starts live when there is no history to catch up on', () => {
    expect(createContext([], []).isLive).toBeTrue();
    expect(
      createContext([], [{type: 'timerFired', seq: 0}]).isLive,
    ).toBeFalse();
  });

  /**
   * Recorded results flow back into the workflow's own variables, which is what
   * makes replay a reconstruction of state rather than a re-execution of effects.
   */
  it('feeds recorded results back into the workflow as its own values', async () => {
    const events: HistoryEvent[] = [
      {type: 'activityCompleted', seq: 0, result: 'recorded'},
    ];
    const ctx = createContext([], events);
    let seenInsideWorkflow: unknown;

    await replay(ctx, async () => {
      seenInsideWorkflow = await runActivity<string>('a');
    });

    expect(seenInsideWorkflow).toBe('recorded');
  });

  it('surfaces a recorded activity failure as a rejection the workflow can catch', async () => {
    const events: HistoryEvent[] = [
      {type: 'activityFailed', seq: 0, error: 'upstream exploded'},
    ];
    const ctx = createContext([], events);

    await replay(ctx, async () => {
      try {
        await runActivity('a');
        return 'no failure';
      } catch (e) {
        return `caught: ${(e as Error).message}`;
      }
    });

    expect(ctx.result).toBe('caught: upstream exploded');
  });
});

/**
 * The branch-order divergence these checks exist for (planning/tickets/04). Seqs
 * are assigned in call order, so two concurrent branches that swap order produce
 * seqs whose meanings have swapped — and both are parked, so both resolve, each
 * with the other's result. The completion-side check cannot see that; comparing
 * markers against the commands actually issued can.
 */
describe('core replay — divergence between history and code', () => {
  it('stops replay when a marker disagrees with the command issued at that seq', async () => {
    // History from a run where the timer was created first; this code creates the
    // activity first, so seq 0 means different things on each side.
    const events: HistoryEvent[] = [
      {type: 'timerStarted', seq: 0, fireAt: 1},
      {type: 'activityScheduled', seq: 1, name: 'a', args: [], options: {}},
    ];
    const ctx = createContext([], events);

    await expectAsync(
      replay(ctx, async () => {
        await Promise.all([runActivity('a'), sleep(10)]);
      }),
    ).toBeRejectedWithError(NondeterminismError);
  });

  it('replays two concurrent branches whose order is unchanged', async () => {
    const events: HistoryEvent[] = [
      {type: 'activityScheduled', seq: 0, name: 'a', args: [], options: {}},
      {type: 'timerStarted', seq: 1, fireAt: 1},
    ];
    const ctx = createContext([], events);

    await expectAsync(
      replay(ctx, async () => {
        await Promise.all([runActivity('a'), sleep(10)]);
      }),
    ).toBeResolved();
  });

  /**
   * The check rests on the workflow having issued seq N before the marker for N
   * is applied. That holds because the server writes a marker only after
   * receiving the command batch, so every event that drove the emission precedes
   * it in history. Pinned rather than assumed — on the first task, where the
   * command is issued during the initial synchronous run before any event is
   * applied, and on a later one, where it is issued only after an earlier
   * completion resumes the workflow.
   */
  it('validates a marker issued during the first synchronous run', async () => {
    const events: HistoryEvent[] = [
      {type: 'activityScheduled', seq: 0, name: 'a', args: [], options: {}},
    ];
    const ctx = createContext([], events);

    await expectAsync(
      replay(ctx, async () => {
        await runActivity('a');
      }),
    ).toBeResolved();
  });

  it('validates a marker for a command issued only after an earlier completion', async () => {
    const events: HistoryEvent[] = [
      {
        type: 'activityScheduled',
        seq: 0,
        name: 'first',
        args: [],
        options: {},
      },
      {type: 'activityCompleted', seq: 0, result: 'ok'},
      {
        type: 'activityScheduled',
        seq: 1,
        name: 'second',
        args: [],
        options: {},
      },
    ];
    const ctx = createContext([], events);

    await replay(ctx, async () => {
      await runActivity('first');
      await runActivity('second');
    });

    expect(ctx.requested.get(1)).toEqual({
      type: 'scheduleActivity',
      seq: 1,
      name: 'second',
      args: [],
      options: {},
    });
  });
});

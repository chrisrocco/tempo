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
  defineSignal,
  NondeterminismError,
  replay,
  runActivity,
  setHandler,
  sleep,
  startChild,
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

describe('core replay — command suppression', () => {
  /**
   * The central guarantee. A command already recorded in history must NOT be
   * re-emitted, or the runtime would dispatch it a second time. What history
   * holds no event for is what is new.
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

  it('emits only the call history has no event for', async () => {
    const ctx = createContext([], [{type: 'timerFired', seq: 0}]);

    await replay(ctx, async () => {
      await sleep(5);
      await sleep(10);
    });

    expect(ctx.commands.map((c) => c.seq)).toEqual([1]);
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
 * What history has no record of must be emitted, *whenever* the workflow reaches
 * it — issue #39. Suppression is a question about content, and the cases above
 * only ever ask it at a moment when position happens to answer it correctly.
 *
 * Two triggers reach a genuinely new command while history remains, and they are
 * worth separating because they fail at different points in the driver:
 *
 * 1. **Mid-batch.** An activation is a *batch*, and every case above applies
 *    exactly one event. Give the batch a trailing event and settling an earlier
 *    completion carries the workflow onward while events remain. Ordinary rather
 *    than exotic: `ports/workflow_task_queue` coalesces a wake landing mid-task
 *    into one more task, so a signal arriving while an activity completion is in
 *    flight produces exactly `[…, activityCompleted, signal]`.
 * 2. **A first task that already has history.** A signal landing between the
 *    start and the worker's first poll gives task one a history of `[signal]`, so
 *    the workflow's initial synchronous run — before any event is applied —
 *    reaches new work with nothing consumed yet.
 *
 * Both drop the command, so history never records it and the next replay drops it
 * for the same reason. Nothing throws; the execution simply parks forever.
 */
describe('core replay — new work reached while history remains', () => {
  const ping = defineSignal('ping');

  it('emits a command the workflow reaches before the batch is exhausted', async () => {
    // The completion is what moves the workflow on to `sleep`; the signal behind
    // it is only there to keep history from having run out at that moment.
    const events: HistoryEvent[] = [
      {type: 'activityScheduled', seq: 0, name: 'look', args: [], options: {}},
      {type: 'activityCompleted', seq: 0, result: 'ok'},
      {type: 'signal', name: 'ping', payload: 'hello'},
    ];
    const ctx = createContext([], events);

    await replay(ctx, async () => {
      setHandler(ping, () => {});
      await runActivity('look');
      await sleep(1000);
    });

    expect(ctx.commands).toEqual([{type: 'startTimer', ms: 1000, seq: 1}]);
  });

  it('suppresses a command history has recorded even when it is issued mid-batch', async () => {
    // The other direction, and the one that keeps the fix from double-dispatching:
    // the timer is reached at the same point as above, but this history already
    // holds its marker.
    const events: HistoryEvent[] = [
      {type: 'activityScheduled', seq: 0, name: 'look', args: [], options: {}},
      {type: 'activityCompleted', seq: 0, result: 'ok'},
      {type: 'timerStarted', seq: 1, fireAt: 1},
      {type: 'signal', name: 'ping', payload: 'hello'},
    ];
    const ctx = createContext([], events);

    await replay(ctx, async () => {
      setHandler(ping, () => {});
      await runActivity('look');
      await sleep(1000);
    });

    expect(ctx.commands).toEqual([]);
  });

  /**
   * The second trigger, and the one a driver change cannot reach: this happens in
   * the initial run, before the event loop has consumed anything. `isLive` starts
   * false whenever history is non-empty, so the first command the workflow ever
   * issues is suppressed despite nothing having dispatched it.
   */
  it('emits the first command when the first task already has history', async () => {
    const events: HistoryEvent[] = [
      {type: 'signal', name: 'ping', payload: 'early'},
    ];
    const ctx = createContext([], events);

    await replay(ctx, async () => {
      setHandler(ping, () => {});
      await runActivity('work');
    });

    expect(ctx.commands).toEqual([
      {type: 'scheduleActivity', name: 'work', args: [], options: {}, seq: 0},
    ]);
  });

  it('delivers a trailing signal to its handler as well as emitting the new command', async () => {
    const events: HistoryEvent[] = [
      {type: 'activityScheduled', seq: 0, name: 'look', args: [], options: {}},
      {type: 'activityCompleted', seq: 0, result: 'ok'},
      {type: 'signal', name: 'ping', payload: 'hello'},
    ];
    const ctx = createContext([], events);
    const seen: string[] = [];

    await replay(ctx, async () => {
      setHandler(ping, (payload: string) => seen.push(payload));
      await runActivity('look');
      await sleep(1000);
    });

    expect(seen).toEqual(['hello']);
    expect(ctx.commands.map((c) => c.seq)).toEqual([1]);
  });

  /**
   * `cancelChild` was the one command the rule could not cover, because it wrote
   * no marker — so its seq was absent from history whether or not it had been
   * dispatched, and the live-edge flag decided. `childCancelRequested` (issue #50)
   * is what makes it answerable like everything else, and these two pin the answer
   * in both directions.
   */
  it('does not re-emit a cancelChild history has recorded', async () => {
    const events: HistoryEvent[] = [
      {type: 'childStarted', seq: 0, childId: 'child', detached: true},
      {type: 'childCancelRequested', seq: 1, targetSeq: 0},
      {type: 'activityScheduled', seq: 2, name: 'after', args: [], options: {}},
    ];
    const ctx = createContext([], events);

    await replay(ctx, async () => {
      startChild('watcher').cancel();
      await runActivity('after');
    });

    expect(ctx.commands).toEqual([]);
    expect(ctx.requested.get(1)).toEqual({
      type: 'cancelChild',
      targetSeq: 0,
      seq: 1,
    });
  });

  it('emits a cancelChild reached mid-batch, which no marker records', async () => {
    // The gap #49 left open. The completion moves the workflow on to `cancel()`
    // while the signal behind it keeps history from having run out — the shape
    // that used to drop the command with nothing to show it had gone.
    const events: HistoryEvent[] = [
      {type: 'childStarted', seq: 0, childId: 'child', detached: true},
      {type: 'activityScheduled', seq: 1, name: 'look', args: [], options: {}},
      {type: 'activityCompleted', seq: 1, result: 'ok'},
      {type: 'signal', name: 'ping', payload: 'hello'},
    ];
    const ctx = createContext([], events);

    await replay(ctx, async () => {
      setHandler(ping, () => {});
      const handle = startChild('watcher');
      await runActivity('look');
      handle.cancel();
      await sleep(1000);
    });

    expect(ctx.commands).toEqual([
      {type: 'cancelChild', targetSeq: 0, seq: 2},
      {type: 'startTimer', ms: 1000, seq: 3},
    ]);
  });
});

/**
 * The branch-order divergence these checks exist for; `apply_event.ts` owns the
 * reasoning and the coverage table. Seqs
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

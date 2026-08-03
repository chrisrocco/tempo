/**
 * @fileoverview
 * `signalStream` / `firstSignal` / `background`, driven against hand-written
 * histories through the real `replay` loop — no runtime, no server.
 *
 * Three of these matter more than the rest, because they pin things that were
 * argued for rather than demonstrated when the API was designed: that
 * AsyncLocalStorage survives being resumed inside a generator, that a parked
 * stream lets a task reach quiescence instead of hanging, and that the same
 * history drives the same commands twice over.
 */

import {
  background,
  condition,
  createContext,
  defineSignal,
  firstSignal,
  replay,
  runActivity,
  setHandler,
  signalStream,
} from '../../src/core';
import type {HistoryEvent} from '../../src/protocol';

const comment = defineSignal('comment');
const stop = defineSignal('stop');

/** A signal event, since these specs are mostly lists of them. */
function sig(name: string, payload: unknown): HistoryEvent {
  return {type: 'signal', name, payload};
}

describe('signalStream — consuming', () => {
  it('yields each signal payload in history order', async () => {
    const ctx = createContext([], [sig('comment', 'a'), sig('comment', 'b')]);
    const seen: unknown[] = [];

    await replay(ctx, async () => {
      for await (const p of signalStream(comment)) seen.push(p);
    });

    expect(seen).toEqual(['a', 'b']);
  });

  /**
   * The distinction from `for...of` over an empty array, which falls straight
   * through. An empty-but-open stream parks the workflow instead — the loop body
   * has not run, the code after the loop has not run, and the workflow is not done.
   */
  it('parks on an empty stream rather than falling through the loop', async () => {
    const ctx = createContext([], []);
    let ranBody = false;
    let ranAfter = false;

    await replay(ctx, async () => {
      for await (const _ of signalStream(comment)) ranBody = true;
      ranAfter = true;
    });

    expect(ranBody).toBeFalse();
    expect(ranAfter).toBeFalse();
    expect(ctx.done).toBeFalse();
  });

  /**
   * Quiescence: a task with a parked stream must conclude, not hang or spin.
   * `replay` resolving at all is the assertion.
   */
  it('lets the task reach quiescence while a stream is parked', async () => {
    const ctx = createContext([], [sig('comment', 'a')]);

    await replay(ctx, async () => {
      for await (const _ of signalStream(comment)) {
        /* consume and park again */
      }
    });

    expect(ctx.done).toBeFalse();
    expect(ctx.failed).toBeFalse();
  });

  it('holds signals that arrive while the body is busy', async () => {
    const events: HistoryEvent[] = [
      sig('comment', 'a'),
      {type: 'activityCompleted', seq: 0, result: null}, // body finishes 'a'
      sig('comment', 'b'),
    ];
    const ctx = createContext([], events);
    const seen: unknown[] = [];

    await replay(ctx, async () => {
      for await (const p of signalStream(comment)) {
        seen.push(p);
        await runActivity('handle'); // parks; 'b' lands during this
      }
    });

    expect(seen).toEqual(['a', 'b']);
  });
});

describe('signalStream — ending', () => {
  it('ends the stream when `until` settles', async () => {
    const ctx = createContext([], [sig('stop', null)]);
    let ranAfter = false;

    await replay(ctx, async () => {
      let stopped = false;
      setHandler(stop, () => {
        stopped = true;
      });
      for await (const _ of signalStream(comment, {
        until: condition(() => stopped),
      })) {
        /* nothing arrives */
      }
      ranAfter = true;
    });

    expect(ranAfter).toBeTrue();
    expect(ctx.done).toBeTrue();
  });

  /**
   * `until` firing must not discard signals that arrived during the window, so
   * the backlog is drained before the stream reports done.
   */
  it('drains the backlog before honouring `until`', async () => {
    const events: HistoryEvent[] = [
      sig('comment', 'a'),
      sig('comment', 'b'),
      {type: 'activityCompleted', seq: 0, result: null},
    ];
    const ctx = createContext([], events);
    const seen: unknown[] = [];

    await replay(ctx, async () => {
      // Nothing consumes 'comment' yet, so both buffer.
      await runActivity('setup');
      for await (const p of signalStream(comment, {
        from: 'start',
        until: condition(() => true), // already satisfied
      })) {
        seen.push(p);
      }
    });

    expect(seen).toEqual(['a', 'b']);
  });

  it('releases the signal name when the stream ends', async () => {
    const ctx = createContext([], [sig('stop', null)]);

    await replay(ctx, async () => {
      let stopped = false;
      setHandler(stop, () => {
        stopped = true;
      });
      for await (const _ of signalStream(comment, {
        until: condition(() => stopped),
      })) {
        /* empty */
      }
    });

    expect(ctx.signalHandlers.has('comment')).toBeFalse();
  });

  it('releases the signal name when the consumer breaks out', async () => {
    const ctx = createContext([], [sig('comment', 'a')]);
    let released = false;

    await replay(ctx, async () => {
      for await (const _ of signalStream(comment)) break;
      released = true;
    });

    expect(released).toBeTrue();
    expect(ctx.signalHandlers.has('comment')).toBeFalse();
  });
});

describe('signalStream — start position', () => {
  it('ignores signals buffered before the call by default', async () => {
    const events: HistoryEvent[] = [
      sig('comment', 'before'),
      {type: 'activityCompleted', seq: 0, result: null},
    ];
    const ctx = createContext([], events);
    const seen: unknown[] = [];

    await replay(ctx, async () => {
      await runActivity('setup'); // 'before' buffers while nothing consumes
      for await (const p of signalStream(comment, {
        until: condition(() => true),
      })) {
        seen.push(p);
      }
    });

    expect(seen).toEqual([]);
  });

  it('includes the buffered backlog when asked for `from: start`', async () => {
    const events: HistoryEvent[] = [
      sig('comment', 'before'),
      {type: 'activityCompleted', seq: 0, result: null},
    ];
    const ctx = createContext([], events);
    const seen: unknown[] = [];

    await replay(ctx, async () => {
      await runActivity('setup');
      for await (const p of signalStream(comment, {
        from: 'start',
        until: condition(() => true),
      })) {
        seen.push(p);
      }
    });

    expect(seen).toEqual(['before']);
  });
});

describe('signalStream — determinism', () => {
  /**
   * The property the whole design rests on: the module allocates no `seq`, so a
   * stream cannot shift the numbering of the commands around it.
   */
  it('consumes no command seq', async () => {
    const ctx = createContext([], []); // empty history, so commands go live

    await replay(ctx, async () => {
      signalStream(comment); // registers; must not allocate
      void firstSignal(stop); // registers; must not allocate
      void runActivity('first'); // the only thing that may take seq 0
    });

    expect(ctx.commands.length).toBe(1);
    expect(ctx.commands[0].seq).toBe(0);
    expect(ctx.seq).toBe(1);
  });

  /**
   * AsyncLocalStorage has to survive resumption *inside a generator*: the body
   * below calls `runActivity`, which needs `getContext()`, after being woken by
   * an event applied outside the `als.run` scope. If propagation broke, this
   * throws rather than emitting a command.
   */
  it('keeps the workflow context across a generator resumption', async () => {
    const ctx = createContext([], [sig('comment', 'a')]);

    await replay(ctx, async () => {
      for await (const p of signalStream(comment)) {
        await runActivity('probe', p);
      }
    });

    expect(ctx.commands.length).toBe(1);
    expect(ctx.commands[0]).toEqual(
      jasmine.objectContaining({name: 'probe', args: ['a']}),
    );
  });

  /** Same history, same commands — the definition of replay safety. */
  it('emits identical commands when the same history is replayed twice', async () => {
    const events: HistoryEvent[] = [
      sig('comment', 'a'),
      {type: 'activityCompleted', seq: 0, result: null},
      sig('comment', 'b'),
    ];
    const workflow = async (): Promise<void> => {
      for await (const p of signalStream(comment)) {
        await runActivity('handle', p);
      }
    };

    const first = createContext([], events);
    await replay(first, workflow);
    const second = createContext([], events);
    await replay(second, workflow);

    expect(second.commands).toEqual(first.commands);
    expect(second.seq).toBe(first.seq);
  });

  /**
   * Two branches allocating from one counter is the case most likely to diverge,
   * so it gets its own round-trip.
   */
  it('reproduces command interleaving across two concurrent branches', async () => {
    const events: HistoryEvent[] = [
      sig('comment', 'a'),
      {type: 'activityCompleted', seq: 1, result: null}, // the branch's activity
      sig('comment', 'b'),
    ];
    const order: string[] = [];
    const workflow = async (): Promise<void> => {
      background(async () => {
        for await (const p of signalStream(comment)) {
          order.push(`branch:${String(p)}`);
          await runActivity('branch', p);
        }
      });
      order.push('main');
      await runActivity('main'); // seq 0, never completes in this history
    };

    const first = createContext([], events);
    await replay(first, workflow);
    const firstOrder = [...order];
    order.length = 0;
    const second = createContext([], events);
    await replay(second, workflow);

    // The branch interleaves with the main line at a fixed point every time.
    expect(firstOrder).toEqual(['main', 'branch:a', 'branch:b']);
    expect(order).toEqual(firstOrder);
    expect(second.seq).toBe(first.seq);
    expect(second.commands).toEqual(first.commands);
  });
});

describe('signalStream — one consumer per signal', () => {
  it('rejects a second consumer of the same signal', async () => {
    const ctx = createContext([], []);
    let message = '';

    await replay(ctx, async () => {
      signalStream(comment);
      try {
        signalStream(comment);
      } catch (e) {
        message = (e as Error).message;
      }
    });

    expect(message).toContain('already has a consumer');
  });

  it('allows a new consumer once the previous one has ended', async () => {
    const ctx = createContext([], [sig('comment', 'a')]);
    let reclaimed = false;

    await replay(ctx, async () => {
      for await (const _ of signalStream(comment)) break; // releases on break
      signalStream(comment);
      reclaimed = true;
    });

    expect(reclaimed).toBeTrue();
  });
});

describe('firstSignal', () => {
  it('resolves with the first signal to arrive and releases the name', async () => {
    const ctx = createContext([], [sig('comment', 'x'), sig('comment', 'y')]);
    let got: unknown;

    await replay(ctx, async () => {
      got = await firstSignal(comment);
    });

    expect(got).toBe('x');
    expect(ctx.signalHandlers.has('comment')).toBeFalse();
  });

  /**
   * Registering eagerly is the whole point: a signal that lands between creating
   * the promise and awaiting it must still be caught. This is what makes it safe
   * to build one before the window it is meant to bound.
   */
  it('catches a signal that arrives before the promise is awaited', async () => {
    const events: HistoryEvent[] = [
      sig('stop', 'early'), // lands while the workflow is inside the activity
      {type: 'activityCompleted', seq: 0, result: null},
    ];
    const ctx = createContext([], events);
    let got: unknown;

    await replay(ctx, async () => {
      const pending = firstSignal(stop); // created, not yet awaited
      await runActivity('unrelated');
      got = await pending;
    });

    expect(got).toBe('early');
  });
});

describe('background', () => {
  it('surfaces a failed branch on the main line', async () => {
    const ctx = createContext([], []);
    let message = '';

    await replay(ctx, async () => {
      const branch = background(async () => {
        throw new Error('branch died');
      });
      await branch.done;
      try {
        branch.throwIfFailed();
      } catch (e) {
        message = (e as Error).message;
      }
    });

    expect(message).toBe('branch died');
  });

  it('stays silent for a branch that succeeds', async () => {
    const ctx = createContext([], []);
    let threw = false;

    await replay(ctx, async () => {
      const branch = background(async () => 'fine');
      await branch.done;
      try {
        branch.throwIfFailed();
      } catch {
        threw = true;
      }
    });

    expect(threw).toBeFalse();
    expect(ctx.failed).toBeFalse();
  });

  it('runs a branch concurrently with the main line', async () => {
    const ctx = createContext([], []);
    const order: string[] = [];

    await replay(ctx, async () => {
      background(async () => {
        order.push('branch');
        await runActivity('branch-work');
      });
      order.push('main');
      await runActivity('main-work');
    });

    expect(order).toEqual(['branch', 'main']);
    expect(ctx.commands.map((c) => c.seq)).toEqual([0, 1]);
  });
});

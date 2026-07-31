/**
 * @fileoverview
 * `condition` mechanics: the eager fast path, parking, the unblock pass running
 * to a fixpoint, and the separate counter that keeps conditions from perturbing
 * command numbering. Internals specs, for contributors.
 */

import {
  als,
  applyEvent,
  CancelledFailure,
  condition,
  createContext,
  drainMicrotasks,
  runActivity,
  settle,
  tryUnblockConditions,
} from '../../src/core';

describe('core condition — registration', () => {
  it('resolves at once without parking when the predicate already holds', async () => {
    const ctx = createContext([], []);
    let passed = false;

    await als.run(ctx, async () => {
      await condition(() => true);
      passed = true;
    });

    expect(passed).toBeTrue();
    expect(ctx.blockedConditions.size).toBe(0);
  });

  it('parks the caller when the predicate is false', () => {
    const ctx = createContext([], []);

    als.run(ctx, () => {
      void condition(() => false);
    });

    expect(ctx.blockedConditions.size).toBe(1);
  });

  /**
   * The invariant that keeps conditions invisible to history: they are counted
   * on `condSeq`, never on the command `seq`. Numbering commands off a counter a
   * condition could bump would desynchronise replay from recorded history.
   */
  it('never consumes a command seq', () => {
    const ctx = createContext([], []);

    als.run(ctx, () => {
      void condition(() => false);
      void runActivity('a');
    });

    expect(ctx.commands[0].seq).toBe(0);
    expect(ctx.seq).toBe(1);
    expect(ctx.condSeq).toBe(1);
  });
});

describe('core condition — the unblock pass', () => {
  it('reports no progress while every predicate is still false', () => {
    const ctx = createContext([], []);
    als.run(ctx, () => {
      void condition(() => false);
    });

    expect(tryUnblockConditions(ctx)).toBeFalse();
    expect(ctx.blockedConditions.size).toBe(1);
  });

  it('resolves a parked condition once its predicate turns true', async () => {
    const ctx = createContext([], []);
    let flag = false;
    let woke = false;
    als.run(ctx, async () => {
      await condition(() => flag);
      woke = true;
    });

    flag = true;
    expect(tryUnblockConditions(ctx)).toBeTrue();
    await drainMicrotasks();

    expect(woke).toBeTrue();
    expect(ctx.blockedConditions.size).toBe(0);
  });

  /**
   * Resolving one condition runs more workflow code, which can make a second
   * condition true. A single pass would miss the one it had already checked, so
   * `settle` loops the pass to a fixpoint.
   */
  it('keeps passing until no further condition can be unblocked', async () => {
    const ctx = createContext([], []);
    const order: string[] = [];
    let first = false;
    let second = false;

    als.run(ctx, () => {
      // Registered first, but cannot become true until the other one resolves.
      void (async () => {
        await condition(() => second);
        order.push('second');
      })();
      void (async () => {
        await condition(() => first);
        order.push('first');
        second = true;
      })();
    });

    first = true;
    await settle(ctx);

    expect(order).toEqual(['first', 'second']);
    expect(ctx.blockedConditions.size).toBe(0);
  });
});

describe('core condition — cancellation', () => {
  it('rejects a parked condition when the run is cancelled', async () => {
    const ctx = createContext([], []);
    let error: unknown;
    als.run(ctx, async () => {
      try {
        await condition(() => false);
      } catch (e) {
        error = e;
      }
    });

    applyEvent(ctx, { type: 'cancelRequested' });
    await drainMicrotasks();

    expect(error).toBeInstanceOf(CancelledFailure);
  });

  it('rejects immediately when called after the run is already cancelled', async () => {
    const ctx = createContext([], []);
    ctx.cancelled = true;
    let error: unknown;

    await als.run(ctx, async () => {
      try {
        // True predicate, but cancellation wins — no new waiting after cancel.
        await condition(() => true);
      } catch (e) {
        error = e;
      }
    });

    expect(error).toBeInstanceOf(CancelledFailure);
  });
});

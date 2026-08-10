/**
 * @fileoverview
 * `applyEvent` routing, tested directly against a hand-built context: which
 * events resolve a parked promise, which deliberately do nothing, and which
 * unwind the whole run. Internals specs, for contributors.
 */

import type {WorkflowContext} from '../../src/core';
import {
  als,
  applyEvent,
  CancelledFailure,
  createContext,
  defineSignal,
  NondeterminismError,
  setHandler,
} from '../../src/core';
import type {Command} from '../../src/protocol';

/** Park a fake waiter at `seq` and report how it settles. */
function parkWaiter(ctx: WorkflowContext, seq: number) {
  const settled: {value?: unknown; error?: unknown; done: boolean} = {
    done: false,
  };
  ctx.completions.set(seq, {
    resolve: (v) => {
      settled.value = v;
      settled.done = true;
    },
    reject: (e) => {
      settled.error = e;
      settled.done = true;
    },
  });
  return settled;
}

describe('core applyEvent — completions', () => {
  it('routes a completion to the promise parked at its seq', () => {
    const ctx = createContext([], []);
    const waiter = parkWaiter(ctx, 0);

    applyEvent(ctx, {type: 'activityCompleted', seq: 0, result: 'x'});

    expect(waiter.value).toBe('x');
    expect(ctx.completions.has(0)).toBeFalse();
  });

  it('routes each completion to its own seq, not to call order', () => {
    const ctx = createContext([], []);
    const first = parkWaiter(ctx, 0);
    const second = parkWaiter(ctx, 1);

    applyEvent(ctx, {type: 'activityCompleted', seq: 1, result: 'second'});

    expect(second.value).toBe('second');
    expect(first.done).toBeFalse();
  });

  it('rejects the parked promise when the activity failed', () => {
    const ctx = createContext([], []);
    const waiter = parkWaiter(ctx, 0);

    applyEvent(ctx, {type: 'activityFailed', seq: 0, error: 'nope'});

    expect((waiter.error as Error).message).toBe('nope');
  });

  it('resolves a fired timer with no value', () => {
    const ctx = createContext([], []);
    const waiter = parkWaiter(ctx, 0);

    applyEvent(ctx, {type: 'timerFired', seq: 0});

    expect(waiter.done).toBeTrue();
    expect(waiter.value).toBeUndefined();
  });

  /**
   * The nondeterminism check. A completion for a seq nothing is waiting on means
   * the workflow code no longer matches the history it is being replayed against
   * — fail loudly rather than silently diverge.
   */
  it('throws a nondeterminism error for a completion with no matching seq', () => {
    const ctx = createContext([], []);

    expect(() =>
      applyEvent(ctx, {type: 'activityCompleted', seq: 7, result: 1}),
    ).toThrowError(/nondeterminism.*seq 7/);
  });
});

describe('core applyEvent — markers', () => {
  /**
   * Markers record that work was dispatched. They resolve nothing: the real
   * completion arrives later as its own event under the same seq.
   */
  it('leaves the parked promise untouched for a scheduled-activity marker', () => {
    const ctx = createContext([], []);
    const waiter = parkWaiter(ctx, 0);

    applyEvent(ctx, {
      type: 'activityScheduled',
      seq: 0,
      name: 'a',
      args: [],
      options: {},
    });

    expect(waiter.done).toBeFalse();
    expect(ctx.completions.has(0)).toBeTrue();
  });

  it('leaves the parked promise untouched for timer and child markers', () => {
    const ctx = createContext([], []);
    const timer = parkWaiter(ctx, 0);
    const child = parkWaiter(ctx, 1);

    applyEvent(ctx, {
      type: 'timerStarted',
      seq: 0,
      fireAt: 123,
    });
    applyEvent(ctx, {
      type: 'childStarted',
      seq: 1,
      childId: 'c-1',
      detached: false,
    });

    expect(timer.done).toBeFalse();
    expect(child.done).toBeFalse();
  });

  /**
   * A detached child's marker exists purely to advance history past its
   * `startChild` command, so replay does not launch a second child. Nothing is
   * ever parked on it, and it must stay a no-op like every other marker.
   */
  it('leaves a detached child marker inert, since no completion follows it', () => {
    const ctx = createContext([], []);

    expect(() =>
      applyEvent(ctx, {
        type: 'childStarted',
        seq: 0,
        childId: 'c-1',
        detached: true,
      }),
    ).not.toThrow();
    expect(ctx.completions.size).toBe(0);
  });
});

describe('core applyEvent — marker validation', () => {
  /** Record what the workflow claims about a seq, as `issue` does on replay. */
  function requested(ctx: WorkflowContext, cmd: Command): void {
    ctx.requested.set(cmd.seq, cmd);
  }

  it('accepts a marker that matches the command issued at its seq', () => {
    const ctx = createContext([], []);
    requested(ctx, {
      type: 'scheduleActivity',
      seq: 0,
      name: 'greet',
      args: [],
      options: {},
    });

    expect(() =>
      applyEvent(ctx, {
        type: 'activityScheduled',
        seq: 0,
        name: 'greet',
        args: [],
        options: {},
      }),
    ).not.toThrow();
  });

  it('rejects a marker whose kind disagrees with the command at that seq', () => {
    const ctx = createContext([], []);
    requested(ctx, {type: 'startTimer', seq: 0, ms: 10});

    expect(() =>
      applyEvent(ctx, {
        type: 'activityScheduled',
        seq: 0,
        name: 'greet',
        args: [],
        options: {},
      }),
    ).toThrowError(NondeterminismError);
  });

  it('rejects a marker for a different activity than the one requested', () => {
    const ctx = createContext([], []);
    requested(ctx, {
      type: 'scheduleActivity',
      seq: 0,
      name: 'charge',
      args: [],
      options: {},
    });

    expect(() =>
      applyEvent(ctx, {
        type: 'activityScheduled',
        seq: 0,
        name: 'refund',
        args: [],
        options: {},
      }),
    ).toThrowError(/seq 0.*activityScheduled refund.*scheduleActivity charge/);
  });

  it('rejects a child marker whose detached flag disagrees', () => {
    const ctx = createContext([], []);
    requested(ctx, {
      type: 'startChild',
      seq: 0,
      childName: 'c',
      childArgs: [],
      detached: false,
      parentClosePolicy: 'abandon',
    });

    expect(() =>
      applyEvent(ctx, {
        type: 'childStarted',
        seq: 0,
        childId: 'c-1',
        detached: true,
      }),
    ).toThrowError(NondeterminismError);
  });

  /**
   * A workflow-chosen child id is checkable in a way a derived one is not: it
   * came from the workflow's own logic, so a different one this time means that
   * logic moved. Unchecked, the parent would await the child history names while
   * believing it started another.
   */
  it('rejects a child marker whose id disagrees with the id the workflow chose', () => {
    const ctx = createContext([], []);
    requested(ctx, {
      type: 'startChild',
      seq: 0,
      childName: 'planner',
      childArgs: [],
      detached: false,
      parentClosePolicy: 'abandon',
      workflowId: 'plan-for-event-42',
    });

    expect(() =>
      applyEvent(ctx, {
        type: 'childStarted',
        seq: 0,
        childId: 'plan-for-event-7',
        detached: false,
      }),
    ).toThrowError(/plan-for-event-42/);
  });

  it('accepts a derived child id, which the workflow never claimed', () => {
    const ctx = createContext([], []);
    requested(ctx, {
      type: 'startChild',
      seq: 0,
      childName: 'planner',
      childArgs: [],
      detached: false,
      parentClosePolicy: 'abandon',
    });

    expect(() =>
      applyEvent(ctx, {
        type: 'childStarted',
        seq: 0,
        childId: 'parent.0.0',
        detached: false,
      }),
    ).not.toThrow();
  });

  it('names the seq and both sides of the disagreement', () => {
    const ctx = createContext([], []);
    requested(ctx, {type: 'startTimer', seq: 3, ms: 5});

    let thrown: NondeterminismError | undefined;
    try {
      applyEvent(ctx, {
        type: 'activityScheduled',
        seq: 3,
        name: 'greet',
        args: [],
        options: {},
      });
    } catch (e) {
      thrown = e as NondeterminismError;
    }

    expect(thrown).toBeInstanceOf(NondeterminismError);
    expect(thrown!.seq).toBe(3);
    expect(thrown!.actual).toContain('activityScheduled greet');
    expect(thrown!.expected).toContain('startTimer');
  });

  // A timer's marker records `fireAt`, an absolute time, while the command
  // carries a relative `ms` — there is nothing to compare, so only the kind is.
  it('accepts a timer marker regardless of when it fires', () => {
    const ctx = createContext([], []);
    requested(ctx, {type: 'startTimer', seq: 0, ms: 10});

    expect(() =>
      applyEvent(ctx, {type: 'timerStarted', seq: 0, fireAt: 999999}),
    ).not.toThrow();
  });

  /**
   * Absence is not disagreement. A run stops allocating seqs the moment
   * `cancelRequested` is applied, so a marker can legitimately arrive for a seq
   * this replay never issued — rejecting it would fail a correct workflow.
   */
  it('skips validation for a seq the workflow never issued', () => {
    const ctx = createContext([], []);

    expect(() =>
      applyEvent(ctx, {
        type: 'activityScheduled',
        seq: 9,
        name: 'greet',
        args: [],
        options: {},
      }),
    ).not.toThrow();
  });
});

describe('core applyEvent — signals', () => {
  it('delivers a signal to its registered handler', () => {
    const ctx = createContext([], []);
    const received: unknown[] = [];
    als.run(ctx, () => {
      setHandler(defineSignal('ping'), (p) => received.push(p));
    });

    applyEvent(ctx, {type: 'signal', name: 'ping', payload: 42});

    expect(received).toEqual([42]);
  });

  /**
   * Signals are external, so one can land before the workflow has registered its
   * handler. Buffering makes delivery order-independent instead of lossy.
   */
  it('buffers a signal that arrives before its handler is registered', () => {
    const ctx = createContext([], []);
    applyEvent(ctx, {type: 'signal', name: 'ping', payload: 'early'});
    expect(ctx.bufferedSignals.length).toBe(1);

    const received: unknown[] = [];
    als.run(ctx, () => {
      setHandler(defineSignal('ping'), (p) => received.push(p));
    });

    expect(received).toEqual(['early']);
    expect(ctx.bufferedSignals.length).toBe(0);
  });

  it('leaves buffered signals for other names alone when one handler registers', () => {
    const ctx = createContext([], []);
    applyEvent(ctx, {type: 'signal', name: 'ping', payload: 1});
    applyEvent(ctx, {type: 'signal', name: 'pong', payload: 2});

    als.run(ctx, () => setHandler(defineSignal('ping'), () => {}));

    expect(ctx.bufferedSignals.map((s) => s.name)).toEqual(['pong']);
  });
});

describe('core applyEvent — cancellation', () => {
  /**
   * Cancellation is a recorded event, not a side effect, so the cancel point is
   * fixed in history and replay stays deterministic. Applying it rejects
   * everything the run is currently awaiting.
   */
  it('rejects every outstanding operation with CancelledFailure', () => {
    const ctx = createContext([], []);
    const activity = parkWaiter(ctx, 0);
    let conditionError: unknown;
    ctx.blockedConditions.set(0, {
      fn: () => false,
      resolve: () => {},
      reject: (e) => {
        conditionError = e;
      },
    });

    applyEvent(ctx, {type: 'cancelRequested'});

    expect(activity.error).toBeInstanceOf(CancelledFailure);
    expect(conditionError).toBeInstanceOf(CancelledFailure);
  });

  it('marks the run cancelled and clears what it was waiting on', () => {
    const ctx = createContext([], []);
    parkWaiter(ctx, 0);

    applyEvent(ctx, {type: 'cancelRequested'});

    expect(ctx.cancelled).toBeTrue();
    expect(ctx.completions.size).toBe(0);
    expect(ctx.blockedConditions.size).toBe(0);
  });
});

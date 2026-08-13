/**
 * @fileoverview
 * The `nextFire` activity: the one place in the schedule layer that reads a clock.
 *
 * The arithmetic is covered in `next_fire.spec.ts`. What is left to pin here is
 * everything the clock introduces — that the nominal time does *not* depend on it,
 * that the delay does, and that a boundary already past yields `0` rather than a
 * negative number.
 *
 * `jasmine.clock().mockDate()` rather than a injected clock parameter: the point of
 * this function is that it reaches for `Date.now()` itself, so a spec that passed the
 * time in would be testing a different function.
 */

import {isExhausted, nextFire} from '../../src/schedule/next_fire_activity';
import type {IntervalSpec} from '../../src/protocol';

const every = (everyMs: number, offsetMs?: number): IntervalSpec => ({
  type: 'interval',
  everyMs,
  ...(offsetMs === undefined ? {} : {offsetMs}),
});

describe('nextFire activity', () => {
  beforeEach(() => {
    jasmine.clock().install();
  });

  afterEach(() => {
    jasmine.clock().uninstall();
  });

  it('returns the delay from now to the boundary', () => {
    jasmine.clock().mockDate(new Date(1_500));
    const result = nextFire(every(1000), 1_000);

    expect(isExhausted(result)).toBe(false);
    expect(result).toEqual({nominalTimeMs: 2_000, delayMs: 500});
  });

  /**
   * The nominal time is a property of the spec, not of when the question was asked —
   * which is what lets a retried attempt of this activity produce the same execution
   * id, and therefore what makes a repeated fire idempotent rather than a duplicate
   * run.
   */
  it('gives the same nominal time however late it is asked', () => {
    const at = (now: number): number => {
      jasmine.clock().mockDate(new Date(now));
      const result = nextFire(every(1000), 1_000);
      return isExhausted(result) ? -1 : result.nominalTimeMs;
    };

    expect([at(1_001), at(1_500), at(1_999), at(50_000)]).toEqual([
      2_000, 2_000, 2_000, 2_000,
    ]);
  });

  /**
   * The normal state after an outage or a slow run, not an error. The boundary that
   * was missed is still the boundary, so the fired run keeps the id it would have
   * had; only the waiting is over.
   */
  it('clamps a past-due boundary to fire now rather than reporting a negative delay', () => {
    jasmine.clock().mockDate(new Date(500_000));
    const result = nextFire(every(1000), 1_000);

    expect(result).toEqual({nominalTimeMs: 2_000, delayMs: 0});
  });

  it('reports exhausted when the bounds have run out', () => {
    jasmine.clock().mockDate(new Date(0));
    const result = nextFire(every(1000), 2_000, {notAfterMs: 2_500});

    expect(isExhausted(result)).toBe(true);
    expect(result).toEqual({exhausted: true});
  });

  // A scheduler branches on this every cycle, so the guard has to narrow for the
  // compiler as well as answer correctly.
  it('narrows through isExhausted', () => {
    jasmine.clock().mockDate(new Date(0));
    const result = nextFire(every(1000), 0);

    if (isExhausted(result)) throw new Error('unreachable');
    expect(result.nominalTimeMs).toBe(1_000);
  });
});

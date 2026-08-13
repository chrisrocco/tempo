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
   * The idempotency guarantee, stated exactly: **asked at any point within the same
   * period, the nominal time does not move.** That is what lets a retried attempt of
   * this activity produce the same execution id, and therefore what makes a repeated
   * fire claim one run rather than two — a retry happens seconds later, not periods
   * later.
   *
   * It is deliberately *not* "the same however late you ask". Asked a period or more
   * late the answer advances, because the catch-up policy searches from at most one
   * period back; a question asked an hour late should be answered with the boundary
   * just gone, not the one an hour ago.
   */
  it('gives the same nominal time anywhere within one period', () => {
    const at = (now: number): number => {
      jasmine.clock().mockDate(new Date(now));
      const result = nextFire(every(1000), 1_000);
      return isExhausted(result) ? -1 : result.nominalTimeMs;
    };

    expect([at(1_001), at(1_500), at(1_999)]).toEqual([2_000, 2_000, 2_000]);
  });

  /**
   * The normal state after an outage or a slow run, not an error. The boundary that
   * was missed is still the boundary, so the fired run keeps the id it would have
   * had; only the waiting is over.
   */
  it('clamps a past-due boundary to fire now rather than reporting a negative delay', () => {
    // Half a period late: the boundary at 2000 has passed, and is still the one owed.
    jasmine.clock().mockDate(new Date(2_500));
    const result = nextFire(every(1000), 1_000);

    expect(result).toEqual({nominalTimeMs: 2_000, delayMs: 0});
  });

  /**
   * The two catch-up cases, which are genuinely different questions. Collapsing them
   * was a real bug and the scheduler specs caught it from both sides: treating "never
   * fired" as "handled through the epoch" made a new schedule walk every boundary
   * since 1970, and treating it as "look back one period" made a new hourly schedule
   * fire immediately for a boundary that passed before it existed.
   */
  it('searches from now when nothing has been handled yet', () => {
    jasmine.clock().mockDate(new Date(10_000));
    // Hourly boundaries; the most recent one is far in the past. A new schedule must
    // not fire for it — that boundary was never owed.
    const result = nextFire(every(3_600_000), undefined);

    if (isExhausted(result)) throw new Error('unreachable');
    expect(result.nominalTimeMs).toBe(3_600_000);
    expect(result.delayMs).toBe(3_590_000);
  });

  it('collapses an outage backlog to one fire, not a replay of the gap', () => {
    // Ten periods have passed since the last handled boundary.
    jasmine.clock().mockDate(new Date(10_000));
    const result = nextFire(every(1000), 0);

    if (isExhausted(result)) throw new Error('unreachable');
    // The boundary just gone, fired now — not boundary 1000 and then a walk forward.
    expect(result.nominalTimeMs).toBe(10_000);
    expect(result.delayMs).toBe(0);
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

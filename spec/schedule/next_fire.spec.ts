/**
 * @fileoverview
 * Interval boundary arithmetic.
 *
 * Exhaustive out of proportion to the code's size, on purpose: this is the one part
 * of a schedule that is cheap to test and expensive to get wrong. A boundary computed
 * one period late is not a crash, it is a job that runs at the wrong time and keeps
 * running at the wrong time, and nothing downstream can detect it.
 *
 * Instants are small integers rather than plausible epoch values wherever the
 * property under test does not care, because `1000` can be checked by eye and
 * `1755043200000` cannot.
 */

import {
  lookbackFloorMs,
  nextFireAfter,
  scheduleSpecProblems,
} from '../../src/schedule/next_fire';
import type {IntervalSpec} from '../../src/protocol';

const every = (everyMs: number, offsetMs?: number): IntervalSpec => ({
  type: 'interval',
  everyMs,
  ...(offsetMs === undefined ? {} : {offsetMs}),
});

describe('nextFireAfter — interval boundaries', () => {
  it('lands on the first boundary after the instant given', () => {
    expect(nextFireAfter(every(1000), 0)).toBe(1000);
    expect(nextFireAfter(every(1000), 1)).toBe(1000);
    expect(nextFireAfter(every(1000), 999)).toBe(1000);
  });

  /**
   * The property the scheduler loop is built on. Having fired at `T` it asks again
   * with `T`; an inclusive answer would return `T` and the loop would re-fire one
   * nominal time forever without advancing.
   */
  it('is strictly after, so asking from a boundary advances', () => {
    expect(nextFireAfter(every(1000), 1000)).toBe(2000);
    expect(nextFireAfter(every(1000), 2000)).toBe(3000);
  });

  it('aligns to the epoch, not to when it was asked', () => {
    // "Every hour at :15" is the same instant set whenever the question is put.
    const hourly = every(3_600_000, 900_000);
    expect(nextFireAfter(hourly, 0)).toBe(900_000);
    expect(nextFireAfter(hourly, 900_000)).toBe(4_500_000);
    // Asked from deep inside a later period, still on the :15 boundary.
    expect(nextFireAfter(hourly, 10_000_000)! % 3_600_000).toBe(900_000);
  });

  /**
   * `Math.floor`, not `%`. A remainder in JavaScript takes the sign of its dividend,
   * so for an instant left of the offset it goes negative and the "next" boundary
   * lands in the past — a schedule that fires immediately and forever.
   */
  it('works left of the offset, where a remainder would go backwards', () => {
    expect(nextFireAfter(every(1000), -1)).toBe(0);
    expect(nextFireAfter(every(1000), -1000)).toBe(0);
    expect(nextFireAfter(every(1000), -1001)).toBe(-1000);
    expect(nextFireAfter(every(1000, 250), -1)).toBe(250);
    // The guarantee, stated as the property rather than as an example. Note the
    // normalised modulo: a bare `next % 1000` is the very trap the implementation
    // avoids, and it caught this assertion first — for `after = -5000` the correct
    // boundary is -4750, and `-4750 % 1000` is `-750`, not `250`.
    const mod = (n: number, m: number): number => ((n % m) + m) % m;
    for (const after of [-5000, -1, 0, 1, 12_345]) {
      const next = nextFireAfter(every(1000, 250), after)!;
      expect(next).toBeGreaterThan(after);
      expect(mod(next, 1000)).toBe(250);
    }
  });

  it('treats a whole period as one step, not a special case', () => {
    expect(nextFireAfter(every(1), 5)).toBe(6);
    expect(nextFireAfter(every(86_400_000), 0)).toBe(86_400_000);
  });
});

describe('nextFireAfter — bounds', () => {
  it('skips boundaries before notBeforeMs', () => {
    expect(nextFireAfter(every(1000), 0, {notBeforeMs: 5500})).toBe(6000);
  });

  // Inclusive: "not before 6000" permits 6000 itself. The exclusive reading would
  // silently cost the first fire of every schedule whose start lands on a boundary.
  it('allows a boundary exactly at notBeforeMs', () => {
    expect(nextFireAfter(every(1000), 0, {notBeforeMs: 6000})).toBe(6000);
  });

  it('reports exhausted once boundaries pass notAfterMs', () => {
    expect(nextFireAfter(every(1000), 0, {notAfterMs: 2500})).toBe(1000);
    expect(
      nextFireAfter(every(1000), 2000, {notAfterMs: 2500}),
    ).toBeUndefined();
  });

  // Exclusive, so `notAfterMs` can be set *to* a boundary without that boundary
  // firing — which is what makes "run until midnight" unambiguous about midnight.
  it('excludes a boundary exactly at notAfterMs', () => {
    expect(nextFireAfter(every(1000), 0, {notAfterMs: 1000})).toBeUndefined();
  });

  // A window that contains no boundary at all: the next one at or after 5001 is
  // 6000, which is past the end. Note that widening this by one millisecond at each
  // end *would* admit 5000 — the bounds are inclusive-then-exclusive, and this is the
  // case that pins which way round they are.
  it('is exhausted rather than throwing when bounds admit no boundary', () => {
    expect(
      nextFireAfter(every(1000), 0, {notBeforeMs: 5001, notAfterMs: 5999}),
    ).toBeUndefined();
    expect(
      nextFireAfter(every(1000), 0, {notBeforeMs: 5000, notAfterMs: 5001}),
    ).toBe(5000);
  });
});

describe('scheduleSpecProblems', () => {
  it('accepts a valid spec', () => {
    expect(scheduleSpecProblems(every(1000))).toEqual([]);
    expect(scheduleSpecProblems(every(1000, 999))).toEqual([]);
    expect(
      scheduleSpecProblems(every(1000), {notBeforeMs: 0, notAfterMs: 1}),
    ).toEqual([]);
  });

  it('rejects a period that is not a positive integer', () => {
    expect(scheduleSpecProblems(every(0))[0]).toContain('positive integer');
    expect(scheduleSpecProblems(every(-1000))[0]).toContain('positive integer');
    expect(scheduleSpecProblems(every(1.5))[0]).toContain('positive integer');
    expect(scheduleSpecProblems(every(NaN))[0]).toContain('positive integer');
  });

  it('rejects an offset of a whole period rather than folding it away', () => {
    // A units slip — someone meaning 15 minutes into an hour and writing minutes.
    const problems = scheduleSpecProblems(every(1000, 1000));
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('units slip');
  });

  it('rejects a negative offset', () => {
    expect(scheduleSpecProblems(every(1000, -1))[0]).toContain(
      'non-negative integer',
    );
  });

  // One complaint about the period, not two: an offset "too large" for a period of
  // zero is really the same fault reported twice.
  it('does not blame the offset for a broken period', () => {
    expect(scheduleSpecProblems(every(0, 500)).length).toBe(1);
  });

  it('rejects bounds that can never admit a fire', () => {
    expect(
      scheduleSpecProblems(every(1000), {
        notBeforeMs: 5000,
        notAfterMs: 5000,
      })[0],
    ).toContain('can never fire');
  });

  // One round trip names everything, because the caller is a person typing a spec.
  it('reports every problem at once', () => {
    expect(
      scheduleSpecProblems(every(-1, -1), {
        notBeforeMs: 10,
        notAfterMs: 5,
      }).length,
    ).toBe(3);
  });

  it('is the same list nextFireAfter refuses on', () => {
    expect(() => nextFireAfter(every(0), 0)).toThrowError(
      /invalid schedule spec.*positive integer/,
    );
  });
});

/**
 * The dispatch seam: nextFireAfter and scheduleSpecProblems answer for calendar
 * specs too, with the arithmetic itself proven in spec/timespec/wall_clock.spec.ts. What is
 * proven *here* is that a calendar spec gets the same bounds treatment and the
 * same refuse-on-problems contract as an interval — the properties a third spec
 * type would also have to satisfy.
 */
describe('nextFireAfter — calendar specs through the same seam', () => {
  const nineUtc = {type: 'calendar', hour: 9} as const;

  it('dispatches a calendar spec to the calendar arithmetic', () => {
    expect(nextFireAfter(nineUtc, Date.UTC(2026, 5, 15, 8))).toBe(
      Date.UTC(2026, 5, 15, 9),
    );
  });

  it('applies notBeforeMs inclusively, same as an interval', () => {
    expect(
      nextFireAfter(nineUtc, 0, {notBeforeMs: Date.UTC(2026, 5, 15, 9)}),
    ).toBe(Date.UTC(2026, 5, 15, 9));
  });

  it('exhausts on notAfterMs, same as an interval', () => {
    expect(
      nextFireAfter(nineUtc, Date.UTC(2026, 5, 15, 10), {
        notAfterMs: Date.UTC(2026, 5, 16, 9),
      }),
    ).toBeUndefined();
  });

  it('refuses a bad calendar spec with the same throw contract', () => {
    expect(() => nextFireAfter({type: 'calendar', hour: 25}, 0)).toThrowError(
      /invalid schedule spec.*hour/,
    );
  });
});

describe('lookbackFloorMs — the catch-up clamp, per spec type', () => {
  it('is one period back for an interval', () => {
    expect(lookbackFloorMs(every(1000), 5500)).toBe(4500);
  });

  /**
   * The property the activity relies on: nextFireAfter asked from the floor
   * yields the most recent boundary at or before now — so an outage's backlog
   * collapses to one fire — for both spec types alike.
   */
  it('makes the most recent missed boundary reachable, for both spec types', () => {
    const now = 5500;
    expect(nextFireAfter(every(1000), lookbackFloorMs(every(1000), now))).toBe(
      5000,
    );

    const nineUtc = {type: 'calendar', hour: 9} as const;
    const afterOutage = Date.UTC(2026, 5, 15, 12);
    expect(nextFireAfter(nineUtc, lookbackFloorMs(nineUtc, afterOutage))).toBe(
      Date.UTC(2026, 5, 15, 9),
    );
  });
});

/**
 * @fileoverview
 * Calendar boundary arithmetic, including the DST policy — held to the same
 * standard as the interval arithmetic next door, and for the same reason: a
 * boundary computed one hour off is not a crash, it is a job that runs at the
 * wrong time twice a year, and nothing downstream can detect it.
 *
 * Instants are written as `Date.UTC(...)` rather than epoch literals so each
 * case can be checked by eye against the sentence above it. The timezone cases
 * pin America/Chicago across the 2026 transitions — spring forward on March 8
 * (2:00 → 3:00 CST→CDT) and fall back on November 1 (2:00 → 1:00 CDT→CST) —
 * dates verified against the platform's own timezone data, which is also what
 * the implementation reads, so a tzdata update cannot split the two.
 */

import {
  calendarSpecProblems,
  nextCalendarFireAfter,
  previousCalendarFireAtOrBefore,
} from '../../src/schedule/calendar';
import type {CalendarSpec} from '../../src/protocol';

function calendar(fields: Omit<CalendarSpec, 'type'>): CalendarSpec {
  return {type: 'calendar', ...fields};
}

describe('nextCalendarFireAfter — wall-clock boundaries in UTC', () => {
  it('defaults to daily at midnight', () => {
    expect(
      nextCalendarFireAfter(calendar({}), Date.UTC(2026, 5, 15, 10, 30)),
    ).toBe(Date.UTC(2026, 5, 16));
  });

  it('lands on the specified hour and minute of the day', () => {
    const nineThirty = calendar({hour: 9, minute: 30});
    expect(nextCalendarFireAfter(nineThirty, Date.UTC(2026, 5, 15, 8))).toBe(
      Date.UTC(2026, 5, 15, 9, 30),
    );
  });

  it('is strictly after, so asking from a boundary advances', () => {
    const nineThirty = calendar({hour: 9, minute: 30});
    expect(
      nextCalendarFireAfter(nineThirty, Date.UTC(2026, 5, 15, 9, 30)),
    ).toBe(Date.UTC(2026, 5, 16, 9, 30));
  });

  it('walks multiple hours and minutes within a day in order', () => {
    const twiceDaily = calendar({hour: [9, 17]});
    expect(nextCalendarFireAfter(twiceDaily, Date.UTC(2026, 5, 15, 9))).toBe(
      Date.UTC(2026, 5, 15, 17),
    );
    expect(nextCalendarFireAfter(twiceDaily, Date.UTC(2026, 5, 15, 17))).toBe(
      Date.UTC(2026, 5, 16, 9),
    );
  });

  it('skips days the dayOfWeek filter excludes', () => {
    // 2026-06-19 is a Friday; the next weekday 9:00 is Monday the 22nd.
    const weekdays = calendar({hour: 9, dayOfWeek: [1, 2, 3, 4, 5]});
    expect(nextCalendarFireAfter(weekdays, Date.UTC(2026, 5, 19, 10))).toBe(
      Date.UTC(2026, 5, 22, 9),
    );
  });

  it('honours month and dayOfMonth together — a yearly boundary', () => {
    const newYear = calendar({month: 1, dayOfMonth: 1});
    expect(nextCalendarFireAfter(newYear, Date.UTC(2026, 5, 15))).toBe(
      Date.UTC(2027, 0, 1),
    );
  });

  /**
   * Temporal's semantics, not cron's: dayOfMonth AND dayOfWeek, where cron takes
   * the union. The case that tells them apart is Friday the 13th — under union
   * semantics this would fire on the next Friday *or* the next 13th.
   */
  it('intersects dayOfMonth with dayOfWeek rather than cron-style union', () => {
    const fridayThe13th = calendar({dayOfMonth: 13, dayOfWeek: 5});
    // The next Friday the 13th after 2026-06-15 is 2026-11-13.
    expect(nextCalendarFireAfter(fridayThe13th, Date.UTC(2026, 5, 15))).toBe(
      Date.UTC(2026, 10, 13),
    );
  });

  it('reaches a Feb 29 rule across non-leap years', () => {
    const leapDay = calendar({month: 2, dayOfMonth: 29});
    expect(nextCalendarFireAfter(leapDay, Date.UTC(2026, 5, 15))).toBe(
      Date.UTC(2028, 1, 29),
    );
  });
});

describe('nextCalendarFireAfter — timezones and DST', () => {
  it('reads the hour on the named zone’s wall clock', () => {
    // 9:00 in Chicago during CDT (UTC-5) is 14:00Z.
    const nineChicago = calendar({hour: 9, tz: 'America/Chicago'});
    expect(nextCalendarFireAfter(nineChicago, Date.UTC(2026, 5, 1))).toBe(
      Date.UTC(2026, 5, 1, 14),
    );
  });

  /**
   * The skipped-time policy: on 2026-03-08 Chicago's clocks jump from 2:00 to
   * 3:00, so 2:30 never happens. The rule fires at the transition instant —
   * 2026-03-08T08:00Z, whose wall reading is 3:00 CDT — rather than drifting to
   * 3:30 or silently skipping the day.
   */
  it('fires a skipped wall time at the first valid instant', () => {
    const halfPastTwo = calendar({hour: 2, minute: 30, tz: 'America/Chicago'});
    expect(nextCalendarFireAfter(halfPastTwo, Date.UTC(2026, 2, 8, 6))).toBe(
      Date.UTC(2026, 2, 8, 8),
    );
  });

  /**
   * The repeated-time policy: on 2026-11-01 Chicago's clocks fall from 2:00 back
   * to 1:00, so 1:30 happens twice — at 06:30Z (CDT) and 07:30Z (CST). The rule
   * fires once, at the first occurrence, and the next fire is the next day.
   */
  it('fires a repeated wall time once, at its first occurrence', () => {
    const halfPastOne = calendar({hour: 1, minute: 30, tz: 'America/Chicago'});
    expect(nextCalendarFireAfter(halfPastOne, Date.UTC(2026, 10, 1))).toBe(
      Date.UTC(2026, 10, 1, 6, 30),
    );
    // Strictly after the first occurrence: not the 07:30Z repeat, but tomorrow —
    // now on CST, so 1:30 is 07:30Z a day later.
    expect(
      nextCalendarFireAfter(halfPastOne, Date.UTC(2026, 10, 1, 6, 30)),
    ).toBe(Date.UTC(2026, 10, 2, 7, 30));
  });
});

describe('previousCalendarFireAtOrBefore — the catch-up mirror', () => {
  it('finds the latest boundary at or before the instant, inclusively', () => {
    const nine = calendar({hour: 9});
    expect(
      previousCalendarFireAtOrBefore(nine, Date.UTC(2026, 5, 15, 10)),
    ).toBe(Date.UTC(2026, 5, 15, 9));
    expect(previousCalendarFireAtOrBefore(nine, Date.UTC(2026, 5, 15, 9))).toBe(
      Date.UTC(2026, 5, 15, 9),
    );
    expect(previousCalendarFireAtOrBefore(nine, Date.UTC(2026, 5, 15, 8))).toBe(
      Date.UTC(2026, 5, 14, 9),
    );
  });

  it('respects the timezone the same way the forward search does', () => {
    const nineChicago = calendar({hour: 9, tz: 'America/Chicago'});
    expect(
      previousCalendarFireAtOrBefore(nineChicago, Date.UTC(2026, 5, 2)),
    ).toBe(Date.UTC(2026, 5, 1, 14));
  });
});

describe('calendarSpecProblems', () => {
  it('accepts a well-formed spec', () => {
    expect(
      calendarSpecProblems(
        calendar({
          minute: [0, 30],
          hour: 9,
          dayOfWeek: [1, 2, 3, 4, 5],
          tz: 'America/Chicago',
        }),
      ),
    ).toEqual([]);
  });

  it('names every field out of range', () => {
    const problems = calendarSpecProblems(
      calendar({minute: 60, hour: [9, 25], month: 0}),
    );
    expect(problems.length).toBe(3);
    expect(problems.join('; ')).toMatch(/minute .* got 60/);
    expect(problems.join('; ')).toMatch(/hour .* got 25/);
    expect(problems.join('; ')).toMatch(/month .* got 0/);
  });

  it('rejects an empty list, which is a mistake wearing a wildcard’s clothes', () => {
    expect(calendarSpecProblems(calendar({hour: []}))[0]).toMatch(
      /hour must not be an empty list/,
    );
  });

  it('rejects a timezone name the platform does not know', () => {
    expect(
      calendarSpecProblems(calendar({tz: 'Mars/Olympus_Mons'}))[0],
    ).toMatch(/IANA timezone/);
  });

  it('rejects a dayOfMonth no listed month can contain', () => {
    expect(
      calendarSpecProblems(calendar({month: 2, dayOfMonth: 30}))[0],
    ).toMatch(/never occurs/);
    expect(
      calendarSpecProblems(calendar({month: [4, 6], dayOfMonth: 31}))[0],
    ).toMatch(/never occurs/);
    // Feb 29 is fine — leap years have one, and the arithmetic finds them.
    expect(calendarSpecProblems(calendar({month: 2, dayOfMonth: 29}))).toEqual(
      [],
    );
  });
});

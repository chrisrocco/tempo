/**
 * @fileoverview
 * Calendar boundary arithmetic: when does a wall-clock rule fire next, in a
 * timezone. This module owns everything DST touches, and the policy for it.
 *
 * ## The one representation everything here uses
 *
 * A "wall time" is a timezone's clock reading encoded as epoch milliseconds *as
 * if that reading were UTC* — `Date.UTC(year, month, day, hour, minute)` of what
 * the wall clock shows. It is not an instant; it is a name for a clock face. All
 * the field matching (day-of-week, month lengths, leap years) happens on wall
 * times with plain UTC date math, and only two functions cross between the two
 * spaces: `wallFromInstant` (via `Intl`) and `instantFromWall` (its inverse,
 * where the DST policy lives). Keeping the crossing to two functions is what
 * makes the rest of this file ordinary calendar code.
 *
 * ## The DST policy, decided here and nowhere else
 *
 * A wall time can fail to exist (spring forward skips it) or exist twice (fall
 * back repeats it). The policy:
 *
 * - **Skipped → the first valid instant**: a 2:30 rule on the night 2:00 jumps
 *   to 3:00 fires at the transition itself (wall 3:00), that day. Firing at the
 *   shifted reading (3:30) would drift the fire by however long the gap was, and
 *   skipping the day entirely would silently miss a boundary — the failure the
 *   scheduler's whole design exists to avoid.
 * - **Repeated → the first occurrence**: a 1:30 rule on the night clocks fall
 *   back fires once, at the earlier instant. Twice would be two runs for one
 *   nominal rule; the run's id would dedupe them anyway, so firing twice would
 *   only manufacture a spurious duplicate record.
 *
 * ## Timezone data comes from the platform
 *
 * `Intl.DateTimeFormat` with an IANA name — no bundled database, in a package
 * whose runtime dependency list is empty and enforced. This is the module the
 * layering map reserved for exactly that trade (`tools/boundaries.ts`: schedule/
 * "runs inside an activity, on the I/O side of the determinism boundary"), and
 * platform-dependence is acceptable for the same reason reading the clock is:
 * the computation runs in the `nextFire` activity, whose answer is recorded in
 * history, so replay reads the decision rather than re-deriving it.
 */

import type {CalendarSpec} from '../protocol';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * How many wall days a search walks before concluding no boundary exists.
 *
 * Nine years, not "a while": the rarest legitimate spec is `Feb 29`, and
 * across a skipped century leap year (1900, 2100) consecutive leap years are
 * eight years apart. Anything that matches no day in nine years matches no day
 * ever — `calendarSpecProblems` rejects the statically-detectable cases, and
 * this bound is the backstop that turns the rest into "exhausted" instead of a
 * spin.
 */
const HORIZON_DAYS = 366 * 9;

/** The longest plausible distance between a wall time and its instant, padded. */
const MAX_OFFSET_MS = DAY_MS;

/** A spec's fields, defaulted and normalized: sorted, deduplicated lists. */
interface CalendarFields {
  minutes: number[];
  hours: number[];
  /** undefined = every day / every month / every weekday. */
  days: number[] | undefined;
  months: number[] | undefined;
  dows: number[] | undefined;
  tz: string;
}

function listed(field: number | number[] | undefined): number[] | undefined {
  if (field === undefined) return undefined;
  const values = Array.isArray(field) ? field : [field];
  return [...new Set(values)].sort((a, b) => a - b);
}

function fieldsOf(spec: CalendarSpec): CalendarFields {
  return {
    minutes: listed(spec.minute) ?? [0],
    hours: listed(spec.hour) ?? [0],
    days: listed(spec.dayOfMonth),
    months: listed(spec.month),
    dows: listed(spec.dayOfWeek),
    tz: spec.tz ?? 'UTC',
  };
}

/**
 * One formatter per zone, cached: `Intl.DateTimeFormat` construction loads
 * locale data and is by far the expensive step, while `formatToParts` is cheap.
 * The cache also makes `formatterFor` the validation point — an unknown zone
 * name throws here, before anything is computed from it.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = formatters.get(tz);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      // 'h23', not hour12:false — the latter yields hour "24" at midnight in
      // some ICU versions, which Date.UTC would happily roll into the next day.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, formatter);
  }
  return formatter;
}

/** The instant's wall-clock reading in `tz`, encoded as a wall time. */
function wallFromInstant(instantMs: number, tz: string): number {
  const parts = formatterFor(tz).formatToParts(instantMs);
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  return Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
}

/**
 * The instant whose wall clock in `tz` reads `wallMs`, under the DST policy in
 * the fileoverview: the first occurrence of a repeated time, the transition
 * itself for a skipped one.
 *
 * The mechanism: a zone's offset is `wall - instant`, so sampling the offset a
 * day before and a day after the target yields every offset that could apply —
 * two distinct values only when a transition sits within a day of the target.
 * Each offset proposes one candidate instant; a candidate is real if its wall
 * clock reads back as the target. Both real = repeated time (take the earlier);
 * one real = the ordinary case; neither = the target is inside a gap, and the
 * answer is the transition instant, found by binary search since no arithmetic
 * names it directly.
 */
function instantFromWall(wallMs: number, tz: string): number {
  const offsetNear = (instantMs: number): number =>
    wallFromInstant(instantMs, tz) - instantMs;
  const candidates = [
    ...new Set([
      wallMs - offsetNear(wallMs - MAX_OFFSET_MS),
      wallMs - offsetNear(wallMs + MAX_OFFSET_MS),
    ]),
  ]
    .filter((instant) => wallFromInstant(instant, tz) === wallMs)
    .sort((a, b) => a - b);
  if (candidates.length > 0) return candidates[0]!;

  // Inside a spring-forward gap. The transition is the first instant whose wall
  // clock is at or past the target; within the two-day bracket there is exactly
  // one transition, so the predicate is monotone and binary search is sound.
  // Minute-aligned, which every modern transition is and every spec here is.
  let lo = Math.floor((wallMs - MAX_OFFSET_MS) / MINUTE_MS);
  let hi = Math.ceil((wallMs + MAX_OFFSET_MS) / MINUTE_MS);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (wallFromInstant(mid * MINUTE_MS, tz) >= wallMs) hi = mid;
    else lo = mid + 1;
  }
  return lo * MINUTE_MS;
}

/** Does this wall day (given as its midnight wall time) satisfy the date fields? */
function dayMatches(dayStartWallMs: number, fields: CalendarFields): boolean {
  // Plain UTC date math on the wall encoding — leap years and month lengths for
  // free, and no zone in sight because the encoding already is the wall clock.
  const date = new Date(dayStartWallMs);
  if (
    fields.months !== undefined &&
    !fields.months.includes(date.getUTCMonth() + 1)
  )
    return false;
  if (fields.days !== undefined && !fields.days.includes(date.getUTCDate()))
    return false;
  if (fields.dows !== undefined && !fields.dows.includes(date.getUTCDay()))
    return false;
  return true;
}

/**
 * The first instant strictly after `afterMs` where the spec's fields all match,
 * or undefined if no wall day within the horizon matches — which, given the
 * horizon's size, means no day ever will.
 *
 * Wall times are enumerated in ascending order, and the map from wall time to
 * instant is monotone (the first-occurrence policy keeps it so through a fall
 * back; a gap maps a whole range of wall times to one transition instant), so
 * the first candidate past `afterMs` is the minimum. The scan starts one day
 * early because around a fall-back transition a wall time *earlier* than
 * `afterMs`'s own reading can still map to a later instant.
 */
export function nextCalendarFireAfter(
  spec: CalendarSpec,
  afterMs: number,
): number | undefined {
  const fields = fieldsOf(spec);
  let dayStart =
    Math.floor(wallFromInstant(afterMs, fields.tz) / DAY_MS) * DAY_MS - DAY_MS;
  for (let i = 0; i < HORIZON_DAYS; i++, dayStart += DAY_MS) {
    if (!dayMatches(dayStart, fields)) continue;
    for (const hour of fields.hours)
      for (const minute of fields.minutes) {
        const instant = instantFromWall(
          dayStart + hour * HOUR_MS + minute * MINUTE_MS,
          fields.tz,
        );
        if (instant > afterMs) return instant;
      }
  }
  return undefined;
}

/**
 * The latest matching instant at or before `atMs`, or undefined if none within
 * the horizon. The mirror of `nextCalendarFireAfter`, and it exists for the
 * catch-up clamp: "never look back further than one period" needs a calendar
 * spec's answer to "when was the period before now", which unlike an interval's
 * is not `now - everyMs`.
 */
export function previousCalendarFireAtOrBefore(
  spec: CalendarSpec,
  atMs: number,
): number | undefined {
  const fields = fieldsOf(spec);
  let dayStart =
    Math.floor(wallFromInstant(atMs, fields.tz) / DAY_MS) * DAY_MS + DAY_MS;
  for (let i = 0; i < HORIZON_DAYS; i++, dayStart -= DAY_MS) {
    if (!dayMatches(dayStart, fields)) continue;
    for (const hour of [...fields.hours].reverse())
      for (const minute of [...fields.minutes].reverse()) {
        const instant = instantFromWall(
          dayStart + hour * HOUR_MS + minute * MINUTE_MS,
          fields.tz,
        );
        if (instant <= atMs) return instant;
      }
  }
  return undefined;
}

/** February says 29: a day is *possible* if any year has it, and leap years do. */
const DAYS_IN_MONTH: readonly number[] = [
  0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
];

const FIELD_RANGES = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['dayOfMonth', 1, 31],
  ['month', 1, 12],
  ['dayOfWeek', 0, 6],
] as const;

/**
 * Everything wrong with a calendar spec, as sentences — same contract as
 * `scheduleSpecProblems`, which dispatches here. Range checks per field, the
 * zone name (validated by handing it to `Intl`, the same authority that will
 * interpret it later), and the one cross-field impossibility that is statically
 * decidable: a day of month no listed month is long enough to contain.
 */
export function calendarSpecProblems(spec: CalendarSpec): string[] {
  const problems: string[] = [];

  for (const [name, min, max] of FIELD_RANGES) {
    const raw = spec[name];
    if (raw === undefined) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0) {
      problems.push(
        `${name} must not be an empty list — omit the field to mean "every ${name}"`,
      );
      continue;
    }
    for (const value of values)
      if (!Number.isSafeInteger(value) || value < min || value > max)
        problems.push(
          `${name} must be an integer in ${min}-${max}, got ${value}`,
        );
  }

  if (spec.tz !== undefined) {
    try {
      formatterFor(spec.tz);
    } catch {
      problems.push(
        `tz must be an IANA timezone name (e.g. "America/Chicago"), got "${spec.tz}"`,
      );
    }
  }

  if (problems.length === 0) {
    const days = listed(spec.dayOfMonth);
    const months =
      listed(spec.month) ?? DAYS_IN_MONTH.map((_, i) => i).slice(1);
    if (
      days !== undefined &&
      !months.some((month) => days.some((day) => day <= DAYS_IN_MONTH[month]!))
    )
      problems.push(
        `dayOfMonth [${days.join(', ')}] never occurs in month [${months.join(', ')}] — this spec can never fire`,
      );
  }

  return problems;
}

/**
 * @fileoverview
 * When does this fire next: the arithmetic, as pure functions.
 *
 * ## Why `after` is a parameter and not `Date.now()`
 *
 * This layer never reads a clock. Every function here is a function of the spec and
 * an instant handed in, which buys three things at once:
 *
 * - it is testable by writing the instant down, rather than by waiting;
 * - the *caller* decides which instant matters, and for a scheduler the two are
 *   genuinely different: sleeping needs "now", while catching up after an outage
 *   needs "the boundary after the last one we fired";
 * - the clock read stays in one place, `nextFire` below, which is the activity. That
 *   is the only line here on the I/O side of the determinism boundary, and keeping it
 *   to one line is what makes the rest of this file safe to reason about.
 *
 * ## What it does not do yet
 *
 * No calendar specs, no timezones, no jitter, no backfill over a range. Interval only
 * (issue #69). Jitter in particular must be **seeded** when it arrives — Temporal
 * seeds from the schedule id precisely so the value survives a replay — so it will
 * take the seed as an argument like everything else here.
 */

import type {ScheduleBounds, ScheduleSpec} from '../protocol';

/**
 * The next boundary strictly after `afterMs`, or `undefined` when the schedule is
 * exhausted.
 *
 * **Strictly after**, which is the property the scheduler loop depends on. Having
 * fired at boundary `T`, it asks again with `T` — and must be told `T + everyMs`. An
 * inclusive answer would hand back `T`, and the loop would fire the same nominal time
 * forever without ever advancing.
 *
 * `undefined` means *there is no next fire ever*, not "not yet": it is how a scheduler
 * learns it may complete rather than sleep. Only `notAfterMs` produces it.
 */
export function nextFireAfter(
  spec: ScheduleSpec,
  afterMs: number,
  bounds: ScheduleBounds = {},
): number | undefined {
  const problems = scheduleSpecProblems(spec, bounds);
  if (problems.length > 0)
    throw new Error(`invalid schedule spec: ${problems.join('; ')}`);

  // A `notBeforeMs` in the future moves the question rather than filtering the
  // answer: the first fire is the first boundary at or after it, so searching from
  // the later of the two instants gets there in one step instead of walking
  // boundaries that were never candidates. `- 1` keeps the bound *inclusive* while
  // the search stays exclusive.
  const from = Math.max(afterMs, (bounds.notBeforeMs ?? -Infinity) - 1);

  const next = nextIntervalBoundaryAfter(spec, from);
  if (bounds.notAfterMs !== undefined && next >= bounds.notAfterMs)
    return undefined;
  return next;
}

/**
 * The next epoch-aligned boundary strictly after `afterMs`.
 *
 * `Math.floor` rather than a remainder, because a remainder in JavaScript takes the
 * sign of the dividend: for an instant before the offset — pre-1970, or a large
 * offset — `%` yields a negative and the boundary lands in the past. `floor` divides
 * the number line into periods the same way on both sides of zero.
 */
function nextIntervalBoundaryAfter(
  spec: ScheduleSpec,
  afterMs: number,
): number {
  const {everyMs} = spec;
  const offsetMs = spec.offsetMs ?? 0;
  const periodsElapsed = Math.floor((afterMs - offsetMs) / everyMs);
  return offsetMs + (periodsElapsed + 1) * everyMs;
}

/**
 * Everything wrong with a spec, as sentences.
 *
 * A list rather than a throw, and rather than a boolean, because the caller that
 * needs this most is `createSchedule` reporting to whoever typed the spec — one
 * round trip should name every problem, not the first. `nextFireAfter` throws on
 * the same list, so an invalid spec cannot reach the arithmetic by a path that
 * skipped validation.
 */
export function scheduleSpecProblems(
  spec: ScheduleSpec,
  bounds: ScheduleBounds = {},
): string[] {
  const problems: string[] = [];
  const {everyMs} = spec;
  const offsetMs = spec.offsetMs ?? 0;

  if (!Number.isSafeInteger(everyMs) || everyMs <= 0)
    problems.push(`everyMs must be a positive integer, got ${everyMs}`);
  if (!Number.isSafeInteger(offsetMs) || offsetMs < 0)
    problems.push(`offsetMs must be a non-negative integer, got ${offsetMs}`);
  // Checked only when the period is itself valid, so a bad `everyMs` reports once
  // rather than dragging the offset into a complaint that is really about it.
  else if (Number.isSafeInteger(everyMs) && everyMs > 0 && offsetMs >= everyMs)
    problems.push(
      `offsetMs must be less than everyMs (${offsetMs} >= ${everyMs}) — an offset of a whole period or more is a units slip, not a schedule`,
    );

  for (const [name, value] of [
    ['notBeforeMs', bounds.notBeforeMs],
    ['notAfterMs', bounds.notAfterMs],
  ] as const)
    if (value !== undefined && !Number.isSafeInteger(value))
      problems.push(`${name} must be an integer, got ${value}`);

  const {notBeforeMs, notAfterMs} = bounds;
  if (
    notBeforeMs !== undefined &&
    notAfterMs !== undefined &&
    notAfterMs <= notBeforeMs
  )
    problems.push(
      `notAfterMs must be after notBeforeMs (${notAfterMs} <= ${notBeforeMs}) — this schedule can never fire`,
    );

  return problems;
}

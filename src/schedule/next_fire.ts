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
 * ## Two spec types, one seam each
 *
 * This file dispatches on `spec.type` and owns the interval arithmetic itself;
 * everything a calendar needs — wall clocks, timezones, DST policy — is the
 * `timespec/` library's, reached only through the seam documented at the import
 * below, behind the same three questions every spec type must answer:
 * the next boundary strictly after an instant, the latest boundary at or before
 * one (`lookbackFloorMs`, the catch-up clamp), and what is wrong with the spec.
 * A third spec type is those three functions and a union member, nothing more.
 *
 * ## What it does not do yet
 *
 * No cron-string sugar, no jitter, no backfill over a range (issue #69). Jitter in
 * particular must be **seeded** when it arrives — Temporal seeds from the schedule
 * id precisely so the value survives a replay — so it will take the seed as an
 * argument like everything else here.
 */

import type {IntervalSpec, ScheduleBounds, ScheduleSpec} from '../protocol';
// The one seam between the engine and the `timespec/` library (see its
// index.ts): a `CalendarSpec` minus its `type` tag *is* a `WallClockRule`, and
// the compiler checks that structural claim at every call below — if the
// library's rule shape ever drifts from the protocol's spec shape, these lines
// stop compiling rather than quietly reinterpreting a field. Swapping the
// library out, or deleting calendar support, happens here and in the union
// member, nowhere else.
//
// Calling it from this file is also what makes the library's platform-read
// timezone data safe: everything here runs inside the `nextFire` activity,
// whose answer is recorded in history, so replay reads the decision rather
// than re-deriving it against newer tzdata.
import {
  nextOccurrenceAfter,
  previousOccurrenceAtOrBefore,
  wallClockRuleProblems,
} from '../timespec';

/** Exhaustiveness backstop for `spec.type` switches — see AGENTS.md. */
function assertNever(spec: never): never {
  throw new Error(`unknown schedule spec: ${JSON.stringify(spec)}`);
}

/**
 * The next boundary strictly after `afterMs`, or `undefined` when the schedule is
 * exhausted.
 *
 * **Strictly after**, which is the property the scheduler loop depends on. Having
 * fired at boundary `T`, it asks again with `T` — and must be told the boundary
 * after `T`. An inclusive answer would hand back `T`, and the loop would fire the
 * same nominal time forever without ever advancing.
 *
 * `undefined` means *there is no next fire ever*, not "not yet": it is how a
 * scheduler learns it may complete rather than sleep. `notAfterMs` produces it,
 * and so does a calendar spec matching no day within its nine-year search
 * horizon — validation rejects the statically impossible ones, and the horizon
 * turns whatever slips past into a completed schedule rather than a spin.
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

  const next = nextBoundaryAfter(spec, from);
  if (next === undefined) return undefined;
  if (bounds.notAfterMs !== undefined && next >= bounds.notAfterMs)
    return undefined;
  return next;
}

function nextBoundaryAfter(
  spec: ScheduleSpec,
  afterMs: number,
): number | undefined {
  switch (spec.type) {
    case 'interval':
      return nextIntervalBoundaryAfter(spec, afterMs);
    case 'calendar':
      return nextOccurrenceAfter(spec, afterMs);
    default:
      return assertNever(spec);
  }
}

/**
 * The floor of the catch-up window: how far back a scheduler resuming at `nowMs`
 * may reach for a missed boundary — the policy `nextFire` (the activity) states
 * as "never look back further than one period", generalized to spec types that
 * have no fixed period.
 *
 * For both types the meaning is the same: `nextFireAfter` asked from this floor
 * yields the most recent boundary at or before `nowMs` if there is one, so an
 * outage's backlog collapses to exactly one fire. An interval names it by
 * arithmetic; a calendar has to go and find it. A calendar with no boundary in
 * the whole lookback horizon floors at `nowMs` itself — nothing recent was
 * missed, so the search may go straight to the future.
 */
export function lookbackFloorMs(spec: ScheduleSpec, nowMs: number): number {
  switch (spec.type) {
    case 'interval':
      return nowMs - spec.everyMs;
    case 'calendar': {
      const previous = previousOccurrenceAtOrBefore(spec, nowMs);
      // `- 1` for the same reason `notBeforeMs` gets one above: the boundary
      // itself must stay reachable by a strictly-after search.
      return previous === undefined ? nowMs : previous - 1;
    }
    default:
      return assertNever(spec);
  }
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
  spec: IntervalSpec,
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
  const problems = specProblems(spec);

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

function specProblems(spec: ScheduleSpec): string[] {
  switch (spec.type) {
    case 'interval':
      return intervalSpecProblems(spec);
    case 'calendar':
      return wallClockRuleProblems(spec);
    default:
      return assertNever(spec);
  }
}

function intervalSpecProblems(spec: IntervalSpec): string[] {
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

  return problems;
}

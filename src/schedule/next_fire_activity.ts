/**
 * @fileoverview
 * `nextFire`: the activity a scheduler workflow asks when to wake up.
 *
 * ## Why this is an activity at all
 *
 * Not for the arithmetic — that is pure and lives next door in `next_fire.ts`. It is
 * an activity for the clock. A scheduler has to sleep for a *duration*, and a duration
 * is `boundary - now`; workflow code cannot read `now`, correctly, and nothing on the
 * author surface offers it.
 *
 * Two things fall out of putting it here, and the second is the one that matters:
 *
 * 1. No new engine primitive is needed. A deterministic clock on the author surface
 *    would be a `protocol/` change, and the roadmap makes those deliberate.
 * 2. **The answer is frozen in history.** An activity's result is recorded, so replay
 *    reads the decision rather than recomputing it. Editing this file — or the
 *    calendar rules it will eventually grow — therefore cannot diverge a schedule that
 *    is already running, which is the same protection Temporal buys with `SideEffect`
 *    and matters far more here, because a schedule is the longest-lived execution the
 *    system has.
 *
 * ## Why it returns a delay *and* the nominal time
 *
 * The delay is what gets slept. The nominal time is what the run is *named after* —
 * the fired execution's id is built from it, which is what makes a repeated fire
 * idempotent at the server rather than merely unlikely. They are computed together
 * because computing them apart means two clock reads and a window in between where
 * the delay no longer matches the boundary it was derived from.
 */

import type {ScheduleBounds, ScheduleSpec} from '../protocol';
import {lookbackFloorMs, nextFireAfter} from './next_fire';

/** What a scheduler needs in order to sleep until its next fire. */
export interface NextFire {
  /**
   * The boundary this fire belongs to, in epoch ms. Stable across retries of this
   * activity, because it is a property of the spec and not of when it was asked.
   */
  nominalTimeMs: number;
  /**
   * How long to sleep, in milliseconds. **Never negative** — a boundary already in
   * the past yields `0`, meaning "fire now".
   *
   * Clamped rather than reported as negative because the caller's only use for it is
   * `sleep`, and a negative there is a question with no good answer. A past-due
   * boundary is the normal state after an outage or a slow run, not an error: the
   * nominal time is still the boundary that was missed, so the fired execution keeps
   * the id it would have had.
   */
  delayMs: number;
}

/** The schedule has no next fire and never will — see `nextFireAfter`. */
export interface ScheduleExhausted {
  exhausted: true;
}

/**
 * When should the scheduler next wake, given that it has already handled everything
 * up to and including `afterMs`?
 *
 * `afterMs` is the caller's high-water mark, not "now", and the difference is what
 * makes catching up possible: a scheduler resuming after an outage passes the last
 * boundary it fired and walks forward from there, rather than skipping to the present
 * and losing the gap.
 *
 * Reads the clock exactly once. Everything else here is pure.
 */
export function nextFire(
  spec: ScheduleSpec,
  afterMs: number | undefined,
  bounds: ScheduleBounds = {},
): NextFire | ScheduleExhausted {
  // The one clock read in this layer.
  const now = Date.now();

  // **The catch-up policy.** Two cases, and collapsing them into one is wrong in both
  // directions — the first draft did, and the specs caught it twice.
  //
  // *Nothing handled yet* — a schedule that has never fired. Search from **now**. Its
  // first run is the next future boundary, because a boundary that passed before the
  // schedule existed was not missed, it was never owed. Anchoring to the epoch instead
  // would have the first cycle walk every boundary since 1970: for a 40ms interval,
  // some forty billion of them, firing flat out and starving the queue. Measured, not
  // theorised. Someone who genuinely wants a backdated start says so with
  // `notBeforeMs`.
  //
  // *A high-water mark exists* — search from it, but never look back further than one
  // period. So an outage's backlog collapses to **one** fire: a nightly job that missed
  // three nights runs once, now, and is then back on schedule. That is the right
  // default for automation and the wrong one for accounting, which is what backfill
  // over an explicit range is for (#69) — a deliberate request rather than an accident
  // of downtime. "One period" is `lookbackFloorMs`'s to define, because a calendar
  // spec has no fixed period the way an interval does — see its comment.
  const from =
    afterMs === undefined ? now : Math.max(afterMs, lookbackFloorMs(spec, now));

  const nominalTimeMs = nextFireAfter(spec, from, bounds);
  if (nominalTimeMs === undefined) return {exhausted: true};

  return {nominalTimeMs, delayMs: Math.max(0, nominalTimeMs - now)};
}

/** Narrow the result of `nextFire`. Exported because a scheduler branches on it every cycle. */
export function isExhausted(
  result: NextFire | ScheduleExhausted,
): result is ScheduleExhausted {
  return 'exhausted' in result;
}

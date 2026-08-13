/**
 * @fileoverview
 * What a schedule fires on: the spec, as data.
 *
 * In `protocol/` rather than beside the arithmetic that reads it, because these types
 * cross every seam a schedule has — the RPCs that create and describe one, the
 * activity that computes the next boundary, and a dashboard in another repository
 * reading `workflow-engine/protocol`. `schedule/` holds the functions; this holds the
 * vocabulary they agree on.
 *
 * ## Boundaries are absolute, not relative to creation
 *
 * An interval fires where `epoch-ms ≡ offsetMs (mod everyMs)`, which is Temporal's
 * rule and is worth being explicit about because the obvious alternative — "every
 * hour, counting from when you asked" — is worse in a way that only shows up later.
 *
 * Anchored to the epoch, "every hour at :15" is one spec that means the same thing
 * whenever it was created, whatever restarted in between, and on every machine. It
 * also cannot drift: each fire is computed from the boundary, never from "the last
 * fire plus an hour", so a slow run does not push the next one later. Drift is the
 * failure this design exists to prevent, since it compounds — a 30-second job on a
 * five-minute relative interval loses roughly ten percent of its fires a day.
 *
 * ## UTC only, deliberately, for now
 *
 * There is no timezone field, and adding one is not a small change: Temporal rewrote
 * its next-time computation three times over DST, where a nominal time can be
 * skipped, repeated, or ambiguous. An interval in absolute milliseconds has no such
 * problem — it is not a wall-clock rule and does not need a calendar. Calendar specs
 * with timezones come later (issue #69), and they belong in `schedule/` where a
 * timezone database is an allowed dependency.
 */

/**
 * Fire every `everyMs`, on boundaries aligned to the epoch.
 *
 * `{everyMs: 3_600_000, offsetMs: 900_000}` is "every hour at :15".
 */
export interface IntervalSpec {
  type: 'interval';
  /** One period, in milliseconds. Must be a positive integer. */
  everyMs: number;
  /**
   * Where the boundary sits inside the period, in milliseconds. Defaults to 0.
   *
   * Required to be `0 <= offsetMs < everyMs` rather than normalised by remainder. An
   * offset of a whole period or more is arithmetically harmless and almost always a
   * mistake — a units slip, usually — and quietly folding it away would turn a
   * question into a silently different schedule.
   */
  offsetMs?: number;
}

/**
 * When a schedule fires.
 *
 * A union of one, which is not an accident: the next member is a calendar spec, and
 * `type` is already the discriminant that makes adding it non-breaking for anything
 * that switches on it.
 */
export type ScheduleSpec = IntervalSpec;

/**
 * Absolute bounds on a spec's lifetime, in epoch milliseconds.
 *
 * Separate from the spec rather than fields on it, because they answer a different
 * question — *whether* to fire at all, not *when* — and every future spec type needs
 * them identically. Keeping them out here means a calendar spec inherits them for
 * free.
 */
export interface ScheduleBounds {
  /** No fire before this instant. A boundary exactly here is allowed. */
  notBeforeMs?: number;
  /**
   * No fire at or after this instant, at which point the schedule is exhausted and
   * has no next fire — which is how a scheduler learns it may stop rather than
   * sleeping forever.
   *
   * Exclusive, so `notAfterMs` can be set to a boundary without that boundary firing.
   * An inclusive bound would make "run until midnight" ambiguous about midnight
   * itself.
   */
  notAfterMs?: number;
}

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

export interface ScheduleTarget {
  /** Workflow type to start. */
  name: string;
  /** The one props object each firing starts it with. */
  props?: unknown;
  /**
   * Which pool runs the work. Defaults to `DEFAULT_TASK_QUEUE` — the same default a
   * client `start` gets, so a schedule lands where an unqualified execution lands.
   *
   * Filled in by `ScheduleClient.create` rather than left for the engine to resolve, and
   * the difference matters: an undefined queue reaching the server means "inherit the
   * starter's queue", which for a schedule is wherever the *scheduler* happens to be
   * registered. That is right by colocation rather than by statement, and it changes
   * meaning silently if schedulers are ever moved to their own pool. Normalising at
   * creation means the stored definition names the queue, so `describe` answers "where
   * do this schedule's runs go" without anyone having to know that rule.
   */
  taskQueue?: string;
}

/**
 * A schedule's definition: everything that is a *decision*, as opposed to a record of
 * what has happened.
 *
 * Travels in the workflow's args rather than in carryover, so `describeExecution`
 * reports it as `args` — the definition and the status read as two different things to
 * anything rendering them, which is what a dashboard wants. An update signal replaces
 * it, and the replacement is carried forward by the next rollover.
 */
export interface ScheduleDefinition {
  spec: ScheduleSpec;
  bounds?: ScheduleBounds;
  target: ScheduleTarget;
  /** Start life paused, so a schedule can be created before it should run. */
  paused?: boolean;
}

/** One thing the schedule did, as the status keeps it. */
export interface ScheduleRunRecord {
  /** The boundary this run belongs to, or the trigger's ordinal for a manual one. */
  nominalTimeMs: number;
  /** The execution the fire claimed. */
  targetId: string;
  /** True when a person asked for it rather than the spec. */
  manual?: boolean;
}

/**
 * A schedule's status: what has happened, as opposed to what should.
 *
 * In carryover because that is where this repo puts state a reader will ask about —
 * `ExecutionDetail.carryover` exists so that "state that decides whether an item gets
 * processed" is legible to whoever is asking why it was not.
 */
export interface ScheduleStatus {
  /**
   * Boundaries up to and including this instant have been handled.
   *
   * **Absent means none have**, which is a different question from "the epoch has",
   * and `nextFire` treats it as one: a schedule that has never fired searches from
   * now, so a boundary that passed before it existed was never owed. Once it is set,
   * it is the high-water mark a catch-up walks forward from.
   */
  handledThroughMs?: number;
  paused: boolean;
  /** Most recent first. Bounded — see `RECENT_LIMIT`. */
  recent: ScheduleRunRecord[];
  /** How many manual triggers have fired, which is what makes their ids unique. */
  triggerCount: number;
  /**
   * Why the last cycle failed, if it did.
   *
   * The single most useful field here for the job this serves: a nightly task that
   * has been broken for a week should say so where someone is already looking,
   * instead of being visible only as an absence of runs.
   */
  lastError?: string;
}

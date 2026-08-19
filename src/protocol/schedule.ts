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
 * ## Where the wall clock lives
 *
 * Interval specs carry no timezone, deliberately: absolute milliseconds are not a
 * wall-clock rule and do not need a calendar. Wall-clock rules are `CalendarSpec`,
 * whose `tz` names an IANA zone — and everything hard about that (DST, where a
 * nominal time can be skipped, repeated, or ambiguous) lives in the `walltime/`
 * library, reached only through the seam in `schedule/next_fire.ts`, along with
 * the policy for it. This file holds only the vocabulary.
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
 * Fire at wall-clock times: "every weekday at 9am, Chicago time".
 *
 * A boundary is any minute where **all** specified fields match — Temporal's
 * semantics, not cron's: a spec with both `dayOfMonth` and `dayOfWeek` fires only
 * on days satisfying *both*, where cron would take the union. Minute granularity,
 * deliberately: the scheduler rolls over once per fire, which its own comment
 * calls wrong at seconds-scale, so a seconds field would be an invitation to
 * misuse it.
 *
 * This type deliberately mirrors `walltime/`'s `WallClockRule`, plus the union
 * tag — declared twice on purpose. The protocol owns its wire vocabulary and may
 * not import a library the repo treats as removable; the compiler holds the two
 * shapes together at the seam in `schedule/next_fire.ts`, where a `CalendarSpec`
 * is passed as a rule. The arithmetic — including what happens when DST skips or
 * repeats a wall time — is the library's, along with the policy and its
 * rationale (`walltime/wall_clock.ts`).
 */
export interface CalendarSpec {
  type: 'calendar';
  /** Minute(s) of the hour, 0–59. Defaults to 0. */
  minute?: number | number[];
  /**
   * Hour(s) of the day, 0–23, on the wall clock of `tz`. Defaults to 0 — so a
   * bare `{type: 'calendar'}` is "daily at midnight UTC".
   */
  hour?: number | number[];
  /** Day(s) of the month, 1–31. Defaults to every day. */
  dayOfMonth?: number | number[];
  /** Month(s), 1–12. Defaults to every month. */
  month?: number | number[];
  /** Day(s) of the week, 0–6 with 0 = Sunday. Defaults to every day. */
  dayOfWeek?: number | number[];
  /**
   * IANA timezone name (`'America/Chicago'`). Defaults to `'UTC'`. Validated at
   * creation; resolved against the platform's timezone data each time a boundary
   * is computed, which is the right side of the determinism boundary because the
   * computation happens in an activity and its answer is recorded — see the seam
   * comment in `schedule/next_fire.ts`.
   */
  tz?: string;
}

/** When a schedule fires. `type` is the discriminant every consumer switches on. */
export type ScheduleSpec = IntervalSpec | CalendarSpec;

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

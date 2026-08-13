/**
 * @fileoverview
 * The scheduler: a workflow whose whole job is starting other workflows on time.
 *
 * A schedule **is** an execution. Its id is the schedule's id, its args are the
 * schedule's definition, and its carryover is the schedule's status — so creating a
 * schedule is starting this workflow, pausing one is signalling it, and describing one
 * is `describeExecution` on it. Nothing new had to become durable to make schedules
 * durable, which is the argument for the shape: a durable stateful loop with timers,
 * restart recovery, and at-least-once effects is what this engine already is, and
 * building a second one beside it would have been rebuilding the engine outside its
 * own testing.
 *
 * ## One cycle per run, and why that is not laziness
 *
 * The body handles exactly one fire and then continues as new. Three things force it,
 * and the first is the one that would otherwise bite silently:
 *
 * 1. **Carryover reads are per run.** `setCarryover` takes effect at the *next*
 *    rollover, and `describeExecution` reports the carryover a run *started* with. A
 *    loop doing many cycles per run would therefore show a dashboard state frozen at
 *    whenever the run began — the status would lag arbitrarily behind the schedule.
 *    Rolling over each cycle makes carryover continuously current.
 * 2. **A thin body is the versioning mitigation.** `continueAsNew` empties history, so
 *    a rollover per fire means new code is adopted at the very next fire: the window
 *    in which changing this file could diverge a live schedule is one cycle rather
 *    than the months a schedule lives. That is a stronger protection than `patched`
 *    provides, and it is free.
 * 3. **Signals leave a timer behind.** Waking early because someone paused or
 *    triggered leaves the sleep still outstanding. A rollover discards it; a loop
 *    would have to reason about it.
 *
 * The cost is one rollover per fire, which is nothing for the daily and hourly jobs
 * this is for and would be real at seconds-scale. Revisit it there, not before.
 *
 * ## What decides, and where
 *
 * Every decision that needs a clock or a calendar is in the `nextFire` activity, and
 * its answer is recorded in history — so replay reads the decision rather than
 * recomputing it, and editing the boundary rules cannot diverge a schedule already
 * running. This file therefore contains no arithmetic at all, which is deliberate:
 * the code most likely to change is the code that is least safe to change here.
 */

import type {ScheduleBounds, ScheduleSpec} from '../protocol';
import type {NextFire, ScheduleExhausted} from './next_fire_activity';
import * as scheduleActivities from './activities';
import {
  background,
  condition,
  continueAsNew,
  defineSignal,
  getCarryover,
  proxyActivities,
  setCarryover,
  setHandler,
  sleep,
  startWorkflow,
  workflowInfo,
} from '../workflow';

const act = proxyActivities(scheduleActivities, {
  // Boundary arithmetic is pure and local; a failure here is a bug or a bad spec, and
  // neither improves by being retried. The scheduler is better off failing loudly than
  // sitting in a retry loop while its fires are missed.
  retry: {maximumAttempts: 1},
});

/** What the schedule fires, once its boundary arrives. */
export interface ScheduleTarget {
  /** Workflow type to start. */
  name: string;
  args?: unknown[];
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

const STATUS_KEY = 'schedule';

/**
 * How many past runs the status keeps.
 *
 * Bounded because carryover is capped at `MAX_CARRYOVER_BYTES` (16 KiB) and the worker
 * *refuses* a run whose carryover exceeds it — an append-only list would therefore not
 * grow slowly worse, it would eventually stop the schedule dead. Twenty is far enough
 * back to answer "did last night's run happen" and small enough to leave the budget
 * mostly unspent.
 */
const RECENT_LIMIT = 20;

export const pauseSchedule = defineSignal('pauseSchedule');
export const resumeSchedule = defineSignal('resumeSchedule');
export const triggerSchedule = defineSignal('triggerSchedule');
export const updateSchedule = defineSignal('updateSchedule');

/** The initial status of a schedule nobody has run yet. */
function initialStatus(definition: ScheduleDefinition): ScheduleStatus {
  return {
    // No `handledThroughMs`: nothing has been handled, which is what makes the first
    // fire the next *future* boundary rather than a catch-up for prehistory.
    paused: definition.paused ?? false,
    recent: [],
    triggerCount: 0,
  };
}

/**
 * Run one cycle of a schedule, then roll over into the next.
 *
 * Returns only when the schedule is finished — its bounds are exhausted — because a
 * schedule that has no next fire should be a completed execution rather than one
 * asleep forever. An operator can tell those apart; a sleeping one looks identical to
 * a broken one.
 */
export async function scheduler(
  definition: ScheduleDefinition,
): Promise<string> {
  const scheduleId = workflowInfo().workflowId;
  const status =
    getCarryover<ScheduleStatus>(STATUS_KEY) ?? initialStatus(definition);

  // Local mutable copies. Signals mutate these; nothing here reads carryover again,
  // because a carryover read would return what the run started with either way.
  let paused = status.paused;
  let triggers = 0;
  let updated: ScheduleDefinition | undefined;

  setHandler(pauseSchedule, () => {
    paused = true;
  });
  setHandler(resumeSchedule, () => {
    paused = false;
  });
  setHandler(triggerSchedule, () => {
    triggers += 1;
  });
  setHandler(updateSchedule, (next: ScheduleDefinition) => {
    updated = next;
  });

  // Waiting has two shapes, and both end in the same place — a paused schedule must
  // still honour a trigger, so this cannot return early. Doing so was a real bug: it
  // consumed the trigger while rolling over and fired nothing, so "run it now" on a
  // paused schedule did nothing, forever.
  let boundary: NextFire | undefined;
  let slept = false;

  if (paused) {
    // No timer at all, which is the point: a pause should cost nothing and last
    // indefinitely rather than waking to re-check.
    await condition(() => !paused || triggers > 0 || updated !== undefined);
  } else {
    const next: NextFire | ScheduleExhausted = await act.nextFire(
      definition.spec,
      status.handledThroughMs,
      definition.bounds ?? {},
    );

    // Inlined rather than calling `isExhausted`, because a workflow module may
    // value-import only as a `proxyActivities` argument — see `activities.ts`.
    if ('exhausted' in next) {
      setCarryover(STATUS_KEY, {...status, paused});
      return 'exhausted';
    }
    boundary = next;

    // The race #69 describes: a timer against the signals. `condition` re-evaluates at
    // every activation, so a pause arriving mid-sleep is seen without the timer having
    // to fire. The still-outstanding timer is discarded by the rollover below.
    //
    // `background` rather than a bare `void sleep(...)`: on cancellation the timer
    // rejects with `CancelledFailure`, and a floating promise would carry that off as
    // an unhandled rejection. The branch captures it, and `throwIfFailed` puts it back
    // on the main line rather than letting a cancelled scheduler go on to fire.
    const timer = background(async () => {
      await sleep(next.delayMs);
      slept = true;
    });
    await condition(
      () => slept || paused || triggers > 0 || updated !== undefined,
    );
    timer.throwIfFailed();
  }

  const fired: ScheduleRunRecord[] = [];

  // A manual trigger fires regardless of the boundary, and is *not* deduplicated
  // against one: Temporal allows duplicates for triggers deliberately, because
  // someone asking twice means they want it twice. The ordinal keeps the ids distinct
  // without needing a clock.
  for (let i = 0; i < triggers; i++) {
    const ordinal = status.triggerCount + i + 1;
    const targetId = `${scheduleId}-manual-${ordinal}`;
    startWorkflow(targetId, definition.target.name, {
      args: definition.target.args,
      taskQueue: definition.target.taskQueue,
    });
    fired.push({nominalTimeMs: ordinal, targetId, manual: true});
  }

  // The scheduled fire happens only if the timer is what woke us. Waking early
  // because of a pause or an update must not bring the boundary forward.
  if (slept && !paused && boundary !== undefined) {
    const targetId = `${scheduleId}-${boundary.nominalTimeMs}`;
    // The id carries the nominal time, so a boundary fired twice — a retried task, a
    // rollover landing on the same instant — claims one execution rather than running
    // the work twice. That is the dedup, and it is at the server rather than here.
    startWorkflow(targetId, definition.target.name, {
      args: definition.target.args,
      taskQueue: definition.target.taskQueue,
    });
    fired.push({nominalTimeMs: boundary.nominalTimeMs, targetId});
  }

  // **The fire has to be flushed before the rollover, in its own task.**
  //
  // `continueAsNew` discards the command batch issued alongside it, deliberately and
  // by assertion — `spec/server/final_task_commands.spec.ts` records why: a rollover
  // empties history, so a marker written a moment earlier is erased, and an armed timer
  // whose `timerStarted` went with it fires into a run that never issued that seq. That
  // is a nondeterminism error rather than merely lost work, so dropping the batch is the
  // lesser evil until `continueAsNew` has a design of its own.
  //
  // The consequence for a scheduler is total: firing and rolling over in one task means
  // *every* fire is silently discarded, and the status still records it, so the schedule
  // looks like it is working. This sleep is the task boundary that makes the dispatch
  // real. It is not a delay — a zero timer is past-due the moment it is armed.
  if (fired.length > 0) await sleep(0);

  // Carryover is the only thing that crosses a rollover — history is emptied — so this
  // write is what stops the cycle just dispatched from being forgotten and dispatched
  // again.
  setCarryover(STATUS_KEY, {
    paused,
    // Advanced only when the boundary was actually reached. Advancing it on an early
    // wake would skip that boundary silently, and the schedule would miss a run while
    // looking perfectly healthy.
    handledThroughMs:
      slept && boundary !== undefined
        ? boundary.nominalTimeMs
        : status.handledThroughMs,
    triggerCount: status.triggerCount + triggers,
    recent: [...fired.reverse(), ...status.recent].slice(0, RECENT_LIMIT),
  });
  return continueAsNew(updated ?? definition);
}

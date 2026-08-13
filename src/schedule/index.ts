/**
 * @fileoverview
 * ★ SCHEDULE ENTRYPOINT — everything a consumer needs to run and operate schedules.
 *
 * A separate subpath (`workflow-engine/schedule`) rather than exports bolted onto the
 * host entrypoint, because schedules are a slice and not a part of the engine: nothing
 * in `core/`, `server/`, or `worker/` knows this directory exists. Removing it would
 * remove a feature, not break the engine.
 *
 * ## The two things a consumer does
 *
 * **Register the workflow in a worker.** The scheduler is a workflow like any other and
 * has to run somewhere:
 *
 * ```ts
 * import {scheduleWorkflows} from 'workflow-engine/schedule';
 * Tempo.startWorker({name: 'orders', workflows: {...myWorkflows, ...scheduleWorkflows}});
 * ```
 *
 * The activities come along without being named, because `scheduler.workflow.ts`
 * declares them with `proxyActivities` and loading the module registers them.
 *
 * **Drive it with a `ScheduleClient`.** See `schedule_client.ts`.
 *
 * ## Why the consumer's worker, and not the server's
 *
 * Temporal runs its scheduler in an internal worker service, and copying that here was
 * the plan until two things argued against it.
 *
 * The architectural one: `server_main.ts` states that a deployment is **two artifacts**,
 * a server and a worker, each a single call. A server that also runs workflows is a
 * third thing, and the separation is load-bearing rather than tidy — `server/` runs no
 * user code, which is what keeps replay out of the process that owns the store.
 *
 * The practical one is sharper. `ScheduleTarget.taskQueue` defaults to the scheduler's
 * own queue, which is the behaviour anyone would expect and is right *only* if the
 * scheduler runs where the target's workers are. A server-hosted scheduler would fire
 * every unqualified target onto an internal queue that no worker polls, and the failure
 * would look like a schedule that fires and produces nothing — visible only as
 * executions piling up unstarted. Registering the scheduler beside the workflows it
 * starts makes the default correct by construction.
 *
 * The cost is one spread in a worker's `workflows` object, which is a line a consumer
 * can see, rather than a queue mismatch they cannot.
 */

export {
  scheduler,
  pauseSchedule,
  resumeSchedule,
  triggerSchedule,
  updateSchedule,
  type ScheduleDefinition,
  type ScheduleRunRecord,
  type ScheduleStatus,
  type ScheduleTarget,
} from './scheduler.workflow';

export {
  createScheduleClient,
  SCHEDULER_WORKFLOW_NAME,
  type ScheduleClient,
  type ScheduleSummary,
  type ScheduleView,
} from './schedule_client';

export {
  nextFire,
  isExhausted,
  type NextFire,
  type ScheduleExhausted,
} from './next_fire_activity';
export {nextFireAfter, scheduleSpecProblems} from './next_fire';

import {scheduler} from './scheduler.workflow';

/**
 * The workflows a worker must register to run schedules, as one object to spread.
 *
 * A bundle rather than a bare export so that adding a second workflow later — a
 * backfill runner, say — is not a breaking change to every consumer's worker setup.
 * The key is `SCHEDULER_WORKFLOW_NAME`, which is also what `ScheduleClient` starts, so
 * the two cannot drift into a mismatch that only shows up as a schedule that never runs.
 */
export const scheduleWorkflows = {scheduler} as const;

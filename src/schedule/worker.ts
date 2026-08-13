/**
 * @fileoverview
 * ★ SCHEDULE WORKER ENTRYPOINT — what a worker binary registers to run schedules.
 *
 * ```ts
 * import {scheduleWorkflows} from 'workflow-engine/schedule/worker';
 * Tempo.startWorker({name: 'orders', workflows: {...myWorkflows, ...scheduleWorkflows}});
 * ```
 *
 * The activities come along without being named, because `scheduler.workflow.ts` declares
 * them with `proxyActivities` and loading the module registers them.
 *
 * ## Why this is a separate path from `workflow-engine/schedule`
 *
 * **Importing this evaluates the scheduler workflow**, which reaches the author
 * entrypoint and registers activities into a process-global registry as a side effect of
 * the import. That is exactly right in a worker binary and exactly wrong anywhere else —
 * a dashboard that only wants `createScheduleClient` would otherwise pull the workflow
 * runtime into its bundle and mutate a global registry to do it.
 *
 * The split puts the safe half on the shorter, more obvious path. The dangerous direction
 * is the one that cannot be reached by accident: importing the client path in a worker
 * binary loses `scheduleWorkflows`, which is a compile error, whereas importing this in a
 * browser used to be silent.
 */

import {scheduler} from './scheduler.workflow';

export {
  scheduler,
  pauseSchedule,
  resumeSchedule,
  triggerSchedule,
  updateSchedule,
} from './scheduler.workflow';

export {
  nextFire,
  isExhausted,
  type NextFire,
  type ScheduleExhausted,
} from './next_fire_activity';

/**
 * The workflows a worker binary must register to run schedules, as one object to spread.
 *
 * A bundle rather than a bare export so that adding a second workflow later — a backfill
 * runner, say — is not a breaking change to every worker's setup. The key is
 * `SCHEDULER_WORKFLOW_NAME`, which is also what `ScheduleClient` starts, so the two
 * cannot drift into a mismatch that would only show up as a schedule that never runs.
 */
export const scheduleWorkflows = {scheduler} as const;

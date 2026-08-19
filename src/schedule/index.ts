/**
 * @fileoverview
 * ★ SCHEDULE ENTRYPOINT — creating, inspecting and operating schedules.
 *
 * Safe to import from anywhere: a dashboard, a CLI, a server-side tool, a browser.
 * Nothing reachable from here evaluates workflow code, touches the activity registry, or
 * pulls the engine's runtime into a bundle — it needs `protocol/` and pure arithmetic and
 * nothing else.
 *
 * ```ts
 * import {createScheduleClient} from 'workflow-engine/schedule';
 * const schedules = createScheduleClient(createRemoteService('/api'));
 * ```
 *
 * ## The other half is `workflow-engine/schedule/worker`
 *
 * Registering the scheduler in a worker binary is a separate import, and the separation
 * is the point rather than tidiness. That path evaluates the scheduler workflow, which
 * reaches the author entrypoint and registers activities into a process-global registry
 * as an import side effect — correct in a worker binary, wrong in a browser.
 *
 * This file was both for about a day, which meant a dashboard importing
 * `createScheduleClient` also got the workflow runtime. Splitting puts the safe half on
 * the shorter path and leaves the dangerous one unreachable by accident: importing the
 * client path in a worker binary loses `scheduleWorkflows` and fails to compile, where
 * the reverse used to fail silently.
 *
 * ## Where the types live
 *
 * `ScheduleSpec`, `ScheduleBounds`, `ScheduleDefinition`, `ScheduleTarget`,
 * `ScheduleStatus` and `ScheduleRunRecord` are in `protocol/`, re-exported here for
 * convenience. They belong there because they cross every seam a schedule has: a
 * definition is the scheduler workflow's arguments and a status is its carryover, so both
 * come back out of `describeExecution` and are read by callers that never import this
 * directory at all.
 */

export {
  createScheduleClient,
  SCHEDULER_WORKFLOW_NAME,
  type IntervalSpecInput,
  type ScheduleClient,
  type ScheduleClientOptions,
  type ScheduleCreation,
  type ScheduleDefinitionInput,
  type ScheduleSpecInput,
  type ScheduleSummary,
  type ScheduleView,
} from './schedule_client';

/**
 * The spec arithmetic, for a caller that wants to validate or preview without creating
 * anything — a form checking a spec as it is typed, or a listing showing the next fire.
 * Pure functions of a spec and an instant; they read no clock.
 */
export {nextFireAfter, scheduleSpecProblems} from './next_fire';

export type {Duration} from '../walltime';

export type {
  CalendarSpec,
  IntervalSpec,
  ScheduleBounds,
  ScheduleDefinition,
  ScheduleRunRecord,
  ScheduleSpec,
  ScheduleStatus,
  ScheduleTarget,
} from '../protocol';

/**
 * @fileoverview
 * `ScheduleClient` — create, inspect and operate schedules.
 *
 * ## Why this is not a set of RPCs
 *
 * The plan was seven wire methods: `createSchedule`, `listSchedules`,
 * `describeSchedule`, `updateSchedule`, `deleteSchedule`, `setSchedulePaused`,
 * `triggerSchedule`. Each would have touched `protocol/rpc.ts`,
 * `services/rpc_server.ts`, `services/server_host.ts`, `services/remote_service.ts`,
 * `services/local_service.ts` and `client/` — five files in three layers, per method,
 * to smear one feature across the whole engine.
 *
 * None of it would have added a *capability*. A schedule is an execution, so every
 * operation already exists on `WorkflowService`:
 *
 * | schedule operation | what it actually is |
 * | --- | --- |
 * | create | `start` the scheduler workflow under a chosen id |
 * | pause / resume / trigger / update | `signal` |
 * | describe | `describeExecution` — args are the definition, carryover the status |
 * | list | `listExecutions({name})` |
 * | delete | `cancel` |
 *
 * So this is a *vocabulary* over the existing seam rather than an extension of it,
 * which is what lets the whole slice live in one directory importing only
 * `protocol/` and the `walltime/` library. It works against a local runtime and a remote server without knowing
 * which it has, because `WorkflowService` is the seam both implement.
 *
 * The one thing an RPC layer would have bought — rejecting a bad spec before it becomes
 * a running workflow — is here as `scheduleSpecProblems`, checked in `create`.
 *
 * ## What it deliberately does not hide
 *
 * The ids. A schedule's id is chosen by the caller and its runs are named
 * `<scheduleId>-<nominalTime>`, so `listRuns` is a prefix query and a caller who wants
 * to cancel one run can address it directly. An opaque handle would have made the
 * predictable naming — which is the dedup mechanism — unreachable.
 */

import {DEFAULT_TASK_QUEUE, isNameServed} from '../protocol';
import {durationToMs, type Duration} from '../walltime';
import type {
  CalendarSpec,
  ExecutionDetail,
  ExecutionPage,
  ExecutionSummary,
  ScheduleBounds,
  ScheduleDefinition,
  ScheduleSpec,
  ScheduleStatus,
  ScheduleTarget,
  WorkflowService,
} from '../protocol';
import {scheduleSpecProblems} from './next_fire';

/**
 * The workflow type a schedule is.
 *
 * Exported because it is the filter for "list every schedule", and because a consumer
 * registering the workflow under a different name would produce schedules this client
 * cannot find. `scheduleWorkflows` is keyed by it for that reason.
 */
export const SCHEDULER_WORKFLOW_NAME = 'scheduler';

/**
 * An interval spec as a caller may write one: the wire fields, or `Duration`
 * spellings of them — `{type: 'interval', every: '1 hour', offset: '15 min'}`.
 * Exactly one spelling of the period; the offset is optional in either.
 */
export interface IntervalSpecInput {
  type: 'interval';
  /** `everyMs`, as a `Duration`. Set one or the other, not both. */
  every?: Duration;
  everyMs?: number;
  /** `offsetMs`, as a `Duration`. Set one or the other, not both. */
  offset?: Duration;
  offsetMs?: number;
}

/** A spec as `create`/`update` accept it. Calendar specs have no `…Ms` fields to sweeten. */
export type ScheduleSpecInput = IntervalSpecInput | CalendarSpec;

/** A definition as `create`/`update` accept it: `ScheduleDefinition`, spec sugar included. */
export interface ScheduleDefinitionInput {
  spec: ScheduleSpecInput;
  bounds?: ScheduleBounds;
  target: ScheduleTarget;
  paused?: boolean;
}

/**
 * The stored spec a spec input means. Throws on a contradiction (both spellings
 * of one field) or a missing period, with the schedule id added by the caller —
 * these are refused-call errors, same as a failed validation.
 *
 * What gets stored — and therefore what `describe` reports and the scheduler
 * replays — is always the wire form in milliseconds. The sugar exists only at
 * this seam, for the same reason duration strings never reach a timer command:
 * one representation once it is durable.
 */
function normalizeSpec(spec: ScheduleSpecInput): ScheduleSpec {
  if (spec.type === 'calendar') return spec;

  function pickMs(
    name: string,
    duration: Duration | undefined,
    msName: string,
    ms: number | undefined,
  ): number | undefined {
    if (duration !== undefined && ms !== undefined)
      throw new Error(
        `set ${name} or ${msName}, not both — they are the same field in two spellings`,
      );
    return duration === undefined ? ms : durationToMs(duration);
  }

  const everyMs = pickMs('every', spec.every, 'everyMs', spec.everyMs);
  if (everyMs === undefined)
    throw new Error(`an interval spec needs a period — set every or everyMs`);
  const offsetMs = pickMs('offset', spec.offset, 'offsetMs', spec.offsetMs);
  return {
    type: 'interval',
    everyMs,
    ...(offsetMs === undefined ? {} : {offsetMs}),
  };
}

/**
 * Spec sugar resolved, spec validated, queue named — the one path a definition
 * takes on its way to being stored, shared by `create` and `update` so the two
 * cannot drift on what a valid definition is.
 */
function normalizeDefinition(
  scheduleId: string,
  verb: 'create' | 'update',
  definition: ScheduleDefinitionInput,
): ScheduleDefinition {
  function refuse(reason: string): never {
    throw new Error(`cannot ${verb} schedule "${scheduleId}": ${reason}`);
  }

  let spec: ScheduleSpec;
  try {
    spec = normalizeSpec(definition.spec);
  } catch (error) {
    return refuse((error as Error).message);
  }
  const problems = scheduleSpecProblems(spec, definition.bounds ?? {});
  if (problems.length > 0) refuse(problems.join('; '));

  // The queue is normalised here rather than left undefined, so that what gets
  // stored — and therefore what `describe` reports — always names the queue the
  // runs will go to. An undefined queue reaching the scheduler would be resolved
  // by the server as "inherit the starter's queue", which is right only while the
  // scheduler happens to be colocated with the target's workers and silently
  // changes meaning if it ever is not.
  return {
    ...definition,
    spec,
    target: {
      ...definition.target,
      taskQueue: definition.target.taskQueue ?? DEFAULT_TASK_QUEUE,
    },
  };
}

/** A schedule as a listing shows it. */
export interface ScheduleSummary {
  scheduleId: string;
  /** `running` for a live schedule; a terminal status means it was deleted or exhausted. */
  status: ExecutionSummary['status'];
}

/** A schedule as `describe` shows it: what it should do, and what it has done. */
export interface ScheduleView {
  scheduleId: string;
  status: ExecutionSummary['status'];
  /**
   * The definition currently in force — the args of the run in progress, so an
   * `update` is reflected here from its next rollover.
   */
  definition: ScheduleDefinition | undefined;
  /**
   * What the schedule has done. Absent only before the first rollover, since carryover
   * reports what a run *started* with and the first run started with nothing.
   */
  schedule: ScheduleStatus | undefined;
}

/** What `create` did, and anything about it that looked wrong. */
export interface ScheduleCreation {
  scheduleId: string;
  /**
   * Things that will stop this schedule working, in plain sentences. Empty is the
   * normal case.
   *
   * **Advisory, and produced after the schedule has already started.** Refusing would
   * be wrong for the reason `spec/integration/distributed.spec.ts` records: a queue
   * with no worker for a name far more often means a deploy still rolling than a
   * mistake, and failing fast would trade a recoverable state for an unrecoverable
   * one. So a schedule is always created, and the caller is told what it noticed.
   *
   * **Silence is not a clean bill of health.** These come from `isNameServed`, which
   * answers `undefined` when the workers on a queue do not report what they can run —
   * and this warns only on a definite `false`. Warning on "cannot tell" would fire
   * constantly for any fleet whose workers predate manifests, which is how a warning
   * becomes something people learn to ignore.
   */
  warnings: string[];
}

/** Everything an operator does to a schedule. */
export interface ScheduleClient {
  /**
   * Create a schedule and start it.
   *
   * The spec is validated first and a bad one **rejects**, because it should be a
   * refused call rather than a workflow that starts and immediately fails: the second
   * is durable, appears in listings, and has to be cleaned up.
   *
   * The id is the caller's, and is the schedule's identity for the rest of its life —
   * `describe`, `pause` and `delete` all take it, and its runs are named after it.
   *
   * **Warnings are advisory and arrive after the schedule exists.** See
   * `ScheduleCreation.warnings` for why nothing here refuses on them.
   */
  create(
    scheduleId: string,
    definition: ScheduleDefinitionInput,
  ): Promise<ScheduleCreation>;
  /** Every schedule, live or finished. */
  list(): Promise<ScheduleSummary[]>;
  /** One schedule's definition and status, or undefined if there is no such schedule. */
  describe(scheduleId: string): Promise<ScheduleView | undefined>;
  /**
   * One page of the executions a schedule has started, ordered by creation like any
   * other listing, with `nextCursor` to continue.
   *
   * Paged rather than complete because a schedule's runs are unbounded — an hourly one
   * makes nearly nine thousand a year — so a method that walked them all would get
   * slower every day the schedule stayed up.
   */
  listRuns(scheduleId: string, cursor?: string): Promise<ExecutionPage>;
  /** Stop firing on the spec. Triggers still work; see `trigger`. */
  pause(scheduleId: string): void;
  /** Resume firing on the spec. */
  resume(scheduleId: string): void;
  /**
   * Run the target now, regardless of the spec and regardless of pause.
   *
   * Not deduplicated against a boundary or against another trigger — asking twice runs
   * twice, deliberately, because that is what asking twice means. This is the "last
   * night's job failed, run it now" operation.
   */
  trigger(scheduleId: string): void;
  /**
   * Replace the definition. Takes effect at the schedule's next rollover, which is its
   * next fire or its next signal.
   *
   * Validated like `create`, and a bad definition **throws** before anything is
   * sent — the alternative is a signal that reaches the scheduler, rolls over
   * into arguments its `nextFire` activity rejects, and fails the schedule
   * itself, which is strictly worse than a refused call.
   */
  update(scheduleId: string, definition: ScheduleDefinitionInput): void;
  /**
   * Stop the schedule for good.
   *
   * **Runs it already started keep running.** The scheduler starts them with
   * `startWorkflow`, so they are nobody's children and a cancel does not cascade to
   * them — deleting a schedule stops the schedule, not the work it set off. Cancel a
   * particular run by its own id if that is what is wanted.
   */
  delete(scheduleId: string): void;
}

/**
 * The two ways a schedule can be created successfully and never do anything, stated as
 * sentences — or nothing, when the fleet cannot say.
 *
 * Both failures look identical from outside: a schedule that exists, reports `running`,
 * and produces no runs. They are the last cases of that shape left in this feature, which
 * is why they are worth a round trip at creation.
 *
 * `isNameServed` answers **three** ways, and only a definite `false` speaks here. Its
 * `undefined` means the workers on that queue do not report what they can run, and
 * warning then would fire for every fleet whose worker binaries predate manifests —
 * training the reader to ignore the warning that matters. Saying nothing when we do not
 * know is the whole reason the predicate has a third answer.
 */
async function unservedWarnings(
  service: WorkflowService,
  definition: ScheduleDefinition,
  schedulerTaskQueue: string,
): Promise<string[]> {
  const queues = await service.listQueues();
  const warnings: string[] = [];

  // The forgotten `scheduleWorkflows` registration. The schedule is started, the
  // execution is created, and no worker will ever replay it.
  if (
    isNameServed(
      queues,
      schedulerTaskQueue,
      'workflow',
      SCHEDULER_WORKFLOW_NAME,
    ) === false
  )
    warnings.push(
      `no worker on task queue "${schedulerTaskQueue}" runs "${SCHEDULER_WORKFLOW_NAME}", ` +
        `so this schedule will not fire. Register it: ` +
        `startWorker({workflows: {...yours, ...scheduleWorkflows}}).`,
    );

  // The schedule fires correctly and its runs pile up unstarted.
  const targetQueue = definition.target.taskQueue ?? DEFAULT_TASK_QUEUE;
  if (
    isNameServed(queues, targetQueue, 'workflow', definition.target.name) ===
    false
  )
    warnings.push(
      `no worker on task queue "${targetQueue}" runs "${definition.target.name}", ` +
        `so this schedule will fire and its runs will not start.`,
    );

  return warnings;
}

/** How a `ScheduleClient` is wired. */
export interface ScheduleClientOptions {
  /**
   * Which queue the *scheduler executions* run on — that is, wherever
   * `scheduleWorkflows` was registered. Defaults to `DEFAULT_TASK_QUEUE`.
   *
   * Distinct from `ScheduleTarget.taskQueue`, which is where the *work* runs. Pass this
   * only when schedulers are deliberately given their own worker pool; where a
   * schedule's runs go is a per-schedule decision and belongs on the definition.
   */
  schedulerTaskQueue?: string;
}

/** Build a `ScheduleClient` over any `WorkflowService` — local runtime or remote server. */
export function createScheduleClient(
  service: WorkflowService,
  options: ScheduleClientOptions = {},
): ScheduleClient {
  const schedulerTaskQueue = options.schedulerTaskQueue ?? DEFAULT_TASK_QUEUE;
  const send = (
    scheduleId: string,
    signal: string,
    payload?: unknown,
  ): void => {
    service.signal(scheduleId, signal, payload);
  };

  return {
    async create(scheduleId, definition) {
      const normalized = normalizeDefinition(scheduleId, 'create', definition);

      service.start(SCHEDULER_WORKFLOW_NAME, [normalized], {
        workflowId: scheduleId,
        // **The scheduler's queue, not the target's.** These were the same value until
        // it became clear they answer different questions: this one asks where the
        // *scheduler* runs, which is wherever `scheduleWorkflows` was registered, and
        // `target.taskQueue` asks where the work runs. Tying them meant a schedule
        // aimed at a `reports` queue could only run if the scheduler had also been
        // registered on `reports` — so pointing a schedule at a dedicated pool quietly
        // stopped the schedule itself from running.
        taskQueue: schedulerTaskQueue,
      });

      // Checked *after* starting, not before. The schedule exists either way — see
      // `ScheduleCreation.warnings` — so holding the create behind an advisory read
      // would add a round trip to the path that always succeeds, in order to maybe
      // say something about the path that already succeeded.
      return {
        scheduleId,
        warnings: await unservedWarnings(
          service,
          normalized,
          schedulerTaskQueue,
        ),
      };
    },

    async list() {
      // Walked to the end rather than returning a page. Listings are capped, and there
      // is no useful answer to "some of your schedules" — an operator asking what is
      // scheduled needs all of it. Safe to walk because the count is bounded by how
      // many schedules a person created, which is tens, unlike the runs below.
      const schedules: ScheduleSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.listExecutions({
          name: SCHEDULER_WORKFLOW_NAME,
          cursor,
        });
        for (const item of page.executions)
          schedules.push({scheduleId: item.workflowId, status: item.status});
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return schedules;
    },

    async describe(scheduleId) {
      const detail: ExecutionDetail | undefined =
        await service.describeExecution(scheduleId);
      if (!detail) return undefined;
      return {
        scheduleId,
        status: detail.status,
        definition: detail.args[0] as ScheduleDefinition | undefined,
        schedule: detail.carryover?.['schedule'] as ScheduleStatus | undefined,
      };
    },

    async listRuns(scheduleId, cursor) {
      // A prefix query, which works because the scheduler names every run
      // `<scheduleId>-<nominalTime>`. The trailing separator matters: without it
      // `nightly` would also match `nightly-report`'s runs.
      //
      // One page, unlike `list` above, and the asymmetry is the point: a schedule's runs
      // grow without bound — an hourly one produces nearly nine thousand a year — so
      // walking to the end is a request that gets slower every day it is left running.
      // The cursor is passed through instead.
      const page = await service.listExecutions({
        workflowIdPrefix: `${scheduleId}-`,
        cursor,
      });
      return page;
    },

    pause(scheduleId) {
      send(scheduleId, 'pauseSchedule');
    },
    resume(scheduleId) {
      send(scheduleId, 'resumeSchedule');
    },
    trigger(scheduleId) {
      send(scheduleId, 'triggerSchedule');
    },
    update(scheduleId, definition) {
      send(
        scheduleId,
        'updateSchedule',
        normalizeDefinition(scheduleId, 'update', definition),
      );
    },
    delete(scheduleId) {
      service.cancel(scheduleId);
    },
  };
}

/**
 * @fileoverview
 * The catalogue: one entry per state a dashboard has to render, each saying how
 * to create it and how to know it has arrived.
 *
 * ## A fixed catalogue, deliberately, and not a builder
 *
 * The obvious alternative is a fluent API for composing arbitrary states, and it
 * is worse for the job this exists to do. A builder lets a consumer construct
 * states the engine cannot actually produce — an execution both `completed` and
 * carrying pending work, a queue with backlog and no history — and then build a
 * UI that renders them. The drift that follows is invisible until something real
 * disagrees with the fixture, which is exactly the failure a shared harness is
 * supposed to remove.
 *
 * A closed list also makes the set *meaningful in the other direction*: a state
 * that is not in this file is one no dashboard should claim to handle, and adding
 * a scenario is the way to say a new one exists. Growth is cheap — an entry is a
 * `seed` and a `settled` — and it happens here, once, rather than in every
 * consumer.
 *
 * ## Every scenario waits for its own state
 *
 * Seeding is asynchronous almost everywhere: a start is fire-and-forget, a task
 * has to be claimed, an activity has to fail before there is anything to retry.
 * If `startScenario` resolved when the *requests* were made, a consumer would
 * render an empty server and see their state appear a second later, which is the
 * flakiness this is meant to spare them. So each entry names the condition that
 * means it is really there, and the harness does not resolve until all of them
 * hold.
 */

import type {WorkflowFn} from '../core';
import {isStuck, type RemoteWorkflowService} from '../protocol';
import {
  createWorkflowRegistry,
  createWorkflowWorker,
  runWorkflowWorker,
  startWorkflowReporter,
} from '../worker';
import {workflowDescriptor} from '../workflow_descriptor';
import * as scenarioWorkflowModule from './scenarios.workflow';

/** Every state the harness can produce. Adding one is adding a case here. */
export type ScenarioName =
  | 'settled-mixed'
  | 'parked'
  | 'retrying'
  | 'stuck'
  | 'unserved-queue'
  | 'split-manifest';

/** What a scenario is handed to build itself. */
export interface SeedContext {
  /** The service the harness's own workers poll — reads and writes both go here. */
  readonly service: RemoteWorkflowService;
  /** The queue the harness's workers serve. Work put here gets run. */
  readonly queue: string;
  /**
   * A queue nothing polls, by construction.
   *
   * Its emptiness is the fixture: an execution routed here is the "no worker has
   * ever served this pool" case, which renders identically to a healthy wait in
   * every view that does not consult `isQueueServed`.
   */
  readonly unservedQueue: string;
  /**
   * Poll `predicate` until it holds, or fail with `label` in the message.
   *
   * `label` is not decoration. A harness that times out is usually being run
   * against a change that broke the state it was creating, and "waited for: the
   * wedged execution reports a task failure" is the difference between a
   * five-minute diagnosis and an afternoon.
   */
  until(label: string, predicate: () => Promise<boolean>): Promise<void>;
  /**
   * Register teardown for something long-lived this seed started — a worker
   * loop, a reporter. Run by `ScenarioServer.stop()` alongside the harness's
   * own workers, so a scenario that *is* a running process (see
   * `split-manifest`) does not leak it past the server it was seeded into.
   */
  onStop(stop: () => void | Promise<void>): void;
}

/** One named state: how to create it, and how to know it is there. */
export interface ScenarioDefinition {
  /** One line, shown by `describeScenarios()` and in the harness's own docs. */
  readonly summary: string;
  seed(context: SeedContext): Promise<void>;
}

/**
 * Workflow-type names a scenario can start.
 *
 * All but the last are registered by the harness's workers. `undeployed` is
 * **deliberately not registered** — see the `stuck` scenario, and the note at the
 * foot of `scenarios.workflow.ts`. Its absence is what produces the state.
 */
export const SCENARIO_WORKFLOWS = {
  completes: 'scenarioCompletes',
  fails: 'scenarioFails',
  parks: 'scenarioParks',
  retries: 'scenarioRetries',
  undeployed: 'scenarioNotDeployedYet',
} as const;

/**
 * Execution ids are fixed rather than generated.
 *
 * A dashboard developer writes assertions and bookmarks against these, and a
 * generated id would make both change on every run. They are also a claim — see
 * `StartWorkflowOptions.workflowId` — so seeding twice against one server yields
 * one execution per scenario rather than a growing pile.
 */
export const SCENARIO_IDS = {
  completed: 'scenario-completed',
  failed: 'scenario-failed',
  parked: 'scenario-parked',
  retrying: 'scenario-retrying',
  stuck: 'scenario-stuck',
  unserved: 'scenario-unserved',
} as const;

/** The identity the conflicting report in `split-manifest` is filed under. */
export const SPLIT_MANIFEST_IDENTITY = 'scenario-old-binary';

async function describeOf(
  context: SeedContext,
  workflowId: string,
): Promise<Awaited<ReturnType<RemoteWorkflowService['describeExecution']>>> {
  return context.service.describeExecution(workflowId);
}

export const SCENARIOS: Record<ScenarioName, ScenarioDefinition> = {
  'settled-mixed': {
    summary:
      'One completed and one failed execution, so terminal states are on screen.',
    async seed(context) {
      context.service.start(
        SCENARIO_WORKFLOWS.completes,
        {value: 'hello'},
        {
          workflowId: SCENARIO_IDS.completed,
          taskQueue: context.queue,
        },
      );
      context.service.start(SCENARIO_WORKFLOWS.fails, undefined, {
        workflowId: SCENARIO_IDS.failed,
        taskQueue: context.queue,
      });

      await context.until(
        'both executions reach a terminal status',
        async () => {
          const [completed, failed] = await Promise.all([
            describeOf(context, SCENARIO_IDS.completed),
            describeOf(context, SCENARIO_IDS.failed),
          ]);
          return (
            completed?.status === 'completed' && failed?.status === 'failed'
          );
        },
      );
    },
  },

  parked: {
    summary:
      'An execution parked on a condition, waiting for a `release` signal that never comes.',
    async seed(context) {
      context.service.start(SCENARIO_WORKFLOWS.parks, undefined, {
        workflowId: SCENARIO_IDS.parked,
        taskQueue: context.queue,
      });

      // Parked, specifically — not merely running. A running execution with no
      // parked condition and no pending work is one whose task is still in
      // flight, and that is a different row.
      await context.until(
        'the execution reports a parked condition',
        async () => {
          const detail = await describeOf(context, SCENARIO_IDS.parked);
          return (detail?.parked.length ?? 0) > 0;
        },
      );
    },
  },

  retrying: {
    summary:
      'An execution between activity attempts, backing off a minute at a time.',
    async seed(context) {
      context.service.start(SCENARIO_WORKFLOWS.retries, undefined, {
        workflowId: SCENARIO_IDS.retrying,
        taskQueue: context.queue,
      });

      // Read through the grouping rather than the execution, because that is the
      // view this scenario exists for: an execution stuck behind a retrying
      // activity is `running` and healthy-looking everywhere else.
      await context.until('an activity is counted as retrying', async () => {
        const groups = await context.service.groupExecutions();
        return groups.retryingActivities.some((group) => group.attempts > 0);
      });
    },
  },

  stuck: {
    summary:
      'A wedged execution: running, but failing every task, so `isStuck` is true.',
    async seed(context) {
      // A workflow type nothing on this queue registers — the everyday cause,
      // which is a deploy still rolling out. Note the queue *is* served: the
      // worker polls, cannot run it, and fails the task. That is what separates
      // this from `unserved-queue`, where nothing ever picks the task up and
      // `taskFailures` stays at zero.
      context.service.start(SCENARIO_WORKFLOWS.undeployed, undefined, {
        workflowId: SCENARIO_IDS.stuck,
        taskQueue: context.queue,
      });

      await context.until(
        'the execution reports a workflow-task failure',
        async () => {
          const detail = await describeOf(context, SCENARIO_IDS.stuck);
          return detail !== undefined && isStuck(detail);
        },
      );
    },
  },

  'unserved-queue': {
    summary:
      'An execution routed to a queue no worker polls — the most common cause of "it is stuck".',
    async seed(context) {
      context.service.start(
        SCENARIO_WORKFLOWS.completes,
        {value: 'never'},
        {
          workflowId: SCENARIO_IDS.unserved,
          taskQueue: context.unservedQueue,
        },
      );

      // It will never progress, so the only thing to wait for is that the server
      // has recorded it at all. That *is* the fixture: a `running` execution with
      // nothing coming for it.
      await context.until('the execution exists and is running', async () => {
        const detail = await describeOf(context, SCENARIO_IDS.unserved);
        return detail?.status === 'running';
      });
    },
  },

  'split-manifest': {
    summary:
      'Two workers describing one workflow differently — a fleet running two versions of a binary.',
    async seed(context) {
      // A second worker, really running: registered with the same workflow
      // functions — so a task it wins from the shared queue still replays —
      // but describing one of them as the previous release worded it. That
      // disagreement is what `conflicting` exists to surface, and it is
      // invisible in every other view: both workers are healthy, both are
      // polling, both serve the queue.
      //
      // Really running is not flavor. The catalogue only counts a report while
      // the worker behind it vouches for it on its polls (`isReportCurrent`),
      // so a bare `reportWorkflows` under a made-up identity — which is what
      // this seed used to do — would surface a conflict that evaporated
      // `QUEUE_STALE_MS` later, mid-way through whatever the dashboard
      // developer was building against it.
      const workflows = Object.entries(scenarioWorkflowModule).filter(
        (entry): entry is [string, WorkflowFn] =>
          typeof entry[1] === 'function',
      );
      const reporter = startWorkflowReporter(
        context.service,
        workflows.map(([name, fn]) =>
          name === SCENARIO_WORKFLOWS.completes
            ? {
                name,
                ...(workflowDescriptor(fn) ?? {}),
                title: 'Completes immediately (previous release)',
                description:
                  'The same workflow as the live binary describes, worded differently — which is what makes the fleet disagree.',
              }
            : {name, ...(workflowDescriptor(fn) ?? {})},
        ),
        {identity: SPLIT_MANIFEST_IDENTITY, taskQueue: context.queue},
      );
      const registry = createWorkflowRegistry();
      for (const [name, fn] of workflows) registry.set(name, fn);
      const loop = runWorkflowWorker(
        context.service,
        createWorkflowWorker(registry),
        {
          taskQueue: context.queue,
          identity: SPLIT_MANIFEST_IDENTITY,
          servesHash: reporter.hash,
        },
      );
      context.onStop(async () => {
        reporter.stop();
        await loop.stop();
      });

      await context.until('the catalogue reports a conflict', async () => {
        const listed = await context.service.listWorkflows();
        return listed.some((workflow) => workflow.conflicting === true);
      });
    },
  },
};

/** Every scenario name with its one-line summary, for a `--help` or a README. */
export function describeScenarios(): ReadonlyArray<{
  name: ScenarioName;
  summary: string;
}> {
  return (Object.keys(SCENARIOS) as ScenarioName[]).map((name) => ({
    name,
    summary: SCENARIOS[name].summary,
  }));
}

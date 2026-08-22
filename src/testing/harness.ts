/**
 * @fileoverview
 * The scenario harness, with no transport attached: given a `WorkflowService`,
 * register the fixtures, run the worker loops, and seed the named states.
 *
 * Split out of `testing/index.ts` for the reason `dispatch.ts` is split out of
 * `rpc_server.ts` — the composition is not about sockets. `startScenario`
 * stands up an HTTP server and calls this; a browser hosting the whole engine
 * in a Web Worker calls it with a service that dispatches in-process. Both get
 * the same fleet, the same manifests and the same seeded states, because it is
 * the same code rather than two copies that would drift.
 *
 * **Not free of Node builtins**, and deliberately not claiming to be: the
 * worker loops reach for `node:os` to name themselves, the reporter hashes its
 * manifest with `node:crypto`, and `core/` carries workflow context in
 * `node:async_hooks`. A browser consumer aliases those; see `src/sandbox.ts`,
 * which names all four and why each is safe to shim.
 */

import type {RemoteWorkflowService} from '../protocol';
import {nextFire, scheduleWorkflows} from '../schedule/worker';
import * as scenarioActivities from './scenario_activities';
import * as scenarioWorkflows from './scenarios.workflow';
import {
  describedAs,
  SCENARIOS,
  type ScenarioName,
  type SeedContext,
} from './scenarios';
import {
  createActivityRegistry,
  createActivityWorker,
  createWorkflowRegistry,
  createWorkflowWorker,
  runActivityWorker,
  runWorkflowWorker,
  startWorkflowReporter,
  type ActivityFn,
  type WorkerLoop,
} from '../worker';
import type {WorkflowFn} from '../core';

/** The queue the harness's own workers serve. */
export const SCENARIO_QUEUE = 'default';

/**
 * A queue the harness deliberately never polls.
 *
 * Named rather than generated so a consumer can assert against it, and separate
 * from `SCENARIO_QUEUE` because the whole point is a pool with no workers on it.
 */
export const UNSERVED_QUEUE = 'unserved';

/** How long any one scenario may take to reach its state before giving up. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** How often a scenario's settling condition is re-checked. */
const POLL_MS = 20;

export interface HarnessOptions {
  /** How long to wait for each scenario to reach its state. */
  timeoutMs?: number;
}

/** Everything the harness started, and how to stop it. */
export interface RunningHarness {
  readonly taskQueue: string;
  /** Stop the workers and anything a seed started. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Register the fixtures against `service`, start the loops, and seed.
 *
 * Rejects if a scenario does not reach its state within `timeoutMs`, naming the
 * condition — and tears its own loops down first, since a caller whose seeding
 * failed holds no handle to them.
 */
export async function startHarnessOn(
  service: RemoteWorkflowService,
  scenarios: readonly ScenarioName[] = [],
  options: HarnessOptions = {},
): Promise<RunningHarness> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const workflows = Object.entries(scenarioWorkflows).filter(
    (entry): entry is [string, WorkflowFn] => typeof entry[1] === 'function',
  );

  // Started before the loops, because its digest is what they put on every poll.
  // Without it the catalogue is empty and `listWorkflows` has nothing to show,
  // which is half of what a dashboard developer came here for.
  const reporter = startWorkflowReporter(
    service,
    [
      ...workflows.map(([name]) => ({name, ...describedAs(name)})),
      // The scheduler is in the manifest, not only the registry: `isNameServed`
      // answers from what workers *report*, so leaving it out makes creating a
      // schedule against this harness warn "no worker runs scheduler" about a
      // worker that does — a state no correctly-configured deployment produces,
      // which is the one thing this harness must not fake.
      ...Object.keys(scheduleWorkflows).map((name) => ({
        name,
        title: 'Scheduler',
        description:
          'Runs schedules — each schedule is one execution of this workflow, addressed by its schedule id.',
      })),
    ],
    {identity: 'scenario-harness', taskQueue: SCENARIO_QUEUE},
  );

  const workflowRegistry = createWorkflowRegistry();
  for (const [name, fn] of workflows) workflowRegistry.set(name, fn);
  const activityRegistry = createActivityRegistry();
  for (const [name, fn] of Object.entries(scenarioActivities))
    activityRegistry.set(name, fn as ActivityFn);
  // The schedule machinery, registered the way a consumer's worker binary
  // would register it. Unconditional rather than per-scenario: a dashboard
  // developed against this harness has a "create schedule" affordance, and a
  // fixture where creating one silently wedges — no worker registers
  // `scheduler` — is a state no deployment with schedules produces.
  for (const [name, fn] of Object.entries(scheduleWorkflows))
    workflowRegistry.set(name, fn as WorkflowFn);
  activityRegistry.set('nextFire', nextFire as unknown as ActivityFn);

  const loops: WorkerLoop[] = [
    runWorkflowWorker(service, createWorkflowWorker(workflowRegistry), {
      taskQueue: SCENARIO_QUEUE,
      identity: 'scenario-harness',
      servesHash: reporter.hash,
    }),
    runActivityWorker(service, createActivityWorker(activityRegistry), {
      taskQueue: SCENARIO_QUEUE,
      identity: 'scenario-harness',
    }),
  ];

  // What the seeds started and the harness must therefore stop — a scenario can
  // be a running process (see `split-manifest`), and a consumer holds no handle
  // to it but this harness's `stop`.
  const seedStops: Array<() => void | Promise<void>> = [];

  let stopping: Promise<void> | undefined;
  const harness: RunningHarness = {
    taskQueue: SCENARIO_QUEUE,
    stop() {
      stopping ??= (async () => {
        reporter.stop();
        await Promise.all([
          ...loops.map((loop) => loop.stop()),
          ...seedStops.map((stop) => stop()),
        ]);
      })();
      return stopping;
    },
  };

  const context: SeedContext = {
    service,
    queue: SCENARIO_QUEUE,
    unservedQueue: UNSERVED_QUEUE,
    until: (label, predicate) => until(label, predicate, timeoutMs),
    onStop: (stop) => {
      seedStops.push(stop);
    },
  };

  try {
    for (const name of scenarios) await SCENARIOS[name].seed(context);
  } catch (e) {
    await harness.stop();
    throw e;
  }

  return harness;
}

/**
 * Poll until `predicate` holds, or throw naming what was being waited for.
 *
 * Polling rather than an event, because every condition here is a projection the
 * server derives on request — there is nothing to subscribe to, and inventing a
 * notification for the harness's benefit would be a feature of the engine rather
 * than of the fixture.
 */
async function until(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
  throw new Error(
    `scenario timed out after ${timeoutMs}ms waited for: ${label}`,
  );
}

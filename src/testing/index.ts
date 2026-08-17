/**
 * @fileoverview
 * ★ TESTING ENTRYPOINT — a real server, on a real port, already in the states a
 * dashboard has to render.
 *
 * ```ts
 * import {startScenario} from 'workflow-engine/testing';
 *
 * const server = await startScenario(['stuck', 'parked', 'unserved-queue']);
 * // point the dashboard at server.url, build the UI, then:
 * await server.stop();
 * ```
 *
 * ## Why this is in the library and the dashboard is not
 *
 * The standing decision is that operator tooling lives elsewhere (#64), and the
 * test it turns on is falsifiability: the CLI, the deployment kit and the
 * dashboard all knew things about a machine, a browser, or a supervisor that this
 * repo has never run on, so every assumption could only be disproved in the
 * consumer's repo and only fixed here.
 *
 * A scenario fails that test in the other direction. It is built out of this
 * engine's own primitives — its workflows, its retry policy, its task queues —
 * and `spec/testing/scenarios.spec.ts` runs every one of them in this repo's CI.
 * Nothing here can be wrong in a way that only shows up on someone else's
 * machine, which is exactly what the earlier three could not say.
 *
 * The positive case is stronger than the absence of the objection. Without this,
 * every dashboard reimplements a wedged execution and a starved queue from
 * guesswork, and each one's fixtures drift from what the engine actually produces
 * — separately, and invisibly, until something real disagrees with them. The
 * catalogue in `scenarios.ts` is also a conformance surface: a state it cannot
 * produce is a state no dashboard should claim to render.
 *
 * ## It composes rather than calling the entrypoints
 *
 * `startServer` and `Tempo.startWorker` both read `process.argv` — that is the
 * point of them, and it is wrong here. A harness running inside a consumer's test
 * process, or inside a script launched with flags of its own, would silently pick
 * up their `--port`, `--server` or `--queue` and bind or dial somewhere nobody
 * asked for. Worse, a flag *wins* over the options object, so passing `port`
 * explicitly would not save it.
 *
 * So this builds the same thing out of `createServerHost`, `createRpcServer` and
 * the worker loops directly, which is the case `src/index.ts` says those exports
 * exist for. It also means no `LISTENING` line on stdout, which a consumer's test
 * runner has no reason to see.
 *
 * ## In memory, always
 *
 * No `dataDir`, so no history store on disk and no lockfile to collide with a
 * second harness. Two scenarios can run side by side in one test suite, on two
 * random ports, without coordinating. The cost is that nothing survives `stop()`,
 * which for a fixture is the point rather than a limitation.
 */

import {createRemoteClient, type RemoteClient} from '../client';
import {
  DEFAULT_TASK_QUEUE,
  serverUrl,
  type RemoteWorkflowService,
  type ServerEndpoint,
} from '../protocol';
import {
  createRemoteService,
  createRpcServer,
  createServerHost,
  resolveEndpoint,
} from '../services';
import * as scenarioActivities from './scenario_activities';
import * as scenarioWorkflows from './scenarios.workflow';
import {SCENARIOS, type ScenarioName, type SeedContext} from './scenarios';
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
import {workflowDescriptor} from '../workflow_descriptor';
import type {AddressInfo} from 'node:net';

export {
  describeScenarios,
  SCENARIO_IDS,
  SCENARIO_WORKFLOWS,
  type ScenarioName,
} from './scenarios';

/** The queue the harness's own workers serve. */
export const SCENARIO_QUEUE = DEFAULT_TASK_QUEUE;

/**
 * A queue the harness deliberately never polls.
 *
 * Named rather than generated so a consumer can assert against it, and separate
 * from `SCENARIO_QUEUE` because the whole point is a pool with no workers on it.
 */
export const UNSERVED_QUEUE = 'unserved';

/** How long any one scenario may take to reach its state before giving up. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** How often a scenario's settling condition is re-checked. */
const POLL_MS = 20;

export interface StartScenarioOptions {
  /** Port to bind. Defaults to 0 — any free one, which is what lets two run at once. */
  port?: number;
  /** Interface to bind. Defaults to loopback; there is no auth on this transport. */
  host?: string;
  /** How long to wait for each scenario to reach its state. */
  timeoutMs?: number;
}

/** A running harness: where it is, and how to stop it. */
export interface ScenarioServer {
  /** Base URL to point a dashboard, or a `createRemoteService`, at. */
  readonly url: string;
  /** The port actually bound — read this after the default `port: 0`. */
  readonly port: number;
  /** The queue the harness's workers serve. */
  readonly taskQueue: string;
  /** A client against this server, so a caller need not build one. */
  readonly client: RemoteClient;
  /** Stop the workers and close the port. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Stand up a server, seed it with the named scenarios, and resolve once every one
 * of them is observable.
 *
 * Scenarios are seeded in the order given and each waits for its own state, so a
 * caller reading the list top to bottom is reading what will be there. Passing
 * none starts an empty server — useful on its own, as the "nothing has happened
 * yet" case a dashboard also has to render.
 *
 * @throws if a scenario does not reach its state within `timeoutMs`, naming the
 * condition that was being waited for.
 */
export async function startScenario(
  scenarios: readonly ScenarioName[] = [],
  options: StartScenarioOptions = {},
): Promise<ScenarioServer> {
  const bindHost = options.host ?? '127.0.0.1';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Silent by default: `createServerHost` defaults its logger to `silentLogger`,
  // and a fixture that writes JSON Lines into a consumer's test output would be
  // the first thing they wrapped to shut up.
  //
  // The endpoint is wired the same way `server_main.ts` wires it, and for the
  // same reason it is worth doing here at all: a dashboard developed against
  // this fixture reads `health()` for the server's own address, and a fixture
  // that left those fields empty would send them building the fallback path
  // instead of the real one — a state no deployment produces, which is the one
  // thing this harness must not fake.
  let endpoint: ServerEndpoint | undefined;
  const host = createServerHost(undefined, {endpoint: () => endpoint});
  const rpc = createRpcServer(host);
  const address = await new Promise<AddressInfo>((resolve, reject) => {
    rpc.once('error', reject);
    rpc.listen(options.port ?? 0, bindHost, () =>
      resolve(rpc.address() as AddressInfo),
    );
  });
  endpoint = resolveEndpoint(address);
  // Derived from the resolved endpoint rather than rebuilt from `bindHost`, so a
  // caller and the server it just started cannot disagree about where it is. The
  // two differ exactly where the string the caller passed is not an address to
  // dial — `host: '0.0.0.0'` — and there `serverUrl` substitutes something that
  // is. It cannot be `undefined` here: the endpoint was just resolved from a
  // live listener.
  const url = serverUrl(endpoint);
  const service: RemoteWorkflowService = createRemoteService(url);

  const workflows = Object.entries(scenarioWorkflows).filter(
    (entry): entry is [string, WorkflowFn] => typeof entry[1] === 'function',
  );

  // Started before the loops, because its digest is what they put on every poll.
  // Without it the catalogue is empty and `listWorkflows` has nothing to show,
  // which is half of what a dashboard developer came here for.
  const reporter = startWorkflowReporter(
    service,
    workflows.map(([name, fn]) => ({name, ...(workflowDescriptor(fn) ?? {})})),
    {identity: 'scenario-harness', taskQueue: SCENARIO_QUEUE},
  );

  const workflowRegistry = createWorkflowRegistry();
  for (const [name, fn] of workflows) workflowRegistry.set(name, fn);
  const activityRegistry = createActivityRegistry();
  for (const [name, fn] of Object.entries(scenarioActivities))
    activityRegistry.set(name, fn as ActivityFn);

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

  let stopping: Promise<void> | undefined;
  const server: ScenarioServer = {
    url,
    port: address.port,
    taskQueue: SCENARIO_QUEUE,
    client: createRemoteClient(service),
    stop() {
      // Idempotent, and in this order: the loops must stop polling before the
      // port closes, or a poll in flight rejects and the loop reports a failure
      // on the way out that nothing was wrong with.
      stopping ??= (async () => {
        reporter.stop();
        await Promise.all(loops.map((loop) => loop.stop()));
        await new Promise<void>((resolve) => rpc.close(() => resolve()));
      })();
      return stopping;
    },
  };

  const context: SeedContext = {
    service,
    queue: SCENARIO_QUEUE,
    unservedQueue: UNSERVED_QUEUE,
    until: (label, predicate) => until(label, predicate, timeoutMs),
  };

  try {
    for (const name of scenarios) await SCENARIOS[name].seed(context);
  } catch (e) {
    // A half-seeded harness still holds a port and two poll loops, and a consumer
    // whose `startScenario` rejected has no handle to close them with. Tearing
    // down here is the only chance anything gets to.
    await server.stop();
    throw e;
  }

  return server;
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

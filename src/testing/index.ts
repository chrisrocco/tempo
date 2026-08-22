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
 * `startServer` and `startWorker` both read `process.argv` — that is the
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
import {type ScenarioName} from './scenarios';
import {
  startHarnessOn,
  DEFAULT_TIMEOUT_MS,
  type RunningHarness,
} from './harness';
import type {AddressInfo} from 'node:net';

export {
  describeScenarios,
  SCENARIO_IDS,
  SCENARIO_WORKFLOWS,
  type ScenarioName,
} from './scenarios';

export {SCENARIO_QUEUE, UNSERVED_QUEUE} from './harness';

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

  let harness: RunningHarness;
  try {
    harness = await startHarnessOn(service, scenarios, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (e) {
    // A half-seeded harness still holds a port, and a consumer whose
    // `startScenario` rejected has no handle to close it with. The loops have
    // already torn themselves down (see `startHarnessOn`).
    await new Promise<void>((resolve) => rpc.close(() => resolve()));
    throw e;
  }

  let stopping: Promise<void> | undefined;
  return {
    url,
    port: address.port,
    taskQueue: harness.taskQueue,
    client: createRemoteClient(service),
    stop() {
      // Idempotent, and in this order: the loops must stop polling before the
      // port closes, or a poll in flight rejects and the loop reports a failure
      // on the way out that nothing was wrong with.
      stopping ??= (async () => {
        await harness.stop();
        await new Promise<void>((resolve) => rpc.close(() => resolve()));
      })();
      return stopping;
    },
  };
}

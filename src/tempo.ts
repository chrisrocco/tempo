/**
 * @fileoverview
 * ★ WORKER ENTRYPOINT — the single call a deployable worker binary makes.
 *
 * `Tempo.startWorker({name, workflows, activities})` wires a service to the
 * registries it builds from imported module namespaces (`import * as activities
 * from './activities'`). The export name is the registered name, so there is no
 * registration boilerplate.
 *
 * **The configuration is `StartWorkerOptions`** — see "The options object is the
 * configuration" below. Everything else is what can reach a worker from outside
 * that object, and there is deliberately little of it:
 *
 *   TEMPO_SERVER_URL  overrides `serverUrl` (else 127.0.0.1:7233)
 *   TEMPO_TASK_QUEUE  overrides `taskQueue` (else `default`)
 *   TEMPO_ROLE        overrides `role` — unset runs every role it can
 *   --runtime=MODE    overrides `runtime` — `remote` (default) or `local`
 *   --describe        print {name, workflows, activities} as JSON and exit
 *
 * Running the *same* binary twice with a different `TEMPO_ROLE` is how the two
 * worker tiers are deployed: workflow workers replay workflow code, activity
 * workers run activities (the only I/O in the system), and each scales
 * independently against one server.
 *
 * `TEMPO_TASK_QUEUE` is what lets more than one application share a server. A
 * queue name is a contract — every worker on it must register the same workflows
 * and activities — and it is not optional once a second app exists: with one
 * global queue, whichever worker wins a poll decides whether the task can run at
 * all, and one that cannot serve it fails the task rather than passing it on.
 *
 * ## Two runtimes behind one entrypoint
 *
 * **`remote`**, the default, is the deployable shape: a `RemoteService` over the
 * RPC, and poll loops that claim work from a server somewhere else.
 *
 * **`local`** composes `createLocalRuntime()` instead — server, workers, and
 * client in one process, dispatching by function call rather than by poll. It
 * exists so a test can exercise *this entrypoint*, registries and all, without a
 * port to pick or a server to bring up. `spec/integration/local.spec.ts` covers
 * the runtime itself; what only this mode covers is the wiring in between,
 * which is where a workflow that is exported but never registered would hide.
 *
 * The returned `Worker` carries `localRuntime` in that mode. It has to: a local
 * worker holds the only reference to its own server, so without it nothing can
 * start an execution and the process is inert.
 *
 * That is also why a *spawned* binary in local mode prints `WORKER_READY` and
 * then exits: nothing outside the process can reach it, so once the module
 * finishes there is no work and nothing holding the event loop open. Run that
 * way it is a smoke test — every export registered, no server needed — and not
 * a dev server. `tempo up` is the dev server, and it is remote by design.
 *
 * ### Why a flag rather than `TEMPO_RUNTIME`
 *
 * Every other input here is an environment variable, and this one deliberately
 * is not. Environment variables are inherited: one `TEMPO_RUNTIME=local` left in
 * a deployment's environment — or exported in a shell that later launches a real
 * worker — turns a production worker into a process that serves nobody while
 * still printing `WORKER_READY` and looking healthy to its supervisor. That is
 * the failure `planning/tickets/02` is about, arrived at from a different
 * direction. A flag has to be typed at the launch site and does not propagate to
 * children, which is the property that matters for a testing affordance.
 *
 * ### What local mode ignores, and the one thing it refuses
 *
 * The server URL and the task queue are **ignored**: there is nothing to connect
 * to, and one in-process pair serves every queue (`LocalService` polls with no
 * queue filter). Ignored rather than rejected, because both are ambient in a dev
 * shell — `tempo up` sets `TEMPO_SERVER_URL` for its own child — and erroring on
 * an inherited value would make the flag unusable exactly where it is wanted.
 *
 * `TEMPO_ROLE` is the exception and throws. It splits the two poll loops, and
 * local mode has no poll loops to split; honouring it half-way would leave a
 * "workflow-only" local worker parking every execution on an activity nothing
 * will ever run. That is a hang, not a failure, so it is worth the startup
 * error.
 *
 * ## The options object is the configuration
 *
 * `StartWorkerOptions` carries the whole of it — identity, where to connect,
 * which pool, which role, what to call itself, how hard to poll. Reading that
 * one object is reading the deployment, in a file that is type-checked, diffed,
 * and reviewed. It is the config file; it just happens to be TypeScript.
 *
 * **Three values can be overridden from the environment, and that is the
 * exception rather than the pattern**:
 *
 *   TEMPO_SERVER_URL  which server
 *   TEMPO_TASK_QUEUE  which pool
 *   TEMPO_ROLE        which half of the worker pair
 *
 * Those three are what a *deployment* changes about an artifact it did not
 * build: the same binary rolled into staging, into a second pool, or into the
 * two-tier split. An override wins when it is set — that is what makes it an
 * override — so code supplies the default the application ships with and the
 * environment supplies the deviation.
 *
 * Everything else is code only, deliberately. A value that changes only when the
 * code changes has no business being ambient, where it is invisible at the call
 * site and inherited by every child process. `identity` is the case that looks
 * like it wants an environment variable and does not: a container already has
 * its name in the environment, so write `identity: process.env['HOSTNAME']` in
 * the options object, where a reader can see where it came from, rather than
 * growing a second ambient surface that only some deployments set.
 *
 * The shape follows Temporal's client, where the address is a connection
 * argument rather than ambient state — and it is what the older "deployment
 * config is never passed in code" rule was really protecting, since the
 * environment still overrides the three values a redeploy needs.
 */

import type {WorkflowFn} from './core';
import {createLocalRuntime, type Runtime} from './local_runtime';
import {DEFAULT_TASK_QUEUE} from './protocol';
import {createJsonLogger} from './server';
import {createRemoteService} from './services';
import {
  createActivityRegistry,
  createActivityWorker,
  createWorkflowRegistry,
  createWorkflowWorker,
  runActivityWorker,
  runWorkflowWorker,
  type ActivityFn,
  type WorkerLoop,
  type WorkerLoopOptions,
} from './worker';

/** Where a worker looks for its server when `TEMPO_SERVER_URL` is unset. */
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:7233';

/**
 * Which poll loop a worker process runs. Deployments split the two into separate
 * services so that an activity blocking the event loop cannot stall workflow
 * replay into a lease expiry; with `TEMPO_ROLE` unset a single process runs both,
 * which is what `tempo up` and a hand-run binary want.
 */
export type WorkerRole = 'workflow' | 'activity';

/**
 * Which composition a worker runs under: a `RemoteService` polling a server, or
 * the in-process `createLocalRuntime()`. See the two-runtimes section above.
 */
export type RuntimeMode = 'local' | 'remote';

export interface StartWorkerOptions {
  /** Service identity: the unit name, the `tempo status` row, the `tempo logs` target. */
  name: string;
  /**
   * Which server to connect to in remote mode. `TEMPO_SERVER_URL` overrides it,
   * so this is the default the application ships with rather than its
   * deployment. Ignored in local mode — there is nothing to connect to.
   */
  serverUrl?: string;
  /**
   * Which runtime to compose. `--runtime=` overrides it, so a binary that ships
   * `runtime: 'remote'` can still be booted locally without editing code, and a
   * test can ask for local mode without touching `process.argv`.
   */
  runtime?: RuntimeMode;
  /**
   * Which pool this worker serves. `TEMPO_TASK_QUEUE` overrides it, so one binary
   * can be deployed into several pools.
   *
   * A queue name is a **contract**: every worker on it must register the same
   * workflows and activities. Two different applications sharing one queue is the
   * failure this routing exists to prevent — whichever worker wins the poll
   * decides whether the task can run at all.
   */
  taskQueue?: string;
  /**
   * Which poll loop to run. `TEMPO_ROLE` overrides it, which is how the same
   * artifact is deployed twice — one service per role, scaled independently.
   *
   * Omitted runs every role the binary has definitions for, which is what a
   * hand-run binary and `tempo up` want. Naming a role the binary cannot serve
   * is a startup error rather than a process that polls forever for work it
   * could never complete.
   */
  role?: WorkerRole;
  /**
   * What this worker calls itself on every poll, so `tempo queues` can count and
   * name the fleet. Defaults to `${pid}@${hostname}`.
   *
   * Worth setting wherever the process is not where an operator would look: a
   * container id or a deployment name beats a pid on a host nobody can ssh to.
   * In a container that value is already in the environment, so pass
   * `process.env['HOSTNAME']` here rather than reaching for an ambient
   * `TEMPO_IDENTITY` that would only be set in some deployments.
   *
   * Not verified and not unique by construction — two processes claiming one
   * identity are counted once. See `WorkerInfo`.
   */
  identity?: string;
  /** Backoff when a poll comes back with no task. */
  pollIntervalMs?: number;
  /** Delay after the first failed poll; doubles per consecutive failure. */
  errorBackoffMs?: number;
  /** Ceiling for that doubling. */
  maxErrorBackoffMs?: number;
  /** Module namespace of workflow functions, keyed by export name. */
  workflows?: object;
  /** Module namespace of activity functions, keyed by export name. */
  activities?: object;
}

export interface Worker {
  readonly name: string;
  /**
   * The roles this process actually started. In local mode there are no poll
   * loops, so this reports what the binary *registered* — which is what the
   * readiness line has always meant to a supervisor.
   */
  readonly roles: readonly WorkerRole[];
  /**
   * The in-process runtime, in local mode only. A local worker holds the sole
   * reference to its own server, so this is the only way to start an execution
   * against it; in remote mode it is `undefined` and the client is somewhere
   * else entirely.
   */
  readonly localRuntime?: Runtime;
  /** Stop polling and wait for in-flight work to finish. Idempotent. */
  stop(): Promise<void>;
}

/** Any callable. `any[]` rest params are required for assignability — see `core/workflow_api`. */
type AnyFn = (...args: any[]) => unknown;

/**
 * A module namespace carries whatever the module exported — constants, classes,
 * enums — so only the callables can become registry entries. Mirrors the
 * type-level filtering `proxyActivities` does on `typeof activities`.
 */
function callableEntries(source: object | undefined): [string, AnyFn][] {
  if (!source) return [];
  return Object.entries(source).filter(
    (entry): entry is [string, AnyFn] => typeof entry[1] === 'function',
  );
}

/**
 * Which runtime to compose: `--runtime=` if the launch site said, else what the
 * code shipped, else remote.
 *
 * Exported because the precedence is the interesting part and a spec should be
 * able to state it without rewriting `process.argv`. Takes `argv` for the same
 * reason.
 *
 * A bare `--runtime` is an error rather than a synonym for `local`: the flag has
 * two modes and guessing which one an unfinished argument meant is how a worker
 * ends up in the wrong one silently.
 */
export function resolveRuntime(
  argv: readonly string[],
  option: RuntimeMode | undefined,
): RuntimeMode {
  const flag = argv.find(
    (arg) => arg === '--runtime' || arg.startsWith('--runtime='),
  );
  if (flag === undefined) return option ?? 'remote';

  const value = flag.slice('--runtime='.length);
  if (value !== 'local' && value !== 'remote')
    throw new Error(
      `--runtime must be "local" or "remote"${value ? ` (got "${value}")` : ' — it takes a value, as --runtime=local'}`,
    );
  return value;
}

/**
 * Where a remote worker connects. The environment wins over the code, so the
 * artifact redeploys against another server without a rebuild; the code's value
 * is the default it ships with.
 */
function resolveServerUrl(option: string | undefined): string {
  return process.env['TEMPO_SERVER_URL'] ?? option ?? DEFAULT_SERVER_URL;
}

/** A configured role and where it came from, so an error can name its source. */
interface RequestedRole {
  value: string;
  source: 'TEMPO_ROLE' | 'role';
}

/**
 * The role the deployment asked for: the environment if it overrode, else the
 * options object, else none. Trimmed and returned with its origin, because "you
 * asked for a role this binary cannot serve" is only actionable if it says
 * *where* the ask was written.
 */
function requestedRole(
  option: WorkerRole | undefined,
): RequestedRole | undefined {
  const fromEnvironment = process.env['TEMPO_ROLE']?.trim();
  if (fromEnvironment) return {value: fromEnvironment, source: 'TEMPO_ROLE'};
  if (option) return {value: option, source: 'role'};
  return undefined;
}

/**
 * An explicit role is authoritative and must be satisfiable — a worker deployed
 * into a role it cannot serve should fail loudly at startup rather than poll
 * forever for tasks it can never complete. With none we run every role the
 * binary has definitions for, so an activities-only worker is legal.
 */
function resolveRoles(
  requested: RequestedRole | undefined,
  name: string,
  hasWorkflows: boolean,
  hasActivities: boolean,
): WorkerRole[] {
  if (requested) {
    const {value, source} = requested;
    if (value !== 'workflow' && value !== 'activity')
      throw new Error(
        `${source} must be "workflow" or "activity" (got "${value}")`,
      );
    const satisfiable = value === 'workflow' ? hasWorkflows : hasActivities;
    if (!satisfiable)
      throw new Error(
        `worker "${name}" started as ${source}=${value} but registers no ${value === 'workflow' ? 'workflows' : 'activities'}`,
      );
    return [value];
  }

  const roles: WorkerRole[] = [];
  if (hasWorkflows) roles.push('workflow');
  if (hasActivities) roles.push('activity');
  if (roles.length === 0)
    throw new Error(`worker "${name}" registers no workflows or activities`);
  return roles;
}

/**
 * The pass-through half of the configuration: what the poll loops take and this
 * entrypoint has no opinion about. Named rather than spread inline so adding a
 * knob to `WorkerLoopOptions` is one edit here, not three.
 */
type WorkerLoopTuning = Pick<
  WorkerLoopOptions,
  'identity' | 'pollIntervalMs' | 'errorBackoffMs' | 'maxErrorBackoffMs'
>;

/** What a runtime mode has to supply: something to stop, and maybe a way in. */
interface Composition {
  readonly localRuntime?: Runtime;
  stop(): Promise<void>;
}

/**
 * The deployable composition: a `RemoteService` over the RPC, and one poll loop
 * per role, each claiming work from a server in another process.
 */
function composeRemote(args: {
  name: string;
  serverUrl: string;
  taskQueue: string;
  roles: readonly WorkerRole[];
  loop: WorkerLoopTuning;
  workflows: readonly [string, AnyFn][];
  activities: readonly [string, AnyFn][];
}): Composition {
  const service = createRemoteService(args.serverUrl);

  // The worker's own lifecycle log, in the same JSON Lines shape the server
  // emits, so one pipeline reads both. A poll failure is the fault most likely
  // to matter here — an unreachable server makes a worker look healthy to its
  // supervisor while doing nothing (planning/tickets/02).
  const log = createJsonLogger();
  const onError = (error: unknown, consecutive: number): void => {
    log('worker.poll_failed', {
      worker: args.name,
      consecutive,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const loops: WorkerLoop[] = [];
  if (args.roles.includes('workflow')) {
    const registry = createWorkflowRegistry();
    for (const [exported, fn] of args.workflows)
      registry.set(exported, fn as WorkflowFn);
    loops.push(
      runWorkflowWorker(service, createWorkflowWorker(registry), {
        ...args.loop,
        onError,
        taskQueue: args.taskQueue,
      }),
    );
  }
  if (args.roles.includes('activity')) {
    const registry = createActivityRegistry();
    for (const [exported, fn] of args.activities)
      registry.set(exported, fn as ActivityFn);
    loops.push(
      runActivityWorker(service, createActivityWorker(registry), {
        ...args.loop,
        onError,
        taskQueue: args.taskQueue,
      }),
    );
  }

  return {
    stop: () =>
      Promise.all(loops.map((loop) => loop.stop())).then(() => undefined),
  };
}

/**
 * The in-process composition: `createLocalRuntime()` fed from the same module
 * namespaces, so what a test exercises is the entrypoint's own registration and
 * not a second wiring written for the test.
 *
 * Both halves are registered regardless of role, because there are no roles here
 * — a `LocalService` dispatches to its workers by function call, and the split
 * that `TEMPO_ROLE` describes has no meaning without poll loops to divide.
 */
function composeLocal(args: {
  workflows: readonly [string, AnyFn][];
  activities: readonly [string, AnyFn][];
}): Composition {
  const runtime = createLocalRuntime();
  for (const [exported, fn] of args.workflows)
    runtime.registerWorkflow(exported, fn as WorkflowFn);
  for (const [exported, fn] of args.activities)
    runtime.registerActivity(exported, fn as ActivityFn);

  return {
    localRuntime: runtime,
    stop: () => {
      // Timers hold the event loop open; shutting them down is what lets a
      // process that started a local worker exit on its own.
      runtime.shutdown();
      return Promise.resolve();
    },
  };
}

export function startWorker(options: StartWorkerOptions): Worker {
  const workflows = callableEntries(options.workflows);
  const activities = callableEntries(options.activities);

  // `--describe` is how `tempo deploy` interrogates a built binary: it must
  // report what the artifact contains without connecting to anything.
  if (process.argv.includes('--describe')) {
    console.log(
      JSON.stringify({
        name: options.name,
        workflows: workflows.map(([exported]) => exported),
        activities: activities.map(([exported]) => exported),
      }),
    );
    return {name: options.name, roles: [], stop: () => Promise.resolve()};
  }

  const runtime = resolveRuntime(process.argv, options.runtime);
  const role = requestedRole(options.role);
  if (runtime === 'local' && role)
    throw new Error(
      `worker "${options.name}" cannot serve ${role.source}=${role.value} under --runtime=local — the local runtime has no poll loops to split, and half of one parks every execution it starts on work nothing will claim`,
    );

  const roles = resolveRoles(
    role,
    options.name,
    workflows.length > 0,
    activities.length > 0,
  );

  // Resolved in both modes so the readiness line keeps one shape. In local mode
  // it names a pool nothing routes on: one in-process pair serves every queue.
  const taskQueue =
    process.env['TEMPO_TASK_QUEUE'] ?? options.taskQueue ?? DEFAULT_TASK_QUEUE;

  const composition =
    runtime === 'local'
      ? composeLocal({workflows, activities})
      : composeRemote({
          name: options.name,
          serverUrl: resolveServerUrl(options.serverUrl),
          taskQueue,
          roles,
          // Straight through: what the poll loops take, this entrypoint passes.
          loop: {
            identity: options.identity,
            pollIntervalMs: options.pollIntervalMs,
            errorBackoffMs: options.errorBackoffMs,
            maxErrorBackoffMs: options.maxErrorBackoffMs,
          },
          workflows,
          activities,
        });

  let stopping: Promise<void> | undefined;
  const worker: Worker = {
    name: options.name,
    roles,
    localRuntime: composition.localRuntime,
    stop(): Promise<void> {
      stopping ??= composition.stop().then(() => {
        // Dropped on the way out so a process that starts several workers over
        // its lifetime — which is what local mode invites — does not accumulate
        // a handler per worker.
        process.off('SIGTERM', shutdown);
        process.off('SIGINT', shutdown);
      });
      return stopping;
    },
  };

  // Readiness line — a supervisor, `tempo up`, or a test can wait on it.
  console.log(`WORKER_READY ${options.name} ${roles.join(',')} ${taskQueue}`);

  function shutdown(): void {
    void worker.stop().then(() => process.exit(0));
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return worker;
}

/** The namespace a worker entrypoint imports: `Tempo.startWorker({...})`. */
export const Tempo = {startWorker};

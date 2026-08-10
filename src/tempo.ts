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
 *   --server=URL   overrides `serverUrl` (else 127.0.0.1:7777)
 *   --queue=NAME   overrides `taskQueue` (else `default`)
 *   --role=ROLE    overrides `role` — unset runs every role it can
 *
 * Running the *same* binary twice with a different `--role` is how the two worker
 * tiers are deployed: workflow workers replay workflow code, activity workers run
 * activities (the only I/O in the system), and each scales independently against
 * one server. `tempo up` writes exactly that — one unit per role, one artifact.
 *
 * `--queue` is what lets more than one application share a server. A queue name
 * is a contract — every worker on it must register the same workflows and
 * activities — and it is not optional once a second app exists: with one global
 * queue, whichever worker wins a poll decides whether the task can run at all,
 * and one that cannot serve it fails the task rather than passing it on.
 *
 * ## This entrypoint composes one thing: a worker that polls a server
 *
 * A `RemoteService` over the RPC, and one poll loop per role claiming work from
 * a server in another process. That is the only shape it builds.
 *
 * It used to build a second one. `--runtime=local` composed
 * `createLocalRuntime()` instead — server, workers, and client in one process,
 * dispatching by function call — so that a spec could exercise this entrypoint
 * without a port to pick or a child to wait on. It is gone, because running
 * locally and running deployed differ by more than a composition: a local run
 * needs no build and no deployment, and folding it in here made a *deployable
 * artifact's* startup path branch on which of the two it was. Local running is
 * its own thing now, unbuilt (see `src/deploy/README.md`), and this file is about
 * the deployed worker only.
 *
 * `createLocalRuntime` itself is untouched and is still the fast in-process
 * runtime — see `local_runtime.ts` and `spec/integration/local.spec.ts`. What
 * went away is this entrypoint's ability to compose it.
 *
 * ## The options object is the configuration
 *
 * `StartWorkerOptions` carries the whole of it — identity, where to connect,
 * which pool, which role, what to call itself, how hard to poll. Reading that
 * one object is reading the deployment, in a file that is type-checked, diffed,
 * and reviewed. It is the config file; it just happens to be TypeScript.
 *
 * **Three values can be overridden from the command line, and that is the
 * exception rather than the pattern**:
 *
 *   --server=URL   which server
 *   --queue=NAME   which pool
 *   --role=ROLE    which half of the worker pair
 *
 * Those three are what a *deployment* changes about an artifact it did not
 * build: the same binary rolled into staging, into a second pool, or into the
 * two-tier split. An override wins when it is given — that is what makes it an
 * override — so code supplies the default the application ships with and the
 * launch site supplies the deviation.
 *
 * They used to be `TEMPO_SERVER_URL`, `TEMPO_TASK_QUEUE`, and `TEMPO_ROLE`. The
 * reason they are flags is in `process_flags.ts` and is the same reason the
 * `--runtime` flag that used to live here was a flag: **an environment variable
 * is inherited and a flag is not**, and one stale `TEMPO_SERVER_URL` in a shell
 * turns the next worker launched from it into a process that serves nobody while
 * printing `WORKER_READY` and looking healthy to its supervisor.
 *
 * Everything else is code only, deliberately. A value that changes only when the
 * code changes has no business being ambient, where it is invisible at the call
 * site. `identity` is the case that looks like it wants to be ambient and does
 * not: a container already has its name in the environment, so write
 * `identity: process.env['HOSTNAME']` in the options object, where a reader can
 * see where it came from, rather than growing an ambient surface that only some
 * deployments set.
 *
 * The shape follows Temporal's client, where the address is a connection
 * argument rather than ambient state — and it is what the older "deployment
 * config is never passed in code" rule was really protecting, since the launch
 * site still overrides the three values a redeploy needs.
 */

import type {WorkflowFn} from './core';
import {DEFAULT_PORT, flagValue} from './process_flags';
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

/**
 * Where a worker looks for its server when `--server` was not given.
 *
 * Built from `DEFAULT_PORT` rather than spelling the number again: a worker
 * dialling one port while the server binds another is a deployment in which
 * every process is healthy and no work ever moves.
 */
export const DEFAULT_SERVER_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

/**
 * Which poll loop a worker process runs. Deployments split the two into separate
 * services so that an activity blocking the event loop cannot stall workflow
 * replay into a lease expiry; with `--role` unset a single process runs both,
 * which is what a hand-run binary wants.
 */
export type WorkerRole = 'workflow' | 'activity';

export interface StartWorkerOptions {
  /** Service identity: the unit name, the `tempo status` row, the `tempo logs` target. */
  name: string;
  /**
   * Which server to connect to. `--server` overrides it, so this is the default
   * the application ships with rather than its deployment.
   */
  serverUrl?: string;
  /**
   * Which pool this worker serves. `--queue` overrides it, so one binary can be
   * deployed into several pools.
   *
   * A queue name is a **contract**: every worker on it must register the same
   * workflows and activities. Two different applications sharing one queue is the
   * failure this routing exists to prevent — whichever worker wins the poll
   * decides whether the task can run at all.
   */
  taskQueue?: string;
  /**
   * Which poll loop to run. `--role` overrides it, which is how the same artifact
   * is deployed twice — one service per role, scaled independently, which is
   * exactly what `tempo up` writes.
   *
   * Omitted runs every role the binary has definitions for, which is what a
   * hand-run binary wants. Naming a role the binary cannot serve is a startup
   * error rather than a process that polls forever for work it could never
   * complete.
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
  /** The roles this process started a poll loop for. */
  readonly roles: readonly WorkerRole[];
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
 * Where a remote worker connects. The launch site wins over the code, so the
 * artifact redeploys against another server without a rebuild; the code's value
 * is the default it ships with.
 *
 * Takes `argv` rather than reading `process.argv` so the precedence is statable
 * by a spec without rewriting a global — the same reason `resolveRoles` takes
 * what it was asked for rather than going and finding it.
 */
export function resolveServerUrl(
  argv: readonly string[],
  option: string | undefined,
): string {
  return flagValue(argv, 'server') ?? option ?? DEFAULT_SERVER_URL;
}

/** Which pool a worker serves: the launch site, else the code, else `default`. */
export function resolveTaskQueue(
  argv: readonly string[],
  option: string | undefined,
): string {
  return flagValue(argv, 'queue') ?? option ?? DEFAULT_TASK_QUEUE;
}

/** A configured role and where it came from, so an error can name its source. */
interface RequestedRole {
  value: string;
  source: '--role' | 'role';
}

/**
 * The role the deployment asked for: the flag if it overrode, else the options
 * object, else none. Trimmed and returned with its origin, because "you asked for
 * a role this binary cannot serve" is only actionable if it says *where* the ask
 * was written — a unit file or a source file are very different things to go and
 * fix.
 */
export function requestedRole(
  argv: readonly string[],
  option: WorkerRole | undefined,
): RequestedRole | undefined {
  const fromFlag = flagValue(argv, 'role')?.trim();
  if (fromFlag) return {value: fromFlag, source: '--role'};
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

/**
 * The composition: a `RemoteService` over the RPC, and one poll loop per role,
 * each claiming work from a server in another process.
 */
function composeRemote(args: {
  name: string;
  serverUrl: string;
  taskQueue: string;
  roles: readonly WorkerRole[];
  loop: WorkerLoopTuning;
  workflows: readonly [string, AnyFn][];
  activities: readonly [string, AnyFn][];
}): {stop(): Promise<void>} {
  const service = createRemoteService(args.serverUrl);

  // The worker's own lifecycle log, in the same JSON Lines shape the server
  // emits, so one pipeline reads both. A poll failure is the fault most likely
  // to matter here — an unreachable server makes a worker look healthy to its
  // supervisor while doing nothing.
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

export function startWorker(options: StartWorkerOptions): Worker {
  const workflows = callableEntries(options.workflows);
  const activities = callableEntries(options.activities);

  // Read once, from the process's own arguments past the interpreter and script.
  const argv = process.argv.slice(2);

  const roles = resolveRoles(
    requestedRole(argv, options.role),
    options.name,
    workflows.length > 0,
    activities.length > 0,
  );

  const taskQueue = resolveTaskQueue(argv, options.taskQueue);

  const composition = composeRemote({
    name: options.name,
    serverUrl: resolveServerUrl(argv, options.serverUrl),
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
    stop(): Promise<void> {
      stopping ??= composition.stop().then(() => {
        // Dropped on the way out so a process that starts several workers over
        // its lifetime — which a spec does — does not accumulate a handler per
        // worker.
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

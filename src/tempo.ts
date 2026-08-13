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
 *   --local=NAME   run that workflow once with no server, print, exit
 *   --args=JSON    its arguments, as a JSON array (with `--local` only)
 *
 * Running the *same* binary twice with a different `--role` is how the two worker
 * tiers are deployed: workflow workers replay workflow code, activity workers run
 * activities (the only I/O in the system), and each scales independently against
 * one server. A deployment is one worker artifact launched twice — two services,
 * two `--role` values, one file.
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
 * a server in another process. That is the only *service* shape it builds.
 *
 * The server this worker dials has a matching entrypoint —
 * [`startServer`](server_main.ts) — and the pair is the whole of what this
 * library hands a deployment: two artifacts, one call each. Everything about
 * installing, supervising, or restarting them belongs to whoever runs them (see
 * `README.md`, "Running it yourself").
 *
 * ## `--local=NAME` runs one workflow and exits
 *
 *   node worker.js --local=greeter --args='["world"]'
 *
 * No server, no port, no data directory, no poll loops: `createLocalRuntime()`
 * gets the same registries `startWorker` was handed, runs the named workflow to
 * completion, prints its result as JSON on stdout, and the process exits — 0 on
 * success, 1 on failure.
 *
 * **This is deliberately a second composition inside a deployable artifact,
 * which an earlier version of this file removed for being exactly that.** The
 * removal was right at the time and the reasoning is worth keeping, because what
 * changed is the circumstances rather than the argument:
 *
 * - The old `--runtime=local` made the artifact *become* a long-lived local
 *   runtime — two services to keep working, and a startup path that branched on
 *   which one it was. This one is **terminal**: it runs, it prints, it exits.
 *   There is no second long-lived thing, and no state in which a process is half
 *   a worker.
 * - The capability was going to come back as `tempo run-local`, a command of the
 *   CLI. That CLI is gone for good (#64), so there is no other home left. The
 *   choice is this or nothing.
 * - The objection that it "can only run what its own binary compiled in" still
 *   stands, and is now the *point*: it runs the shipped artifact, so it proves
 *   the workflow is registered in the bundle a deployment would install. That
 *   check had no home after `--runtime=local` went, and an artifact whose
 *   workflows were never registered otherwise reports nothing until executions
 *   park on a queue whose workers reject every task.
 *
 * **It refuses `--server` and `--role`** rather than quietly winning over them.
 * Both are contradictions at the launch site: there is no server to dial, and one
 * in-process pair serves every queue, so a role would park the execution on work
 * nothing claims. The *options object* is not refused — `serverUrl` and `role`
 * there are the artifact's shipped defaults, and `--local` says this run is not a
 * deployment, so the deployment's defaults are simply not consulted.
 *
 * **The hazard, stated where someone will find it.** A `--local` left in a
 * supervisor's command line is worse than a typo'd flag: the service runs one
 * workflow, exits, and — under `Restart=always` — runs it again, forever, with
 * real activities doing real I/O. Nothing here can detect that, because detecting
 * it means knowing the supervisor, which is the knowledge this repo deliberately
 * does not carry (`README.md`). What it does instead is **say so on every run**:
 * a `LOCAL RUN` line goes to stderr before the workflow starts, so a
 * crash-looping unit's log says what is wrong on every iteration rather than
 * looking like an application that keeps failing.
 *
 * **`createLocalRuntime` is still the way to run the engine in-process from
 * code** — see `local_runtime.ts` and `spec/integration/local.spec.ts`. `--local`
 * is not a replacement for it and does not try to be: it takes a workflow *name*
 * and a JSON array off a command line, so it can only run what the artifact
 * already registered, and it cannot assert, inspect, or signal. It is the way to
 * run a *binary* once; `createLocalRuntime` is the way to write a test.
 *
 * The cost of having it here, stated because it is paid by every deployment: a
 * worker artifact now bundles the engine it uses only in this mode. Measured on
 * the reference consumer, that is 24 KB to 81 KB. Small in absolute terms, real
 * as a multiple, and unavoidable — running a workflow with no server means the
 * engine has to be in the process that runs it.
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

import {
  activityNameConflicts,
  registeredActivityImpls,
} from './activity_registry';
import type {WorkflowFn} from './core';
import {createLocalRuntime} from './local_runtime';
import {DEFAULT_PORT, WORKER_FLAG, flagValue} from './process_flags';
import {DEFAULT_TASK_QUEUE} from './protocol';
import {createJsonLogger} from './server';
import {createRemoteService} from './services';
import {workflowDescriptor} from './workflow_descriptor';
import {
  createActivityRegistry,
  createActivityWorker,
  createWorkflowRegistry,
  createWorkflowWorker,
  DEFAULT_IDENTITY,
  runActivityWorker,
  runWorkflowWorker,
  startWorkflowReporter,
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
  /** Service identity: what the launcher calls this service, and what its logs are filed under. */
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
   * the two-service shape a deployment installs.
   *
   * Omitted runs every role the binary has definitions for, which is what a
   * hand-run binary wants. Naming a role the binary cannot serve is a startup
   * error rather than a process that polls forever for work it could never
   * complete.
   */
  role?: WorkerRole;
  /**
   * What this worker calls itself on every poll, so `Client.queues()` can count
   * and name the fleet. Defaults to `${pid}@${hostname}`.
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
  return flagValue(argv, WORKER_FLAG.server) ?? option ?? DEFAULT_SERVER_URL;
}

/** Which pool a worker serves: the launch site, else the code, else `default`. */
export function resolveTaskQueue(
  argv: readonly string[],
  option: string | undefined,
): string {
  return flagValue(argv, WORKER_FLAG.queue) ?? option ?? DEFAULT_TASK_QUEUE;
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
  const fromFlag = flagValue(argv, WORKER_FLAG.role)?.trim();
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

/** What `--local` asked for: one workflow, and the arguments to run it with. */
export interface LocalRun {
  workflow: string;
  args: readonly unknown[];
}

/**
 * What `--local` was asked to run, or `undefined` when it was not given.
 *
 * Throws rather than resolving a contradiction, because every contradiction here
 * is a launch site that believes it is doing something it is not:
 *
 * - **`--server` with `--local`** — one of the two is wrong, and guessing which
 *   means either running a workflow the caller wanted sent to a server, or
 *   ignoring a server they named.
 * - **`--role` with `--local`** — a local run has one in-process pair serving
 *   every queue, so a role could only narrow it into parking the execution on
 *   work nothing will claim.
 * - **`--args` that is not a JSON array** — the arguments are spread into the
 *   workflow's parameters, so a bare string or an object is a workflow called
 *   with one argument it did not expect, failing somewhere inside rather than
 *   here.
 *
 * The options object is deliberately not consulted: `--local` says this run is
 * not a deployment, and `serverUrl`/`role` in code are the deployment's defaults.
 */
export function resolveLocalRun(argv: readonly string[]): LocalRun | undefined {
  // `flagValue` already rejects `--local` and `--local=` with "needs a value",
  // which is the right answer: there are no boolean flags here, and a local run
  // has to know which workflow to run.
  const workflow = flagValue(argv, WORKER_FLAG.local)?.trim();
  if (!workflow) return undefined;

  for (const contradicted of [WORKER_FLAG.server, WORKER_FLAG.role] as const)
    if (flagValue(argv, contradicted) !== undefined)
      throw new Error(
        `--${contradicted} cannot be combined with --local: a local run has no server and runs every role in one process`,
      );

  const raw = flagValue(argv, WORKER_FLAG.args);
  if (raw === undefined) return {workflow, args: []};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--args must be JSON (got ${raw})`);
  }
  if (!Array.isArray(parsed))
    throw new Error(
      `--args must be a JSON array of the workflow's arguments, as --args='["world"]' (got ${raw})`,
    );
  return {workflow, args: parsed};
}

/**
 * Run one workflow to completion in this process and return its result.
 *
 * Separated from the flag reading and the printing so a spec can drive it
 * directly — the composition is the part worth pinning, and a function that also
 * owned argv and stdout could only be tested by spawning something.
 *
 * Shuts the runtime down on the way out either way, so the process can exit
 * rather than being held open by the timers of a run that already finished.
 */
export async function runLocally(
  run: LocalRun,
  registrations: {
    workflows: readonly [string, AnyFn][];
    activities: readonly [string, AnyFn][];
  },
): Promise<unknown> {
  const runtime = createLocalRuntime();
  for (const [name, fn] of registrations.workflows)
    runtime.registerWorkflow(name, fn as WorkflowFn);
  for (const [name, fn] of registrations.activities)
    runtime.registerActivity(name, fn as ActivityFn);

  try {
    // `start` throws "no workflow registered as …" for a name the artifact does
    // not have, which is the smoke test this whole flag exists to make possible.
    return await runtime.start(run.workflow, [...run.args]).result();
  } finally {
    runtime.shutdown();
  }
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

  // Started before the loops, because its digest is what they put on every poll — the
  // pair is how the server tells a current report from a stale one.
  //
  // Only the workflow role reports. An activity worker registers activity names, which
  // the catalogue is not about, and an empty report from it would be indistinguishable
  // from a workflow worker that registered nothing.
  const reporter = args.roles.includes('workflow')
    ? startWorkflowReporter(
        service,
        args.workflows.map(([name, fn]) => ({
          name,
          ...(workflowDescriptor(fn) ?? {}),
        })),
        {
          identity: args.loop?.identity ?? DEFAULT_IDENTITY,
          ...(args.taskQueue === undefined ? {} : {taskQueue: args.taskQueue}),
        },
      )
    : undefined;

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
        ...(reporter === undefined ? {} : {servesHash: reporter.hash}),
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
    stop: () => {
      reporter?.stop();
      return Promise.all(loops.map((loop) => loop.stop())).then(
        () => undefined,
      );
    },
  };
}

export function startWorker(options: StartWorkerOptions): Worker {
  const workflows = callableEntries(options.workflows);
  // What the workflows declared via `proxyActivities` first, then what this call
  // was handed, so an explicitly-passed activity wins over a declared one of the
  // same name — a caller that supplies its own set (a spec, a test double) is
  // unaffected by whatever the loaded workflow modules asked for.
  //
  // Snapshotted here rather than read through on every task: a worker's registered
  // set must not shift after `WORKER_READY` has reported what it serves, and `roles`
  // is derived from it too.
  const activities = [
    ...new Map([
      ...registeredActivityImpls(),
      ...callableEntries(options.activities),
    ]),
  ];

  // A worker refuses to start rather than run an activity it cannot identify.
  //
  // Two workflow modules declaring different implementations under one name leaves the
  // registry holding whichever loaded last, and a worker that started anyway would run
  // the wrong one — silently, forever, and looking healthy. That is worth refusing.
  //
  // **Checked here rather than at registration**, which is the whole reason this is a
  // deferred check: `proxyActivities` runs at module load, so throwing there fires
  // while modules are still evaluating, before any handler exists — a process that
  // crashes on import instead of reporting something actionable. By the time
  // `startWorker` is called every module has loaded and the picture is complete.
  //
  // A name the caller passed explicitly is **not** a conflict: `options.activities`
  // wins over anything declared, so naming it is exactly how an artifact resolves the
  // ambiguity, and it is the documented escape hatch.
  const explicit = new Set(
    callableEntries(options.activities).map(([name]) => name),
  );
  const unresolved = activityNameConflicts().filter(
    (name) => !explicit.has(name),
  );
  if (unresolved.length > 0)
    throw new Error(
      `worker "${options.name}" has ${unresolved.length} activity name${unresolved.length === 1 ? '' : 's'} claimed by more than one implementation: ${unresolved.join(', ')}. ` +
        `Whichever module loaded last would win, so this worker refuses to start rather than run an implementation nobody chose. ` +
        `Rename one of them, or name the intended implementation in startWorker({activities}), which overrides anything declared.`,
    );

  // Read once, from the process's own arguments past the interpreter and script.
  const argv = process.argv.slice(2);

  // Before any of the deployment wiring, because a local run consults none of it
  // — not the roles, not the queue, not the server. See the fileoverview.
  const localRun = resolveLocalRun(argv);
  if (localRun)
    return startLocalRun(options.name, localRun, {workflows, activities});

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

  // Readiness line for a human or a spawning test, not the readiness contract:
  // `Client.queues()` is what answers "is this worker polling" from anywhere, at
  // any time. See `server_main.ts`, which says the same about `LISTENING`.
  console.log(`WORKER_READY ${options.name} ${roles.join(',')} ${taskQueue}`);

  function shutdown(): void {
    void worker.stop().then(() => process.exit(0));
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return worker;
}

/**
 * The `--local` half of `startWorker`: run it, report it, arrange to exit.
 *
 * **Sets `process.exitCode` rather than calling `process.exit`.** Exiting
 * outright can truncate a stdout that is a pipe — which it is for every caller
 * that wants the result, a spec or a shell substitution alike — and the result
 * line is the whole output of this mode. The runtime's timers are stopped by
 * `runLocally`, and no signal handlers are registered here, so nothing holds the
 * event loop open and the process ends on its own with the code set below.
 *
 * The `Worker` returned is inert and says so: no roles, and a `stop` with nothing
 * to stop. Nothing observes it — the process is on its way out — but the return
 * type is what it is, and a plausible-looking worker would be a lie about a
 * process that is not polling anything.
 */
function startLocalRun(
  name: string,
  run: LocalRun,
  registrations: {
    workflows: readonly [string, AnyFn][];
    activities: readonly [string, AnyFn][];
  },
): Worker {
  // On stderr, before the workflow runs, on every run. This is the only defence
  // against a `--local` left in a supervisor's command line, where the symptom is
  // a service that runs one workflow and exits and is restarted forever — see the
  // fileoverview. stdout stays reserved for the result.
  console.error(
    `LOCAL RUN ${name} ${run.workflow} — one workflow, then exit. Not a deployment: no server, no durability.`,
  );

  void runLocally(run, registrations).then(
    (result) => {
      // JSON so the output is unambiguous and parseable; `null` for a workflow
      // that returns nothing, rather than the word "undefined".
      console.log(JSON.stringify(result ?? null));
      process.exitCode = 0;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );

  return {
    name,
    roles: [],
    stop: () => Promise.resolve(),
  };
}

/** The namespace a worker entrypoint imports: `Tempo.startWorker({...})`. */
export const Tempo = {startWorker};

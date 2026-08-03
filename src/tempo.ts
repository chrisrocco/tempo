/**
 * @fileoverview
 * ★ WORKER ENTRYPOINT — the single call a deployable worker binary makes.
 *
 * `Tempo.startWorker({name, workflows, activities})` is the distributed-mode
 * counterpart to `createLocalRuntime()`: it wires a `RemoteService` to the poll
 * loops in `worker/`, taking its registries straight from imported module
 * namespaces (`import * as activities from './activities'`). The export name is
 * the registered name, so there is no registration boilerplate.
 *
 * Deployment config is read from the environment, never passed in code, so the
 * same binary is deployable anywhere. The worker binary's full input surface:
 *
 *   TEMPO_SERVER_URL  server to connect to (default http://127.0.0.1:7233)
 *   TEMPO_ROLE        `workflow` | `activity` | unset (unset runs both loops)
 *   TEMPO_TASK_QUEUE  which pool to serve (default `default`)
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
 */

import type { WorkflowFn } from './core';
import { DEFAULT_TASK_QUEUE } from './protocol';
import { createJsonLogger } from './server';
import { createRemoteService } from './services';
import {
  createActivityRegistry,
  createActivityWorker,
  createWorkflowRegistry,
  createWorkflowWorker,
  runActivityWorker,
  runWorkflowWorker,
  type ActivityFn,
  type WorkerLoop,
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

export interface StartWorkerOptions {
  /** Service identity: the unit name, the `tempo status` row, the `tempo logs` target. */
  name: string;
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
  /** Module namespace of workflow functions, keyed by export name. */
  workflows?: object;
  /** Module namespace of activity functions, keyed by export name. */
  activities?: object;
}

export interface Worker {
  readonly name: string;
  /** The roles this process actually started. */
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
 * An explicit `TEMPO_ROLE` is authoritative and must be satisfiable — a worker
 * deployed into a role it cannot serve should fail loudly at startup rather than
 * poll forever for tasks it can never complete. With it unset we run every role
 * the binary has definitions for, so an activities-only worker is legal.
 */
function resolveRoles(
  raw: string | undefined,
  name: string,
  hasWorkflows: boolean,
  hasActivities: boolean,
): WorkerRole[] {
  const requested = raw?.trim();
  if (requested) {
    if (requested !== 'workflow' && requested !== 'activity')
      throw new Error(
        `TEMPO_ROLE must be "workflow" or "activity" (got "${requested}")`,
      );
    const satisfiable = requested === 'workflow' ? hasWorkflows : hasActivities;
    if (!satisfiable)
      throw new Error(
        `worker "${name}" started as TEMPO_ROLE=${requested} but registers no ${requested === 'workflow' ? 'workflows' : 'activities'}`,
      );
    return [requested];
  }

  const roles: WorkerRole[] = [];
  if (hasWorkflows) roles.push('workflow');
  if (hasActivities) roles.push('activity');
  if (roles.length === 0)
    throw new Error(`worker "${name}" registers no workflows or activities`);
  return roles;
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
    return { name: options.name, roles: [], stop: () => Promise.resolve() };
  }

  const roles = resolveRoles(
    process.env['TEMPO_ROLE'],
    options.name,
    workflows.length > 0,
    activities.length > 0,
  );
  const service = createRemoteService(
    process.env['TEMPO_SERVER_URL'] ?? DEFAULT_SERVER_URL,
  );

  // The worker's own lifecycle log, in the same JSON Lines shape the server
  // emits, so one pipeline reads both. A poll failure is the fault most likely
  // to matter here — an unreachable server makes a worker look healthy to its
  // supervisor while doing nothing (planning/tickets/02).
  const taskQueue =
    process.env['TEMPO_TASK_QUEUE'] ?? options.taskQueue ?? DEFAULT_TASK_QUEUE;
  const log = createJsonLogger();
  const onError = (error: unknown, consecutive: number): void => {
    log('worker.poll_failed', {
      worker: options.name,
      consecutive,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const loops: WorkerLoop[] = [];
  if (roles.includes('workflow')) {
    const registry = createWorkflowRegistry();
    for (const [exported, fn] of workflows)
      registry.set(exported, fn as WorkflowFn);
    loops.push(
      runWorkflowWorker(service, createWorkflowWorker(registry), {
        onError,
        taskQueue,
      }),
    );
  }
  if (roles.includes('activity')) {
    const registry = createActivityRegistry();
    for (const [exported, fn] of activities)
      registry.set(exported, fn as ActivityFn);
    loops.push(
      runActivityWorker(service, createActivityWorker(registry), {
        onError,
        taskQueue,
      }),
    );
  }

  let stopping: Promise<void> | undefined;
  const worker: Worker = {
    name: options.name,
    roles,
    stop(): Promise<void> {
      stopping ??= Promise.all(loops.map((loop) => loop.stop())).then(
        () => undefined,
      );
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
export const Tempo = { startWorker };

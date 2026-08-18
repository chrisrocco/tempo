/**
 * @fileoverview
 * createLocalRuntime(): the single-call composition of a LocalService with
 * in-process workers and a client. This is the wiring seam — the one place that
 * knows all the tiers exist and how they connect in single-node mode. Going
 * distributed swaps this file's guts (RemoteService + real worker processes) for
 * the same public shape — the move is not inventing new components, it is
 * promoting these function-call boundaries to process boundaries. Note that
 * `core/` does not move in that promotion; it runs inside the workflow worker
 * either way.
 */

import {createClient, type WorkflowHandle} from './client';
import type {WorkflowFn} from './core';
import type {WorkflowService} from './protocol';
import type {HistoryStore} from './server';
import {createLocalService} from './services';
import {workflowImplOf} from './workflow_registry';
import {
  createActivityRegistry,
  createActivityWorker,
  createWorkflowRegistry,
  createWorkflowWorker,
  type ActivityFn,
} from './worker';

export interface Runtime {
  registerWorkflow(name: string, fn: WorkflowFn): Runtime;
  registerActivity(name: string, fn: ActivityFn): Runtime;
  start<T = unknown>(
    name: string,
    args?: unknown[],
    opts?: {workflowId?: string},
  ): WorkflowHandle<T>;
  /** A handle to an existing execution — e.g. one resumed from a durable store. */
  getHandle<T = unknown>(workflowId: string): WorkflowHandle<T>;
  /** Re-drive persisted executions after a restart. Call after registering types. */
  resume(): Promise<void>;
  /** Stop background timers so the process can exit. */
  shutdown(): void;
  /**
   * The seam this runtime is a composition over.
   *
   * Exposed because anything built *on* `WorkflowService` rather than on a handle —
   * `createScheduleClient`, or any operator tool — otherwise works against a server and
   * not in local mode, which is backwards: local mode is where someone tries a thing
   * first. A remote caller has always been able to get one from `createRemoteService`,
   * so this is the missing half of that symmetry rather than a new kind of access.
   *
   * `start` and `getHandle` above remain the ergonomic path and are unchanged. This is
   * the whole client-facing surface — `signal`, `cancel`, `terminate`, `listExecutions`,
   * `describeExecution` — for callers that need the parts a handle does not expose.
   */
  readonly service: WorkflowService;
}

export interface LocalRuntimeOptions {
  /** Persistence backend. Defaults to in-memory; pass a FileHistoryStore for durability. */
  historyStore?: HistoryStore;
  /**
   * History length at which the server suggests continue-as-new. Defaults to the
   * server default; specs exercising rollover pass a small one.
   */
  continueAsNewSuggestThreshold?: number;
}

export function createLocalRuntime(options: LocalRuntimeOptions = {}): Runtime {
  const workflowRegistry = createWorkflowRegistry();
  const activityRegistry = createActivityRegistry();

  const workflowWorker = createWorkflowWorker(workflowRegistry);
  const activityWorker = createActivityWorker(activityRegistry);

  const service = createLocalService(
    workflowWorker,
    activityWorker,
    options.historyStore,
    options.continueAsNewSuggestThreshold,
  );
  const client = createClient(service);

  const runtime: Runtime = {
    registerWorkflow(name, fn) {
      // Unwrapped, so a `WorkflowRef` handed here registers its body rather
      // than its dispatcher — the engine invoking a reference would be a
      // workflow forever starting itself as its own child. This runtime stays
      // explicit otherwise: nothing registers itself here (see
      // `workflow_registry.ts`), which is what makes it the test seam.
      workflowRegistry.set(name, workflowImplOf(fn) as WorkflowFn);
      return runtime;
    },
    registerActivity(name, fn) {
      activityRegistry.set(name, fn);
      return runtime;
    },
    start<T = unknown>(
      name: string,
      args: unknown[] = [],
      opts: {workflowId?: string} = {},
    ): WorkflowHandle<T> {
      if (!workflowWorker.has(name))
        throw new Error(`no workflow registered as ${name}`);
      return client.start<T>(name, args, opts);
    },
    getHandle<T = unknown>(workflowId: string): WorkflowHandle<T> {
      return client.getHandle<T>(workflowId);
    },
    resume() {
      return service.resume();
    },
    shutdown() {
      service.shutdown();
    },
    service,
  };
  return runtime;
}

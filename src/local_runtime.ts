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

import type { WorkflowFn } from './core';
import type { HistoryStore } from './server';
import {
  createActivityRegistry,
  createActivityWorker,
  createWorkflowRegistry,
  createWorkflowWorker,
  type ActivityFn,
} from './worker';
import { createLocalService } from './services';
import { createClient, type WorkflowHandle } from './client';

export interface Runtime {
  registerWorkflow(name: string, fn: WorkflowFn): Runtime;
  registerActivity(name: string, fn: ActivityFn): Runtime;
  start<T = unknown>(
    name: string,
    args?: unknown[],
    opts?: { workflowId?: string },
  ): WorkflowHandle<T>;
  /** A handle to an existing execution — e.g. one resumed from a durable store. */
  getHandle<T = unknown>(workflowId: string): WorkflowHandle<T>;
  /** Re-drive persisted executions after a restart. Call after registering types. */
  resume(): Promise<void>;
  /** Stop background timers so the process can exit. */
  shutdown(): void;
}

export interface LocalRuntimeOptions {
  /** Persistence backend. Defaults to in-memory; pass a FileHistoryStore for durability. */
  historyStore?: HistoryStore;
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
  );
  const client = createClient(service);

  const runtime: Runtime = {
    registerWorkflow(name, fn) {
      workflowRegistry.set(name, fn);
      return runtime;
    },
    registerActivity(name, fn) {
      activityRegistry.set(name, fn);
      return runtime;
    },
    start<T = unknown>(
      name: string,
      args: unknown[] = [],
      opts: { workflowId?: string } = {},
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
  };
  return runtime;
}

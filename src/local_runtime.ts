// createLocalRuntime(): the single-call composition of a LocalService with
// in-process workers and a client. This is the wiring seam — the one place that
// knows all the tiers exist and how they connect in single-node mode. Going
// distributed swaps this file's guts (RemoteService + real worker processes) for
// the same public shape (doc 06).
import type { WorkflowFn } from './core';
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
  start<T = unknown>(name: string, args?: unknown[], opts?: { workflowId?: string }): WorkflowHandle<T>;
}

export function createLocalRuntime(): Runtime {
  const workflowRegistry = createWorkflowRegistry();
  const activityRegistry = createActivityRegistry();

  const workflowWorker = createWorkflowWorker(workflowRegistry);
  const activityWorker = createActivityWorker(activityRegistry);

  const service = createLocalService(workflowWorker, activityWorker);
  const client = createClient(service);

  const runtime: Runtime = {
    registerWorkflow(name, fn) { workflowRegistry.set(name, fn); return runtime; },
    registerActivity(name, fn) { activityRegistry.set(name, fn); return runtime; },
    start<T = unknown>(name: string, args: unknown[] = [], opts: { workflowId?: string } = {}): WorkflowHandle<T> {
      if (!workflowWorker.has(name)) throw new Error(`no workflow registered as ${name}`);
      return client.start<T>(name, args, opts);
    },
  };
  return runtime;
}

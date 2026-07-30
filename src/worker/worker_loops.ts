/**
 * @fileoverview
 * The worker run-loops: poll a service for a task, do the work, report back,
 * repeat. Written once against `WorkflowService`, so they run against `LocalService`
 * in-proc or a `RemoteService` over RPC — the same worker code either way (docs/architecture/structure-and-layers.md).
 * `bin/*-worker-main` runs these against a RemoteService.
 */

import type { WorkflowService } from '../protocol';
import type { ActivityWorker } from './activity_worker';
import type { WorkflowWorker } from './workflow_worker';

// Ref'd on purpose: a worker process must stay alive between polls. The loops are
// bounded by an explicit stop(), so this never keeps a process alive spuriously.
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export interface WorkerLoop {
  /** Stop polling and wait for the in-flight iteration to finish. */
  stop(): Promise<void>;
}

export interface WorkerLoopOptions {
  /** Backoff when a poll returns no task. */
  pollIntervalMs?: number;
}

export function runWorkflowWorker(
  service: WorkflowService,
  worker: WorkflowWorker,
  options: WorkerLoopOptions = {},
): WorkerLoop {
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      try {
        const task = await service.pollWorkflowTask();
        if (!task) { await sleep(pollIntervalMs); continue; }
        const result = await worker.replayTask(task.name, task.args, task.history, task.continueAsNewSuggested);
        await service.completeWorkflowTask(task.token, result);
      } catch {
        await sleep(pollIntervalMs); // transient (server restart / network) — retry
      }
    }
  })();
  return { stop: async () => { stopped = true; await done; } };
}

export function runActivityWorker(
  service: WorkflowService,
  worker: ActivityWorker,
  options: WorkerLoopOptions = {},
): WorkerLoop {
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      try {
        const task = await service.pollActivityTask();
        if (!task) { await sleep(pollIntervalMs); continue; }
        // One attempt per delivery; the lease redelivers on failure/crash (at-least-once).
        const result = await worker.runTask(task);
        await service.completeActivityTask(task.token, result);
      } catch {
        await sleep(pollIntervalMs); // transient (server restart / network) — retry
      }
    }
  })();
  return { stop: async () => { stopped = true; await done; } };
}

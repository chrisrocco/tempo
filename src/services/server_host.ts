/**
 * @fileoverview
 * The distributed server, headless: `server_core` + the in-memory ports + the
 * timer service, exposing the operations the RPC layer serves. It runs NO
 * workers and NO user code — workflow + activity workers poll it from other
 * processes. Client writes (start/signal/cancel) mutate the store + enqueue
 * tasks; `getOutcome` reads the store (the client polls it). This is what
 * `bin/server-main` will host over RPC.
 */

import type {
  ActivityResult,
  LeasedActivityTask,
  StartWorkflowOptions,
  TaskToken,
  WorkflowOutcome,
  WorkflowTask,
  WorkflowTaskResult,
} from '../protocol';
import {
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
  MemoryHistoryStore,
  type HistoryStore,
} from '../server';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ServerHost {
  start(
    name: string,
    args?: unknown[],
    opts?: StartWorkflowOptions,
  ): { workflowId: string };
  signal(
    workflowId: string,
    signalName: string,
    payload: unknown,
  ): Promise<void>;
  cancel(workflowId: string): Promise<void>;
  getOutcome(workflowId: string): Promise<WorkflowOutcome>;
  pollWorkflowTask(): Promise<WorkflowTask | undefined>;
  completeWorkflowTask(
    token: TaskToken,
    result: WorkflowTaskResult,
  ): Promise<void>;
  pollActivityTask(): Promise<LeasedActivityTask | undefined>;
  completeActivityTask(token: TaskToken, result: ActivityResult): Promise<void>;
  /** Re-drive persisted executions after a restart. */
  resume(): Promise<void>;
  /** Stop background timers so the process can exit. */
  shutdown(): void;
}

export interface ServerHostOptions {
  /** Lease timeout for workflow tasks (ms). Default 30s. */
  workflowLeaseMs?: number;
  /** Lease timeout for activity tasks (ms). Default 30s. A short value forces redelivery. */
  activityLeaseMs?: number;
}

export function createServerHost(
  historyStore: HistoryStore = new MemoryHistoryStore(),
  options: ServerHostOptions = {},
): ServerHost {
  const workflowTaskQueue = new MemoryWorkflowTaskQueue(
    options.workflowLeaseMs,
  );
  const activityTaskQueue = new MemoryTaskQueue(options.activityLeaseMs);
  const timerService = new MemoryTimerService();
  let counter = 0;

  const core = createServerCore({
    historyStore,
    workflowTaskQueue,
    activityTaskQueue,
    timerService,
    launch,
    // No in-proc workers to nudge — remote workers poll on their own cadence.
    kickWorkflowWorker: () => {},
    kickActivityWorker: () => {},
  });
  timerService.recover();

  function createAndEnqueue(
    workflowId: string,
    name: string,
    args: unknown[],
  ): void {
    void historyStore
      .create(workflowId, name, args)
      .then(() => workflowTaskQueue.enqueue(workflowId));
  }

  function launch(name: string, args: unknown[]): string {
    const workflowId = `${name}-${++counter}`;
    createAndEnqueue(workflowId, name, args);
    return workflowId;
  }

  return {
    start(name, args = [], opts = {}) {
      const workflowId = opts.workflowId ?? `${name}-${++counter}`;
      createAndEnqueue(workflowId, name, args);
      return { workflowId };
    },
    signal(workflowId, signalName, payload) {
      return core.appendSignal(workflowId, signalName, payload);
    },
    cancel(workflowId) {
      return core.requestCancel(workflowId);
    },
    async getOutcome(workflowId) {
      const rec = await historyStore.get(workflowId);
      if (!rec) return { status: 'running' }; // not created yet — client keeps polling
      return {
        status: rec.status,
        result: rec.result,
        failure:
          rec.status === 'failed' ? errorMessage(rec.failure) : undefined,
      };
    },
    pollWorkflowTask() {
      return core.pollWorkflowTask();
    },
    completeWorkflowTask(token, result) {
      return core.completeWorkflowTask(token, result);
    },
    pollActivityTask() {
      return core.pollActivityTask();
    },
    completeActivityTask(token, result) {
      return core.completeActivityTask(token, result);
    },
    async resume() {
      await core.resumeFromHistory(await historyStore.list());
    },
    shutdown() {
      timerService.stop();
    },
  };
}

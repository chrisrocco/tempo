/**
 * @fileoverview
 * The distributed server, headless: `server_core` + the in-memory ports + the
 * timer service, exposing the operations the RPC layer serves. It runs NO
 * workers and NO user code — workflow + activity workers poll it from other
 * processes. Client writes (start/signal/cancel) mutate the store + enqueue
 * tasks; `getOutcome` reads the store (the client polls it). This is what
 * `bin/server-main` hosts over RPC.
 *
 * This is the only stateful tier, and the split is what makes the system scale:
 * workers are stateless and scale horizontally against one of these, while the
 * server owns history, queues, and timers. It is correspondingly the single
 * writer and a single point of failure — server HA (failover, multi-writer) is
 * Phase 6 and not built.
 */

import { DEFAULT_TASK_QUEUE } from '../protocol';
import type {
  ActivityResult,
  ExecutionDetail,
  ExecutionSummary,
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
  describeExecution,
  silentLogger,
  summarizeExecution,
  MemoryHistoryStore,
  type HistoryStore,
  type Logger,
} from '../server';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The largest trailing `-<n>` across existing ids — how far the generator must
 * be advanced so a restart cannot reissue an id.
 *
 * It reads ids rather than persisting the counter, which is deliberate: the store
 * is the only thing that survives a restart, and the ids in it are the actual
 * constraint. A separately persisted counter would be a second source of truth
 * that could disagree with the executions themselves. Ids the *client* supplied
 * may also end in `-<n>` and will be counted; overshooting costs nothing, while
 * undershooting collides.
 */
function highestGeneratedSuffix(records: { workflowId: string }[]): number {
  let highest = 0;
  for (const { workflowId } of records) {
    const match = /-(\d+)$/.exec(workflowId);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
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
  terminate(workflowId: string, reason: string): Promise<void>;
  getOutcome(workflowId: string): Promise<WorkflowOutcome>;
  describeExecution(workflowId: string): Promise<ExecutionDetail | undefined>;
  listExecutions(): Promise<ExecutionSummary[]>;
  pollWorkflowTask(taskQueue?: string): Promise<WorkflowTask | undefined>;
  completeWorkflowTask(
    token: TaskToken,
    result: WorkflowTaskResult,
  ): Promise<void>;
  failWorkflowTask(token: TaskToken, reason: string): Promise<void>;
  pollActivityTask(taskQueue?: string): Promise<LeasedActivityTask | undefined>;
  completeActivityTask(token: TaskToken, result: ActivityResult): Promise<void>;
  heartbeatActivityTask(token: TaskToken): Promise<void>;
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
  /** Where lifecycle events go. Defaults to silence; `bin/server-main` supplies a JSON logger. */
  log?: Logger;
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
  const log = options.log ?? silentLogger;
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
    log,
  });
  timerService.recover();

  function createAndEnqueue(
    workflowId: string,
    name: string,
    args: unknown[],
    taskQueue: string,
  ): void {
    void historyStore
      .create(workflowId, name, args, taskQueue)
      .then(() => {
        workflowTaskQueue.enqueue(workflowId, taskQueue);
        log('execution.started', { workflowId, name, taskQueue });
      })
      // `create` rejects an id that already exists, and this is a floating
      // promise: without a handler that reject is an unhandled rejection, which
      // Node treats as fatal. A duplicate start must never be able to take the
      // server down — it is a client-visible error at worst.
      .catch((error: unknown) => {
        log('execution.start_rejected', {
          workflowId,
          name,
          error: errorMessage(error),
        });
      });
  }

  function launch(
    workflowId: string,
    name: string,
    args: unknown[],
    taskQueue: string,
  ): void {
    createAndEnqueue(workflowId, name, args, taskQueue);
  }

  return {
    start(name, args = [], opts = {}) {
      const workflowId = opts.workflowId ?? `${name}-${++counter}`;
      createAndEnqueue(
        workflowId,
        name,
        args,
        opts.taskQueue ?? DEFAULT_TASK_QUEUE,
      );
      return { workflowId };
    },
    signal(workflowId, signalName, payload) {
      return core.appendSignal(workflowId, signalName, payload);
    },
    cancel(workflowId) {
      return core.requestCancel(workflowId);
    },
    terminate(workflowId, reason) {
      return core.terminate(workflowId, reason);
    },
    async getOutcome(workflowId) {
      const rec = await historyStore.get(workflowId);
      if (!rec) return { status: 'running' }; // not created yet — client keeps polling
      return {
        status: rec.status,
        result: rec.result,
        // Both non-success terminal states carry a reason: 'failed' the error the
        // workflow raised, 'terminated' why the operator ended it.
        failure:
          rec.status === 'failed' || rec.status === 'terminated'
            ? errorMessage(rec.failure)
            : undefined,
      };
    },
    async describeExecution(workflowId) {
      const rec = await historyStore.get(workflowId);
      return rec && describeExecution(rec);
    },
    async listExecutions() {
      return (await historyStore.list()).map(summarizeExecution);
    },
    pollWorkflowTask(taskQueue) {
      return core.pollWorkflowTask(taskQueue);
    },
    completeWorkflowTask(token, result) {
      return core.completeWorkflowTask(token, result);
    },
    failWorkflowTask(token, reason) {
      return core.failWorkflowTask(token, reason);
    },
    pollActivityTask(taskQueue) {
      return core.pollActivityTask(taskQueue);
    },
    completeActivityTask(token, result) {
      return core.completeActivityTask(token, result);
    },
    heartbeatActivityTask(token) {
      return core.heartbeatActivityTask(token);
    },
    async resume() {
      const records = await historyStore.list();
      // Seed the id counter past everything already on disk. It restarts at zero
      // on boot, so without this the next generated id repeats one the previous
      // boot handed out, and `create` rejects it. Children no longer rely on the
      // counter (their ids are derived from lineage), but a client that starts a
      // workflow without naming it still does.
      counter = Math.max(counter, highestGeneratedSuffix(records));
      await core.resumeFromHistory(records);
    },
    shutdown() {
      timerService.stop();
    },
  };
}

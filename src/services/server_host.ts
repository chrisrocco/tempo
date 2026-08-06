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

import type {
  ActivityResult,
  DescribeOptions,
  ExecutionDetail,
  ExecutionFilter,
  ExecutionGroups,
  ExecutionPage,
  LeasedActivityTask,
  QueueWorkers,
  ServerHealth,
  StartResult,
  StartWorkflowOptions,
  TaskToken,
  WorkflowOutcome,
  WorkflowTask,
  WorkflowTaskResult,
} from '../protocol';
import {DEFAULT_TASK_QUEUE} from '../protocol';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
  describeExecution,
  groupExecutions,
  queryExecutions,
  silentLogger,
  type ExecutionParent,
  type ExecutionRecord,
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
function highestGeneratedSuffix(records: {workflowId: string}[]): number {
  let highest = 0;
  for (const {workflowId} of records) {
    const match = /-(\d+)$/.exec(workflowId);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

export interface ServerHost {
  /**
   * Start an execution, or claim an id that already names one.
   *
   * Async where `WorkflowService.start` is not, and that difference is the point:
   * this one waits to find out whether it created anything, so an RPC caller
   * learns which happened. The in-process seam cannot wait — see `StartResult`.
   */
  start(
    name: string,
    args?: unknown[],
    opts?: StartWorkflowOptions,
  ): Promise<StartResult>;
  signal(
    workflowId: string,
    signalName: string,
    payload: unknown,
  ): Promise<void>;
  cancel(workflowId: string): Promise<void>;
  terminate(workflowId: string, reason: string): Promise<void>;
  /** Truncate an execution's history to `keep` events and replay from there. */
  reset(workflowId: string, keep: number): void;
  getOutcome(workflowId: string): Promise<WorkflowOutcome>;
  describeExecution(
    workflowId: string,
    options?: DescribeOptions,
  ): Promise<ExecutionDetail | undefined>;
  listExecutions(filter?: ExecutionFilter): Promise<ExecutionPage>;
  /**
   * Liveness and what this server is, for a status command or a supervisor.
   *
   * Synchronous, and that is a claim rather than an oversight: everything it
   * reports is already in memory, so a probe cannot be made to hang by the same
   * store trouble it exists to reveal. Anything that would need to be awaited
   * does not belong on it — see `ServerHealth`.
   */
  health(): ServerHealth;
  /** Which task queues are being polled, and when each was last asked. */
  listQueues(): Promise<QueueWorkers[]>;
  /** Every execution counted by status, grouped by task queue and by name. */
  groupExecutions(): Promise<ExecutionGroups>;
  pollWorkflowTask(
    taskQueue?: string,
    identity?: string,
  ): Promise<WorkflowTask | undefined>;
  completeWorkflowTask(
    token: TaskToken,
    result: WorkflowTaskResult,
  ): Promise<void>;
  failWorkflowTask(token: TaskToken, reason: string): Promise<void>;
  pollActivityTask(
    taskQueue?: string,
    identity?: string,
  ): Promise<LeasedActivityTask | undefined>;
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
  // Read once, at construction, so uptime measures this host rather than the
  // moment someone happened to ask about it.
  const startedAt = Date.now();

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

  /**
   * Create the execution, or report that the id was already claimed.
   *
   * An id already in use is not an error — see `StartWorkflowOptions.workflowId`.
   * A caller-chosen id names something in the world, so a second start under it
   * is deduplication working, and the caller gets the execution that holds the
   * id back.
   *
   * What it *is* is worth recording. `sameRequest` says whether the second call
   * asked for the same thing; when it did not, the caller's arguments were
   * discarded and that is a bug in the caller. The engine will not arbitrate it —
   * the two starts are equally entitled to the name — but it will not hide it
   * either.
   *
   * The existence check runs first because that is the ordinary path for a
   * dedupe key, and it mirrors what `applyCommand` already does for a child's
   * claimed id. The `catch` handles the narrow race where two starts both look
   * before either writes: the loser of `create` finds the record on the recheck
   * and takes the same claim path. A `create` that failed for any other reason
   * has no record to find, and that error reaches the caller.
   */
  async function createAndEnqueue(
    workflowId: string,
    name: string,
    args: unknown[],
    taskQueue: string,
    parent?: ExecutionParent,
  ): Promise<boolean> {
    const claimed = (existing: ExecutionRecord): false => {
      log('execution.start_reused', {
        workflowId,
        name,
        sameRequest:
          existing.name === name &&
          JSON.stringify(existing.args) === JSON.stringify(args),
      });
      return false;
    };

    const existing = await historyStore.get(workflowId);
    if (existing) return claimed(existing);

    try {
      await historyStore.create(workflowId, name, args, taskQueue, parent);
    } catch (error: unknown) {
      const raced = await historyStore.get(workflowId);
      if (!raced) throw error;
      return claimed(raced);
    }

    workflowTaskQueue.enqueue(workflowId, taskQueue);
    log('execution.started', {workflowId, name, taskQueue});
    return true;
  }

  /**
   * The core's hook for dispatching a child. Stays fire-and-forget because the
   * core cannot wait — it is mid-way through applying a command batch — and
   * because a child's id is already claim-checked by `applyCommand` before this
   * is reached. The `catch` is what stops a store failure here from becoming an
   * unhandled rejection, which Node treats as fatal.
   */
  function launch(
    workflowId: string,
    name: string,
    args: unknown[],
    taskQueue: string,
    parent: ExecutionParent,
  ): void {
    void createAndEnqueue(workflowId, name, args, taskQueue, parent).catch(
      (error: unknown) => {
        log('execution.start_failed', {
          workflowId,
          name,
          error: errorMessage(error),
        });
      },
    );
  }

  return {
    async start(name, args = [], opts = {}) {
      const workflowId = opts.workflowId ?? `${name}-${++counter}`;
      const created = await createAndEnqueue(
        workflowId,
        name,
        args,
        opts.taskQueue ?? DEFAULT_TASK_QUEUE,
      );
      return {workflowId, created};
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
    reset(workflowId, keep) {
      // Fire-and-forget like the other controls on this seam: the effect is
      // visible in the execution's own state, which is what a caller reads next.
      void core.resetToEvent(workflowId, keep).catch((error: unknown) => {
        log('execution.reset_failed', {
          workflowId,
          keep,
          error: errorMessage(error),
        });
      });
    },
    async getOutcome(workflowId) {
      const rec = await historyStore.get(workflowId);
      if (!rec) return {status: 'running'}; // not created yet — client keeps polling
      return {
        status: rec.status,
        result: rec.result,
        // Both non-success terminal states carry a reason: 'failed' the error the
        // workflow raised, 'terminated' why the operator ended it.
        failure:
          rec.status === 'failed' || rec.status === 'terminated'
            ? errorMessage(rec.failure)
            : undefined,
        failureStack: rec.status === 'failed' ? rec.failureStack : undefined,
      };
    },
    async describeExecution(workflowId, options) {
      const rec = await historyStore.get(workflowId);
      return rec && describeExecution(rec, options);
    },
    async listExecutions(filter) {
      return queryExecutions(await historyStore.list(), filter);
    },
    health() {
      // Durability is read off the store rather than tracked here: the store is
      // the thing that either survives a restart or does not.
      return {
        uptimeMs: Date.now() - startedAt,
        durable: historyStore.durable,
        ...(historyStore.location === undefined
          ? {}
          : {dataLocation: historyStore.location}),
      };
    },
    async listQueues() {
      return core.listQueues();
    },
    async groupExecutions() {
      return groupExecutions(await historyStore.list());
    },
    pollWorkflowTask(taskQueue, identity) {
      return core.pollWorkflowTask(taskQueue, identity);
    },
    completeWorkflowTask(token, result) {
      return core.completeWorkflowTask(token, result);
    },
    failWorkflowTask(token, reason) {
      return core.failWorkflowTask(token, reason);
    },
    pollActivityTask(taskQueue, identity) {
      return core.pollActivityTask(taskQueue, identity);
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
      // See `LocalService.shutdown`: workflow timers and retry backoffs live in
      // different places and both are ref'd.
      core.stop();
    },
  };
}

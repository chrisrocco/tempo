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
  PollRequest,
  QueueWorkers,
  WorkflowReportRequest,
  WorkflowSummary,
  ServerEndpoint,
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
  expiredExecutions,
  groupExecutions,
  queryExecutions,
  silentLogger,
  trailingIdSuffix,
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
 *
 * Retention carved one exception out of that argument: a swept id is a
 * constraint the store no longer lists, so `resume` also seeds past the store's
 * `highestDeletedSuffix` — the one number `delete` keeps durably for exactly
 * this read. Without it, a restart after a sweep would mint a second
 * `greeter-9` that every log line and bookmark conflates with the first.
 */
function highestGeneratedSuffix(records: {workflowId: string}[]): number {
  let highest = 0;
  for (const {workflowId} of records)
    highest = Math.max(highest, trailingIdSuffix(workflowId));
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
  /** Every workflow the live fleet reports, deduped by name. See `WorkflowService`. */
  listWorkflows(): Promise<WorkflowSummary[]>;
  /** Record what a worker says it has registered. */
  reportWorkflows(report: WorkflowReportRequest): Promise<void>;
  /** Every execution counted by status, grouped by task queue and by name. */
  groupExecutions(): Promise<ExecutionGroups>;
  pollWorkflowTask(request?: PollRequest): Promise<WorkflowTask | undefined>;
  completeWorkflowTask(
    token: TaskToken,
    result: WorkflowTaskResult,
  ): Promise<void>;
  failWorkflowTask(token: TaskToken, reason: string): Promise<void>;
  pollActivityTask(
    request?: PollRequest,
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
  /**
   * How long a closed execution is kept before the retention sweep deletes it —
   * record, history, and outcome. **Unset means keep forever**, which is the
   * only correct default: how long a result stays claimable is a contract with
   * this deployment's clients, and it should be stated at the launch site
   * rather than defaulted invisibly. `--retain-closed-for-ms` overrides via
   * `startServer`.
   *
   * Setting it changes two documented behaviors, both deliberately and both
   * only after the window:
   *
   * - **A result is claimable only within retention.** `getOutcome` reads a
   *   missing record as "not created yet" (see `getOutcome`), so a client that
   *   first polls for a result after the execution was swept waits forever.
   *   Pick a window comfortably longer than the longest a caller waits before
   *   collecting.
   * - **A `workflowId` claim lasts only as long as the record.** Starting under
   *   a swept id creates a fresh execution where it used to return the old one
   *   — "one workflow per order" becomes "one per order per window". See
   *   `StartWorkflowOptions.workflowId`.
   *
   * Running executions are never swept, however old, and a settled child is
   * held past the window while a running parent has yet to consume its outcome
   * — the recovery in `resume()` needs the child's record to synthesize it.
   * See `expiredExecutions`, which is the whole of the eligibility rule.
   */
  retainClosedForMs?: number;
  /**
   * How often the retention sweep runs (ms). Default one minute — the scan is
   * over the in-memory cache and is cheap next to any plausible window.
   * Injectable so a spec exercising retention can use a small one, the same
   * reason `continueAsNewSuggestThreshold` is. Ignored when `retainClosedForMs`
   * is unset: no window, no sweep, no timer.
   */
  retentionSweepIntervalMs?: number;
  /** Where lifecycle events go. Defaults to silence; `bin/server-main` supplies a JSON logger. */
  log?: Logger;
  /**
   * Where the transport in front of this host is bound, for `health()` to
   * report. See `ServerEndpoint`.
   *
   * **A function, because of an ordering this tier cannot escape.** The host is
   * built before anything binds — it has to be, since `resume()` re-drives
   * persisted executions *before* the port opens, so that nothing observes a
   * server listening and not yet remembering what it was doing. There is no port
   * to hand it at construction, and a value passed here could only ever be the
   * one the caller asked for rather than the one it got, which under `--port=0`
   * is the whole question.
   *
   * Returning `undefined` is the honest answer while nothing has bound, and the
   * permanent one for a host with no transport at all. This host does not listen
   * on anything itself and will not invent an endpoint for itself.
   */
  endpoint?: () => ServerEndpoint | undefined;
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
   * Delete what `expiredExecutions` allows, one at a time, loudly. Serial
   * because deletes are I/O on the durable store and a sweep is in no hurry;
   * logged per execution because a deletion is a fact an operator may go
   * looking for — "where did my run go" should be answerable from the log.
   */
  async function sweepExpired(): Promise<void> {
    const cutoff = Date.now() - options.retainClosedForMs!;
    for (const rec of expiredExecutions(await historyStore.list(), cutoff)) {
      // The in-process half of the id floor — the store keeps the durable half
      // on `delete` — so a generated id cannot be reissued even before restart.
      counter = Math.max(counter, trailingIdSuffix(rec.workflowId));
      await historyStore.delete(rec.workflowId);
      log('execution.swept', {
        workflowId: rec.workflowId,
        name: rec.name,
        status: rec.status,
      });
    }
  }

  // Unref'd like the reporter's timer: the sweep produces no work and owes
  // nobody an outcome, so it must not be the reason a process refuses to exit.
  // A tick that overlaps a still-running sweep is skipped rather than stacked.
  let sweeping = false;
  const sweepTimer =
    options.retainClosedForMs === undefined
      ? undefined
      : setInterval(() => {
          if (sweeping) return;
          sweeping = true;
          void sweepExpired()
            .catch((error: unknown) => {
              log('execution.sweep_failed', {error: errorMessage(error)});
            })
            .finally(() => {
              sweeping = false;
            });
        }, options.retentionSweepIntervalMs ?? 60_000);
  sweepTimer?.unref?.();

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
    parent: ExecutionParent | undefined,
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
      // Not created yet — client keeps polling. Under retention this reading
      // has a second face: a swept execution is also "missing", so its result
      // is claimable only within the window. See
      // `ServerHostOptions.retainClosedForMs`, which owns that contract.
      if (!rec) return {status: 'running'};
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
        // Spreading `undefined` contributes nothing, which is exactly the shape
        // wanted for a host nothing has bound: absent fields rather than four
        // keys holding `undefined`, so `Object.keys` on the reply says what the
        // server actually knows about itself.
        ...options.endpoint?.(),
      };
    },
    async listWorkflows() {
      return core.listWorkflows();
    },
    async reportWorkflows(report) {
      core.reportWorkflows(report);
    },
    async listQueues() {
      return core.listQueues();
    },
    async groupExecutions() {
      return groupExecutions(await historyStore.list());
    },
    pollWorkflowTask(request) {
      return core.pollWorkflowTask(request);
    },
    completeWorkflowTask(token, result) {
      return core.completeWorkflowTask(token, result);
    },
    failWorkflowTask(token, reason) {
      return core.failWorkflowTask(token, reason);
    },
    pollActivityTask(request) {
      return core.pollActivityTask(request);
    },
    completeActivityTask(token, result) {
      return core.completeActivityTask(token, result);
    },
    heartbeatActivityTask(token) {
      return core.heartbeatActivityTask(token);
    },
    async resume() {
      const records = await historyStore.list();
      // Seed the id counter past everything already on disk — and past what a
      // sweep deleted from it, which `list()` can no longer show (see
      // `highestGeneratedSuffix`). It restarts at zero on boot, so without this
      // the next generated id repeats one the previous boot handed out, and
      // `create` rejects it (or, for a swept id, silently reissues it).
      // Children no longer rely on the counter (their ids are derived from
      // lineage), but a client that starts a workflow without naming it still
      // does.
      counter = Math.max(
        counter,
        highestGeneratedSuffix(records),
        historyStore.highestDeletedSuffix,
      );
      await core.resumeFromHistory(records);
      // After the re-drive, deliberately: resume is what appends a settled
      // child's outcome to a parent that missed it, and sweeping first would
      // race the very guard `expiredExecutions` keeps for that case.
      if (options.retainClosedForMs !== undefined) await sweepExpired();
    },
    shutdown() {
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
      timerService.stop();
      // See `LocalService.shutdown`: workflow timers and retry backoffs live in
      // different places and both are ref'd.
      core.stop();
    },
  };
}

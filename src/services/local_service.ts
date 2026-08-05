/**
 * @fileoverview
 * LocalService: the whole server in-process. It composes `server_core` with the
 * in-memory ports and runs the two worker poll loops in-proc — a workflow-worker
 * loop that drains the workflow-task queue (replacing the old `pump`+`kick`) and
 * an activity-worker loop that drains the activity-task queue. Distributed mode
 * runs those same loops in separate processes against `RemoteService`.
 *
 * ## The loops go through the worker-facing seam, deliberately
 *
 * Both drain loops call `pollWorkflowTask`/`completeWorkflowTask` (and the
 * activity pair) — the same methods a remote worker calls over RPC — rather than
 * reaching past them to `buildWorkflowTask`/`applyWorkflowTaskResult`. It costs
 * nothing here and buys the thing this service claims to be: leasing and the
 * optimistic version check now run on every local task, so the always-on fast
 * suite actually covers the concurrency control it is meant to be a regression
 * net for. While the loops bypassed the seam, `workflowLeases` was never
 * populated in local mode and the version check ran only in the distributed
 * specs — the fast net had a hole exactly where the subtle bugs live.
 *
 * Polling through the seam is `async`, which reopens a lost-wakeup window the old
 * synchronous loop condition closed by construction: a wake can land after the
 * final poll saw an empty queue but before `draining` is cleared, and it would
 * find `draining === true` and decline to start a sweep. The `pending` flag
 * closes it — the same coalescing shape the workflow-task queue itself uses. Any
 * kick arriving mid-drain sets it, the `do/while` sweeps once more, and it is
 * read and `draining` cleared with no await between, so nothing can interleave
 * in that gap.
 *
 * In-proc bookkeeping stays synchronous: `statusMirror` backs the sync `getStatus`
 * (updated after each task), and `waiters` back `getResult`. Both are rebuilt by
 * `resume`, not persisted.
 *
 * ## The caveat that keeps the abstraction honest
 *
 * `LocalService` and `RemoteService` are **not** behaviorally identical. Local is
 * effectively exactly-once and synchronous-ish; remote is at-least-once, with
 * redelivery, retries, and latency. The service seam unifies the *code path*, not
 * the *failure semantics*. Keep this one for the fast inner loop, but run a subset
 * of integration tests against a real server (`spec/integration/remote.spec.ts`,
 * `spec/integration/distributed.spec.ts`) to exercise duplicate execution and
 * non-idempotent effects. Pretending the two are the same is how you ship an
 * activity that double-charges a card.
 */

import type {
  ActivityResult,
  ExecutionStatus,
  LeasedActivityTask,
  StartWorkflowOptions,
  TaskToken,
  WorkflowService,
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
  type ExecutionParent,
  type HistoryStore,
} from '../server';
import type {ActivityWorker, WorkflowWorker} from '../worker';

interface ResultWaiter {
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  settled: boolean;
}

/** WorkflowService plus the local-only boot/teardown hooks (not part of the seam). */
export interface LocalService extends WorkflowService {
  /** Re-drive persisted executions after a restart (crash recovery). */
  resume(): Promise<void>;
  /** Stop background timers so the process can exit (graceful shutdown). */
  shutdown(): void;
}

export function createLocalService(
  workflowWorker: WorkflowWorker,
  activityWorker: ActivityWorker,
  historyStore: HistoryStore = new MemoryHistoryStore(),
  continueAsNewSuggestThreshold?: number,
): LocalService {
  const workflowTaskQueue = new MemoryWorkflowTaskQueue();
  const activityTaskQueue = new MemoryTaskQueue();
  const timerService = new MemoryTimerService();

  const statusMirror = new Map<string, ExecutionStatus>();
  const waiters = new Map<string, ResultWaiter>();
  let counter = 0;

  const core = createServerCore({
    historyStore,
    workflowTaskQueue,
    activityTaskQueue,
    timerService,
    // The core supplies the child's id; it is derived from lineage so it stays
    // stable across a restart (see `server_core.childExecutionId`).
    launch: (workflowId, name, args, taskQueue, parent) => {
      launch(name, args, {workflowId, taskQueue}, parent);
    },
    kickWorkflowWorker,
    kickActivityWorker,
    continueAsNewSuggestThreshold,
  });

  // Startup sweep: re-arm persisted timers on boot (no-op on a fresh in-memory table).
  timerService.recover();

  // In-proc workflow worker: drain the workflow-task queue, replaying + applying.
  let wfDraining = false;
  let wfPending = false;
  function kickWorkflowWorker(): void {
    if (wfDraining) {
      wfPending = true; // a wake landed mid-drain — sweep once more
      return;
    }
    wfDraining = true;
    void (async () => {
      try {
        do {
          wfPending = false;
          while (true) {
            const task = await core.pollWorkflowTask();
            if (!task) break;
            let result;
            try {
              result = await workflowWorker.replayTask(
                task.name,
                task.args,
                task.history,
                task.continueAsNewSuggested,
                task.carryover,
              );
            } catch (e) {
              // Same contract as the out-of-process loop: report, do not throw.
              // Letting this escape would reject the drain's floating promise
              // (an unhandled rejection) and leave the task leased until expiry.
              await core.failWorkflowTask(
                task.token,
                e instanceof Error ? e.message : String(e),
              );
              continue;
            }
            // Applies behind the version check, so a result built on a snapshot
            // that something appended to mid-replay is discarded — and the wake
            // that appended it is what re-enqueues the execution.
            await core.completeWorkflowTask(task.token, result);
            const rec = await historyStore.get(task.workflowId);
            if (rec) {
              statusMirror.set(task.workflowId, rec.status);
              if (rec.status !== 'running')
                settleTerminal(
                  task.workflowId,
                  rec.status,
                  rec.result,
                  rec.failure,
                );
            }
          }
        } while (wfPending);
      } finally {
        wfDraining = false;
      }
    })();
  }

  // In-proc activity worker: drain the activity-task queue, running one attempt
  // per task and reporting back. The workflow stays parked the whole time, and
  // whether a failure is retried is the server's call, not this loop's.
  let actDraining = false;
  let actPending = false;
  function kickActivityWorker(): void {
    if (actDraining) {
      actPending = true;
      return;
    }
    actDraining = true;
    void (async () => {
      try {
        do {
          actPending = false;
          while (true) {
            const task = await core.pollActivityTask();
            if (!task) break;
            // One attempt per delivery, exactly like the out-of-process loop.
            // Retry is the server's decision now, so both modes get the same
            // policy from the same code — and the attempt count survives this
            // process dying, which an in-loop retry never could.
            const result = await activityWorker.runTask(task, () => {
              void core.heartbeatActivityTask(task.token);
            });
            await core.completeActivityTask(task.token, result); // acks + reports
          }
        } while (actPending);
      } finally {
        actDraining = false;
      }
    })();
  }

  function ensureWaiter(workflowId: string): ResultWaiter {
    let w = waiters.get(workflowId);
    if (!w) {
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Voided: attaching this catch IS the point — it stops an unobserved
      // rejection becoming an unhandledRejection if getResult is never awaited.
      void promise.catch(() => {});
      w = {promise, resolve, reject, settled: false};
      waiters.set(workflowId, w);
    }
    return w;
  }

  function rejectWaiter(workflowId: string, error: unknown): void {
    const w = ensureWaiter(workflowId);
    if (w.settled) return;
    w.settled = true;
    w.reject(error);
  }

  function settleTerminal(
    workflowId: string,
    status: ExecutionStatus,
    result: unknown,
    failure: unknown,
  ): void {
    const w = ensureWaiter(workflowId);
    if (w.settled) return;
    w.settled = true;
    if (status === 'completed') w.resolve(result);
    else w.reject(failure);
  }

  /**
   * `parent` is not part of `StartWorkflowOptions` on purpose: a client does not
   * get to declare itself the child of something. Only the core passes it, when
   * it is dispatching a `startChild`.
   */
  function launch(
    name: string,
    args: unknown[],
    opts: StartWorkflowOptions = {},
    parent?: ExecutionParent,
  ): string {
    // Unlike the remote host this already had a `.catch`, so a duplicate id
    // rejects the caller's `getResult` rather than escaping as an unhandled
    // rejection — an error someone sees, not a dead process.
    const workflowId = opts.workflowId ?? `${name}-${++counter}`;
    const taskQueue = opts.taskQueue ?? DEFAULT_TASK_QUEUE;
    statusMirror.set(workflowId, 'running');
    ensureWaiter(workflowId);
    void historyStore
      .create(workflowId, name, args, taskQueue, parent)
      .then(() => {
        workflowTaskQueue.enqueue(workflowId, taskQueue);
        kickWorkflowWorker();
      })
      .catch((err) => rejectWaiter(workflowId, err));
    return workflowId;
  }

  return {
    start(name, args = [], opts = {}) {
      return {workflowId: launch(name, args, opts)};
    },
    signal(workflowId, signalName, payload) {
      if (!statusMirror.has(workflowId))
        throw new Error(`no execution ${workflowId}`);
      void core.appendSignal(workflowId, signalName, payload); // appends + wakes
    },
    cancel(workflowId) {
      if (!statusMirror.has(workflowId))
        throw new Error(`no execution ${workflowId}`);
      void core.requestCancel(workflowId);
    },
    terminate(workflowId, reason) {
      if (!statusMirror.has(workflowId))
        throw new Error(`no execution ${workflowId}`);
      void core.terminate(workflowId, reason).then(() => {
        // No task follows a terminate — it settles the record directly — so the
        // drain loop will never observe this one. Settle the local waiter here.
        statusMirror.set(workflowId, 'terminated');
        rejectWaiter(workflowId, new Error(reason));
      });
    },
    reset(workflowId, keep) {
      if (!statusMirror.has(workflowId))
        throw new Error(`no execution ${workflowId}`);
      // Unlike terminate, a reset *does* produce a task, so the drain loop
      // observes the execution again and settles the waiter the normal way.
      //
      // The mirror is put back by hand because the core reopens the record
      // directly: without this, `getStatus` would keep reporting the outcome of
      // a run whose history has just been discarded. A `getResult` promise that
      // already settled stays settled — a caller holding one took delivery of an
      // answer, and this cannot un-deliver it.
      statusMirror.set(workflowId, 'running');
      void core.resetToEvent(workflowId, keep);
    },
    getResult(workflowId) {
      return ensureWaiter(workflowId).promise;
    },
    getStatus(workflowId): ExecutionStatus {
      return statusMirror.get(workflowId) ?? 'running';
    },
    // Inspection reads the store, not `statusMirror`: the mirror exists to make
    // `getStatus` synchronous, while these are already async and the store is the
    // truth. One fewer thing that can disagree with history.
    async describeExecution(workflowId, options) {
      const rec = await historyStore.get(workflowId);
      return rec && describeExecution(rec, options);
    },
    async listExecutions(filter) {
      return queryExecutions(await historyStore.list(), filter);
    },
    async groupExecutions() {
      return groupExecutions(await historyStore.list());
    },
    async listQueues() {
      // Under the in-process runtime this reports one entry, `ANY_TASK_QUEUE`,
      // because `createLocalRuntime`'s loops poll with no queue at all — one
      // set of loops there serves every execution however it was routed.
      return core.listQueues();
    },
    // ── worker-facing seam (for out-of-process workers; unused by the in-proc loops) ──
    pollWorkflowTask(taskQueue?: string): Promise<WorkflowTask | undefined> {
      return core.pollWorkflowTask(taskQueue);
    },
    completeWorkflowTask(
      token: TaskToken,
      result: WorkflowTaskResult,
    ): Promise<void> {
      return core.completeWorkflowTask(token, result);
    },
    failWorkflowTask(token: TaskToken, reason: string): Promise<void> {
      return core.failWorkflowTask(token, reason);
    },
    pollActivityTask(
      taskQueue?: string,
    ): Promise<LeasedActivityTask | undefined> {
      return core.pollActivityTask(taskQueue);
    },
    completeActivityTask(
      token: TaskToken,
      result: ActivityResult,
    ): Promise<void> {
      return core.completeActivityTask(token, result);
    },
    heartbeatActivityTask(token: TaskToken): Promise<void> {
      return core.heartbeatActivityTask(token);
    },
    async resume() {
      const records = await historyStore.list();
      // Same reason as ServerHost.resume: the counter restarts at zero, so
      // without this a restart reissues an id the store already holds.
      for (const rec of records) {
        const match = /-(\d+)$/.exec(rec.workflowId);
        if (match) counter = Math.max(counter, Number(match[1]));
      }
      for (const rec of records) {
        statusMirror.set(rec.workflowId, rec.status);
        ensureWaiter(rec.workflowId);
        if (rec.status !== 'running')
          settleTerminal(rec.workflowId, rec.status, rec.result, rec.failure);
      }
      await core.resumeFromHistory(records); // rebuilds correlation, re-dispatches, wakes running
    },
    shutdown() {
      timerService.stop();
      // Both are needed: the timer service holds workflow `sleep`, the core
      // holds retry backoffs, and both are ref'd so that pending work keeps a
      // process alive. Clearing only one leaves the other holding the loop.
      core.stop();
    },
  };
}

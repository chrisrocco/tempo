/**
 * @fileoverview
 * LocalService: the whole server in-process. It composes `server_core` with the
 * in-memory ports and runs the two worker poll loops in-proc — a workflow-worker
 * loop that drains the workflow-task queue (replacing the old `pump`+`kick`) and
 * an activity-worker loop that drains the activity-task queue. Distributed mode
 * runs those same loops in separate processes against `RemoteService`.
 *
 * The drain loops poll their queues *synchronously* (no await in the loop
 * condition) so there is no lost-wakeup window at the loop boundary: a wake that
 * lands mid-task is coalesced by the queue and picked up by the next poll.
 *
 * In-proc bookkeeping stays synchronous: `statusMirror` backs the sync `getStatus`
 * (updated after each task), and `waiters` back `getResult`. Both are rebuilt by
 * `resume`, not persisted.
 */

import type {
  ActivityResult,
  ActivityTask,
  ExecutionStatus,
  LeasedActivityTask,
  StartWorkflowOptions,
  TaskToken,
  WorkflowService,
  WorkflowTask,
  WorkflowTaskResult,
} from '../protocol';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  backoffMs,
  createServerCore,
  shouldRetry,
  type HistoryStore,
} from '../server';
import type { ActivityWorker, WorkflowWorker } from '../worker';

// A plain server-side wait between activity attempts. Distinct from TimerService
// (durable, workflow-facing): retry backoff never touches history.
function sleepMs(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((r) => {
        setTimeout(r, ms).unref?.();
      })
    : Promise.resolve();
}

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
    launch: (n, a) => launch(n, a),
    kickWorkflowWorker,
    kickActivityWorker,
  });

  // Startup sweep: re-arm persisted timers on boot (no-op on a fresh in-memory table).
  timerService.recover();

  // In-proc workflow worker: drain the workflow-task queue, replaying + applying.
  let wfDraining = false;
  function kickWorkflowWorker(): void {
    if (wfDraining) return;
    wfDraining = true;
    void (async () => {
      try {
        for (
          let leased = workflowTaskQueue.poll();
          leased;
          leased = workflowTaskQueue.poll()
        ) {
          const { token, workflowId: id } = leased;
          const task = await core.buildWorkflowTask(id);
          if (task) {
            const result = await workflowWorker.replayTask(
              task.name,
              task.args,
              task.history,
              task.continueAsNewSuggested,
            );
            await core.applyWorkflowTaskResult(id, result);
            const rec = await historyStore.get(id);
            if (rec) {
              statusMirror.set(id, rec.status);
              if (rec.status !== 'running')
                settleTerminal(id, rec.status, rec.result, rec.failure);
            }
          }
          workflowTaskQueue.complete(token);
        }
      } finally {
        wfDraining = false;
      }
    })();
  }

  // In-proc activity worker: drain the activity-task queue, running (with retry)
  // and reporting back. The workflow stays parked the whole time.
  let actDraining = false;
  function kickActivityWorker(): void {
    if (actDraining) return;
    actDraining = true;
    void (async () => {
      try {
        for (
          let task = activityTaskQueue.poll();
          task;
          task = activityTaskQueue.poll()
        ) {
          const result = await runActivityWithRetry(task);
          await core.reportActivityResult(task.workflowId, task.seq, result);
          activityTaskQueue.complete(task.token);
        }
      } finally {
        actDraining = false;
      }
    })();
  }

  async function runActivityWithRetry(
    task: ActivityTask,
  ): Promise<ActivityResult> {
    let attemptsMade = 0;
    while (true) {
      const result = await activityWorker.runTask(task);
      attemptsMade += 1;
      if (result.ok || !shouldRetry(task.options.retry, attemptsMade))
        return result;
      await sleepMs(backoffMs(task.options.retry, attemptsMade));
    }
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
      promise.catch(() => {}); // avoid unhandledRejection if getResult is never awaited
      w = { promise, resolve, reject, settled: false };
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

  function launch(
    name: string,
    args: unknown[],
    opts: StartWorkflowOptions = {},
  ): string {
    const workflowId = opts.workflowId ?? `${name}-${++counter}`;
    statusMirror.set(workflowId, 'running');
    ensureWaiter(workflowId);
    void historyStore
      .create(workflowId, name, args)
      .then(() => {
        workflowTaskQueue.enqueue(workflowId);
        kickWorkflowWorker();
      })
      .catch((err) => rejectWaiter(workflowId, err));
    return workflowId;
  }

  return {
    start(name, args = [], opts = {}) {
      return { workflowId: launch(name, args, opts) };
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
    getResult(workflowId) {
      return ensureWaiter(workflowId).promise;
    },
    getStatus(workflowId): ExecutionStatus {
      return statusMirror.get(workflowId) ?? 'running';
    },
    // ── worker-facing seam (for out-of-process workers; unused by the in-proc loops) ──
    pollWorkflowTask(): Promise<WorkflowTask | undefined> {
      return core.pollWorkflowTask();
    },
    completeWorkflowTask(
      token: TaskToken,
      result: WorkflowTaskResult,
    ): Promise<void> {
      return core.completeWorkflowTask(token, result);
    },
    pollActivityTask(): Promise<LeasedActivityTask | undefined> {
      return core.pollActivityTask();
    },
    completeActivityTask(
      token: TaskToken,
      result: ActivityResult,
    ): Promise<void> {
      return core.completeActivityTask(token, result);
    },
    async resume() {
      const records = await historyStore.list();
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
    },
  };
}

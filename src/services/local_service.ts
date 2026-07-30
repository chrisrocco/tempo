// LocalService: the whole server in-process. It composes `server_core` with the
// in-memory ports and adds the two things that live on the in-proc side of the
// boundary — `pump` (the per-execution concurrency guard) and the result-promise
// plumbing. Workers are injected as executors, so the same `server_core` code
// runs here and, later, behind `RemoteService`. This is the always-on fast path
// the whole suite runs against (doc 06).
//
// The HistoryStore is async, but the public surface stays synchronous where it
// matters: `getStatus` reads an in-proc status mirror (pump state), and the
// mutating calls (start / signal / cancel) do their store write and then kick,
// returning immediately. In-proc state (pump flags, result waiters, known ids)
// is deliberately synchronous — it "evaporates across processes" and is rebuilt
// by the resume driver, not persisted (doc 06).
import type {
  ExecutionStatus,
  StartWorkflowOptions,
  WorkflowService,
} from '../protocol';
import type { ActivityResult, ActivityTask } from '../protocol';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  backoffMs,
  createServerCore,
  shouldRetry,
  type ActivityTaskExecutor,
  type HistoryStore,
  type WorkflowTaskExecutor,
} from '../server';
import { pump, type PumpTarget } from './pump';

// A plain server-side wait between activity attempts. Distinct from TimerService
// (durable, workflow-facing): retry backoff never touches history.
const sleepMs = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => { setTimeout(r, ms).unref?.(); }) : Promise.resolve();

// Per-execution concurrency state. `status` is a synchronous mirror of the record
// status, updated after each drive so `getStatus` needn't touch the async store.
type PumpState = PumpTarget;

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
  workflowExecutor: WorkflowTaskExecutor,
  activityExecutor: ActivityTaskExecutor,
  historyStore: HistoryStore = new MemoryHistoryStore(),
): LocalService {
  const taskQueue = new MemoryTaskQueue();
  const timerService = new MemoryTimerService();

  const pumpStates = new Map<string, PumpState>();
  const waiters = new Map<string, ResultWaiter>();
  let counter = 0;

  const core = createServerCore({
    historyStore, taskQueue, timerService, workflowExecutor, wake: kick,
    launch: (name, args) => launch(name, args),
    kickActivityWorker,
  });

  // Startup sweep: a real deployment re-arms persisted timers here on boot. The
  // in-memory table is empty at construction, so this is a no-op today — but it
  // is where the crash-recovery sweep lives (doc 03 / 06).
  timerService.recover();

  // The in-proc activity worker: an async loop that drains the task queue one
  // task at a time (FIFO), runs each activity — retrying failures per its policy —
  // and reports the final result back to the server, which appends the event and
  // wakes the parked workflow. This is what lets the drive loop dispatch-and-park
  // activities instead of holding a frame while they run (Phase 4).
  let activityDraining = false;
  function kickActivityWorker(): void {
    if (activityDraining) return;
    activityDraining = true;
    void (async () => {
      try {
        for (let task = taskQueue.poll(); task; task = taskQueue.poll()) {
          const result = await runActivityWithRetry(task);
          await core.reportActivityResult(task.workflowId, task.seq, result);
        }
      } finally {
        activityDraining = false;
      }
    })();
  }

  async function runActivityWithRetry(task: ActivityTask): Promise<ActivityResult> {
    let attemptsMade = 0;
    for (;;) {
      const result = await activityExecutor.runTask(task);
      attemptsMade += 1;
      if (result.ok || !shouldRetry(task.options.retry, attemptsMade)) return result;
      await sleepMs(backoffMs(task.options.retry, attemptsMade));
    }
  }

  function ensureWaiter(workflowId: string): ResultWaiter {
    let w = waiters.get(workflowId);
    if (!w) {
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
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

  async function settleIfTerminal(workflowId: string): Promise<void> {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status === 'running') return;
    const w = ensureWaiter(workflowId);
    if (w.settled) return;
    w.settled = true;
    if (rec.status === 'completed') w.resolve(rec.result);
    else w.reject(rec.failure);
  }

  // Drive `workflowId` under the concurrency guard. The closure updates the pump
  // target's `status` mirror after each drive so pump's re-run check — and
  // getStatus — read a fresh value without touching the async store.
  function kick(workflowId: string): void {
    const state = pumpStates.get(workflowId)!;
    pump(state, async () => {
      await core.driveExecution(workflowId);
      const rec = await historyStore.get(workflowId);
      state.status = rec ? rec.status : 'failed';
      await settleIfTerminal(workflowId);
    });
  }

  // Register an execution's in-proc state synchronously (so getStatus/signal see
  // it at once), then create the durable record and kick. Returns the id now; the
  // drive starts after create resolves.
  function launch(name: string, args: unknown[], opts: StartWorkflowOptions = {}): string {
    const workflowId = opts.workflowId ?? `${name}-${++counter}`;
    pumpStates.set(workflowId, { running: false, rerun: false, status: 'running' });
    ensureWaiter(workflowId);
    void historyStore.create(workflowId, name, args)
      .then(() => kick(workflowId))
      .catch((err) => rejectWaiter(workflowId, err));
    return workflowId;
  }

  return {
    start(name, args = [], opts = {}) {
      return { workflowId: launch(name, args, opts) };
    },
    signal(workflowId, signalName, payload) {
      if (!pumpStates.has(workflowId)) throw new Error(`no execution ${workflowId}`);
      void core.appendSignal(workflowId, signalName, payload).then(() => kick(workflowId));
    },
    cancel(workflowId) {
      if (!pumpStates.has(workflowId)) throw new Error(`no execution ${workflowId}`);
      void core.requestCancel(workflowId); // requestCancel appends + wakes on its own
    },
    getResult(workflowId) {
      return ensureWaiter(workflowId).promise;
    },
    getStatus(workflowId): ExecutionStatus {
      return pumpStates.get(workflowId)?.status ?? 'running';
    },
    async resume() {
      const records = await historyStore.list();
      for (const rec of records) {
        // Rebuild in-proc state (pump flags, result waiter) that didn't survive.
        if (!pumpStates.has(rec.workflowId)) {
          pumpStates.set(rec.workflowId, { running: false, rerun: false, status: rec.status });
        }
        const w = ensureWaiter(rec.workflowId);
        if (rec.status !== 'running' && !w.settled) {
          w.settled = true;
          if (rec.status === 'completed') w.resolve(rec.result); else w.reject(rec.failure);
        }
      }
      await core.resumeFromHistory(records);
      for (const rec of records) {
        if (rec.status === 'running') kick(rec.workflowId); // re-drive from history
      }
    },
    shutdown() {
      timerService.stop();
    },
  };
}

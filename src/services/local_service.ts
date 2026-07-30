// LocalService: the whole server in-process. It composes `server_core` with the
// in-memory ports and adds the two things that live on the in-proc side of the
// boundary — `pump` (the per-execution concurrency guard) and the result-promise
// plumbing. Workers are injected as executors, so the same `server_core` code
// runs here and, later, behind `RemoteService`. This is the always-on fast path
// the whole suite runs against (doc 06).
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
  type WorkflowTaskExecutor,
} from '../server';
import { pump, type PumpTarget } from './pump';

// A plain server-side wait between activity attempts. Distinct from TimerService
// (durable, workflow-facing): retry backoff never touches history.
const sleepMs = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => { setTimeout(r, ms).unref?.(); }) : Promise.resolve();

// Per-execution concurrency state. Deliberately NOT in the HistoryStore: these
// flags are in-proc bookkeeping that "evaporate across processes" — the durable
// replacement is the version check + leased queue (see pump.ts, doc 06).
type PumpState = PumpTarget;

interface ResultWaiter {
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  settled: boolean;
}

export function createLocalService(
  workflowExecutor: WorkflowTaskExecutor,
  activityExecutor: ActivityTaskExecutor,
): WorkflowService {
  const historyStore = new MemoryHistoryStore();
  const taskQueue = new MemoryTaskQueue();
  const timerService = new MemoryTimerService();

  const pumpStates = new Map<string, PumpState>();
  const waiters = new Map<string, ResultWaiter>();
  let counter = 0;

  const core = createServerCore({
    historyStore, taskQueue, timerService, workflowExecutor, wake: kick,
    launch: (name, args) => launch(name, args),
    awaitResult: (workflowId) => ensureWaiter(workflowId).promise,
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
          core.reportActivityResult(task.workflowId, task.seq, result);
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

  function settleIfTerminal(workflowId: string): void {
    const rec = historyStore.get(workflowId);
    if (!rec || rec.status === 'running') return;
    const w = ensureWaiter(workflowId);
    if (w.settled) return;
    w.settled = true;
    if (rec.status === 'completed') w.resolve(rec.result);
    else w.reject(rec.failure);
  }

  // Drive `workflowId` under the concurrency guard. The closure updates the pump
  // target's `status` after each drive so pump's re-run check reads a fresh value.
  function kick(workflowId: string): void {
    const state = pumpStates.get(workflowId)!;
    pump(state, async () => {
      await core.driveExecution(workflowId);
      const rec = historyStore.get(workflowId);
      state.status = rec ? rec.status : 'failed';
      settleIfTerminal(workflowId);
    });
  }

  function launch(name: string, args: unknown[], opts: StartWorkflowOptions = {}): string {
    const workflowId = opts.workflowId ?? `${name}-${++counter}`;
    historyStore.create(workflowId, name, args);
    pumpStates.set(workflowId, { running: false, rerun: false, status: 'running' });
    ensureWaiter(workflowId);
    kick(workflowId);
    return workflowId;
  }

  return {
    start(name, args = [], opts = {}) {
      return { workflowId: launch(name, args, opts) };
    },
    signal(workflowId, signalName, payload) {
      if (!historyStore.get(workflowId)) throw new Error(`no execution ${workflowId}`);
      core.appendSignal(workflowId, signalName, payload);
      kick(workflowId);
    },
    cancel(workflowId) {
      if (!historyStore.get(workflowId)) throw new Error(`no execution ${workflowId}`);
      core.requestCancel(workflowId);
    },
    getResult(workflowId) {
      return ensureWaiter(workflowId).promise;
    },
    getStatus(workflowId): ExecutionStatus {
      return historyStore.get(workflowId)?.status ?? 'running';
    },
  };
}

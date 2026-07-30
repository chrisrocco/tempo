// The orchestration brain. It advances an execution task-by-task — but runs NO
// user code itself: replay is delegated to a workflow-task executor (the workflow
// worker) and activity functions to an activity-task executor (the activity
// worker). Everything durable flows through the ports. This is the old `drive` /
// `executeCommand` loop, refactored so the determinism boundary is also a
// process boundary in waiting (doc 04, doc 06).
import type {
  ActivityResult,
  ActivityTask,
  Command,
  ContinueAsNewCommand,
  HistoryEvent,
  WorkflowTaskResult,
} from '../protocol';
import type { HistoryStore } from './ports/history_store';
import type { TaskQueue } from './ports/task_queue';
import type { TimerService } from './ports/timer_service';

// Placeholder heuristic for when to hint continue-as-new. A real server tunes
// this from history size/bytes; the in-memory server uses a low event count so
// long-running workflows can observe the hint promptly (doc 05).
const CONTINUE_AS_NEW_SUGGEST_THRESHOLD = 4;

/** Replays one workflow task: history in, commands + terminal state out. */
export interface WorkflowTaskExecutor {
  replayTask(
    name: string,
    args: unknown[],
    history: HistoryEvent[],
    continueAsNewSuggested: boolean,
  ): Promise<WorkflowTaskResult>;
}

/** Runs one activity task: the only place I/O happens. */
export interface ActivityTaskExecutor {
  runTask(task: ActivityTask): Promise<ActivityResult>;
}

export interface ServerCoreDeps {
  historyStore: HistoryStore;
  taskQueue: TaskQueue;
  timerService: TimerService;
  workflowExecutor: WorkflowTaskExecutor;
  /**
   * Launch a child execution (non-blocking) and return its workflowId. Owned by
   * the service layer because it needs the concurrency guard. Used for both
   * blocking children (launch + awaitResult) and detached ones (launch only).
   */
  launch(name: string, args: unknown[]): string;
  /** The child's eventual result/failure — awaited for a blocking child. */
  awaitResult(workflowId: string): Promise<unknown>;
  /**
   * Wake an execution to drive again. Used when a timer fires or a cancel is
   * requested outside any drive. The service layer provides it (it owns the guard).
   */
  wake(workflowId: string): void;
  /**
   * Nudge the (async, in-proc) activity worker to drain the task queue. Called
   * after enqueuing so the drive never has to await activity work itself.
   */
  kickActivityWorker(): void;
}

export interface ServerCore {
  /** Drive an execution until it completes, fails, or parks on external input. */
  driveExecution(workflowId: string): Promise<void>;
  /** Append an externally injected signal to an execution's history. */
  appendSignal(workflowId: string, signalName: string, payload: unknown): void;
  /** Request cancellation of an execution, cascading to its fire-and-forget children. */
  requestCancel(workflowId: string): void;
  /** The activity worker reports a finished activity here; appends the event + wakes. */
  reportActivityResult(workflowId: string, seq: number, result: ActivityResult): void;
}

export function createServerCore(deps: ServerCoreDeps): ServerCore {
  const {
    historyStore, taskQueue, timerService, workflowExecutor, launch, awaitResult, wake,
    kickActivityWorker,
  } = deps;

  // parentId -> (startChild seq -> childId), for targeted + cascading cancel.
  // In-proc bookkeeping (not durable); a persisted adapter rebuilds it in Phase 4.
  const childrenByParent = new Map<string, Map<number, string>>();

  function recordChild(parentId: string, seq: number, childId: string): void {
    let kids = childrenByParent.get(parentId);
    if (!kids) { kids = new Map(); childrenByParent.set(parentId, kids); }
    kids.set(seq, childId);
  }

  // Append one event at the execution's current version. Read the version
  // immediately before appending (no `await` between) so it is always current — a
  // signal (or an activity result) appended during an earlier `await` can't
  // cause a conflict.
  function appendEvent(workflowId: string, event: HistoryEvent): void {
    const rec = historyStore.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    historyStore.append(workflowId, [event], rec.version);
  }

  // A timer coming due is just another wake: record its firing in history, then
  // ask the service to drive the execution so replay sees the `timerFired`.
  timerService.onFire((workflowId, seq) => {
    const rec = historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return; // execution already settled — drop it
    appendEvent(workflowId, { type: 'timerFired', seq });
    wake(workflowId);
  });

  // The async activity worker calls this when an activity settles (after any
  // retries). It records the completion and wakes the parked workflow — the drive
  // never awaited the activity, so no frame was held for its duration.
  function reportActivityResult(workflowId: string, seq: number, result: ActivityResult): void {
    const rec = historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return; // execution already settled — drop it
    appendEvent(workflowId, result.ok
      ? { type: 'activityCompleted', seq, result: result.result }
      : { type: 'activityFailed', seq, error: result.error });
    wake(workflowId);
  }

  // Dispatch one command. Returns whether it appended a completion event. Deferred
  // work — a timer, a fire-and-forget child, and now an activity — only *schedules*
  // and returns false, which parks the drive loop; its completion arrives later as
  // its own event (a timer firing, an activity report) and re-drives the workflow.
  async function executeCommand(workflowId: string, cmd: Command): Promise<boolean> {
    if (cmd.type === 'scheduleActivity') {
      // Record "scheduled before running" (crash-recovery idempotency + the marker
      // that stops a re-emitted command from re-dispatching), enqueue, and park.
      appendEvent(workflowId, { type: 'activityScheduled', seq: cmd.seq });
      taskQueue.enqueue({ workflowId, seq: cmd.seq, name: cmd.name, args: cmd.args, options: cmd.options });
      kickActivityWorker();
      return false;
    }
    if (cmd.type === 'startTimer') {
      timerService.schedule(workflowId, cmd.seq, cmd.ms); // fires later; no event yet
      return false;
    }
    if (cmd.type === 'startChild') {
      if (cmd.detached) {
        // Fire-and-forget: launch and record it for cancel; no completion is
        // threaded back, so this appends nothing (dispatched exactly once by the
        // same emit-once/park mechanism timers use).
        recordChild(workflowId, cmd.seq, launch(cmd.childName, cmd.childArgs));
        return false;
      }
      const childId = launch(cmd.childName, cmd.childArgs);
      try {
        const result = await awaitResult(childId);
        appendEvent(workflowId, { type: 'childCompleted', seq: cmd.seq, result });
      } catch (e) {
        appendEvent(workflowId, { type: 'childFailed', seq: cmd.seq, error: (e as Error).message });
      }
      return true;
    }
    if (cmd.type === 'cancelChild') {
      const childId = childrenByParent.get(workflowId)?.get(cmd.targetSeq);
      if (childId) requestCancel(childId);
      return false;
    }
    return false;
  }

  /**
   * Drive one execution forward, one workflow task at a time, until it reaches a
   * resting point. Each iteration is a *cold replay*: a fresh context is built from
   * the full history and the workflow re-run (the worker owns replay; the server
   * keeps no per-execution memory between tasks). The result is then dispositioned:
   *
   * - **done / failed** — record the terminal outcome and stop.
   * - **continueAsNew** — close this run and restart fresh on the same id (history
   *   + args reset), then loop to drive the new run.
   * - **commands** — dispatch each (activity, timer, child, cancelChild). If at
   *   least one appended a completion event, loop to make more progress; if the
   *   batch only scheduled *deferred* work (timers, fire-and-forget children) it
   *   made no progress, so park and return.
   * - **no commands** — parked on external input (a signal); return.
   *
   * Returning is not "finished": a parked execution is re-entered by a fresh
   * `driveExecution` when something wakes it — a signal, a timer firing, or a
   * cancel. Serializing concurrent wakes is `pump`'s job (services/pump.ts); this
   * function assumes at most one drive per execution runs at a time.
   *
   * Activities, timers, and fire-and-forget children all dispatch-and-park (no
   * frame held for their duration). Blocking children still *await* inline here —
   * they get the same dispatch-and-park treatment in the next Phase-4 slice.
   */
  async function driveExecution(workflowId: string): Promise<void> {
    for (;;) {
      const rec = historyStore.get(workflowId);
      if (!rec || rec.status !== 'running') return;
      const suggested = rec.history.length >= CONTINUE_AS_NEW_SUGGEST_THRESHOLD;
      // fresh snapshot => cold replay each task, exactly as the old `drive` did
      const out = await workflowExecutor.replayTask(rec.name, rec.args, rec.history.slice(), suggested);
      if (out.done) { historyStore.setStatus(workflowId, 'completed', { result: out.result }); return; }
      if (out.failed) { historyStore.setStatus(workflowId, 'failed', { failure: out.failure }); return; }
      // Fourth terminal case: close this run and restart fresh on the same id.
      // Children are spared (we cancel nothing), and history accounting resets —
      // the suggestion is derived from history length, so it drops to false too.
      const caN = out.commands.find((c): c is ContinueAsNewCommand => c.type === 'continueAsNew');
      if (caN) { historyStore.resetForContinueAsNew(workflowId, caN.args); continue; }
      if (out.commands.length === 0) return; // parked, waiting on an external signal
      let progressed = false;
      for (const cmd of out.commands) {
        if (await executeCommand(workflowId, cmd)) progressed = true;
      }
      // A batch that only scheduled timers appended nothing: park until one fires.
      if (!progressed) return;
    }
  }

  function appendSignal(workflowId: string, signalName: string, payload: unknown): void {
    const rec = historyStore.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    const event: HistoryEvent = { type: 'signal', name: signalName, payload };
    historyStore.append(workflowId, [event], rec.version);
  }

  // Cancellation as a recorded external input: append `cancelRequested`, cascade
  // to fire-and-forget children, then wake so replay applies it. Idempotent — a
  // second request on an already-cancelling/terminal run is a no-op.
  function requestCancel(workflowId: string): void {
    const rec = historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return;
    if (rec.history.some((e) => e.type === 'cancelRequested')) return;
    historyStore.append(workflowId, [{ type: 'cancelRequested' }], rec.version);
    const kids = childrenByParent.get(workflowId);
    if (kids) for (const childId of kids.values()) requestCancel(childId);
    wake(workflowId);
  }

  return { driveExecution, appendSignal, requestCancel, reportActivityResult };
}

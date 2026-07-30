// The orchestration brain. It advances an execution task-by-task — but runs NO
// user code itself: replay is delegated to a workflow-task executor (the workflow
// worker) and activity functions to an activity-task executor (the activity
// worker). Everything durable flows through the ports. This is the old `drive` /
// `executeCommand` loop, refactored so the determinism boundary is also a
// process boundary in waiting (doc 04, doc 06).
//
// The HistoryStore is async (a filesystem/db adapter is inherently async). Because
// `append` is atomic per call and there is a single writer per execution (drives
// serialized by pump; signals/cancels serialized by the adapter), no caller-side
// version read is needed — the adapter bumps its own version. The optimistic-CAS
// check returns in Phase 5, where concurrent workers make it meaningful.
import type {
  ActivityResult,
  ActivityTask,
  Command,
  ContinueAsNewCommand,
  HistoryEvent,
  WorkflowTaskResult,
} from '../protocol';
import type { ExecutionRecord, HistoryStore } from './ports/history_store';
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
   * the service layer because it needs the concurrency guard. Both blocking and
   * detached children are launched this way — a blocking child's parent parks and
   * is woken by the child's `childCompleted` event (see notifyParentOfTerminal).
   */
  launch(name: string, args: unknown[]): string;
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
  appendSignal(workflowId: string, signalName: string, payload: unknown): Promise<void>;
  /** Request cancellation of an execution, cascading to its fire-and-forget children. */
  requestCancel(workflowId: string): Promise<void>;
  /** The activity worker reports a finished activity here; appends the event + wakes. */
  reportActivityResult(workflowId: string, seq: number, result: ActivityResult): Promise<void>;
  /**
   * Rebuild in-proc correlation and re-dispatch pending work from persisted history
   * (crash recovery). The caller (service) then re-kicks the running executions.
   */
  resumeFromHistory(records: ExecutionRecord[]): Promise<void>;
}

// The seqs of operations already completed in a history, by kind — used on resume
// to tell which scheduled activities / started timers / children are still pending.
function completedSeqs(history: HistoryEvent[]): {
  activities: Set<number>; timers: Set<number>; children: Set<number>;
} {
  const activities = new Set<number>();
  const timers = new Set<number>();
  const children = new Set<number>();
  for (const ev of history) {
    if (ev.type === 'activityCompleted' || ev.type === 'activityFailed') activities.add(ev.seq);
    else if (ev.type === 'timerFired') timers.add(ev.seq);
    else if (ev.type === 'childCompleted' || ev.type === 'childFailed') children.add(ev.seq);
  }
  return { activities, timers, children };
}

export function createServerCore(deps: ServerCoreDeps): ServerCore {
  const {
    historyStore, taskQueue, timerService, workflowExecutor, launch, wake,
    kickActivityWorker,
  } = deps;

  // parentId -> (startChild seq -> childId), for targeted + cascading cancel.
  // In-proc bookkeeping (not durable); a persisted adapter rebuilds it in Phase 4.
  const childrenByParent = new Map<string, Map<number, string>>();
  // childId -> its parent link, for a BLOCKING child only: when the child settles
  // we append its result back to the parent (the reverse of childrenByParent).
  const parentOfChild = new Map<string, { parentId: string; seq: number }>();

  function recordChild(parentId: string, seq: number, childId: string): void {
    let kids = childrenByParent.get(parentId);
    if (!kids) { kids = new Map(); childrenByParent.set(parentId, kids); }
    kids.set(seq, childId);
  }

  const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  // Append one event atomically. The adapter bumps the version and throws if the
  // execution is unknown; single-writer, so no caller-side version check.
  const appendEvent = (workflowId: string, event: HistoryEvent): Promise<void> =>
    historyStore.append(workflowId, [event]);

  // When a blocking child settles, thread its outcome back to the parent as a
  // `childCompleted` / `childFailed` event and wake the parent. Detached children
  // have no parent link, so this is a no-op for them.
  async function notifyParentOfTerminal(childId: string): Promise<void> {
    const link = parentOfChild.get(childId);
    if (!link) return;
    parentOfChild.delete(childId);
    const parent = await historyStore.get(link.parentId);
    if (!parent || parent.status !== 'running') return; // parent already gone (e.g. cancelled)
    const child = await historyStore.get(childId);
    if (!child) return;
    await appendEvent(link.parentId, child.status === 'completed'
      ? { type: 'childCompleted', seq: link.seq, result: child.result }
      : { type: 'childFailed', seq: link.seq, error: errorMessage(child.failure) });
    wake(link.parentId);
  }

  // A timer coming due is just another wake: record its firing in history, then
  // ask the service to drive the execution so replay sees the `timerFired`.
  timerService.onFire(async (workflowId, seq) => {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return; // execution already settled — drop it
    await appendEvent(workflowId, { type: 'timerFired', seq });
    wake(workflowId);
  });

  // The async activity worker calls this when an activity settles (after any
  // retries). It records the completion and wakes the parked workflow — the drive
  // never awaited the activity, so no frame was held for its duration.
  async function reportActivityResult(workflowId: string, seq: number, result: ActivityResult): Promise<void> {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return; // execution already settled — drop it
    await appendEvent(workflowId, result.ok
      ? { type: 'activityCompleted', seq, result: result.result }
      : { type: 'activityFailed', seq, error: result.error });
    wake(workflowId);
  }

  // Dispatch one command. Returns whether it appended a completion event. All
  // dispatching work is deferred (dispatch-and-park): the completion arrives later
  // as its own event and re-drives the workflow, so the drive holds no frame.
  async function executeCommand(workflowId: string, cmd: Command): Promise<boolean> {
    if (cmd.type === 'scheduleActivity') {
      // Record "scheduled before running" (crash-recovery idempotency + the marker
      // that stops a re-emitted command from re-dispatching), enqueue, and park.
      // The marker carries the payload so a resumed process can re-enqueue it.
      await appendEvent(workflowId, {
        type: 'activityScheduled', seq: cmd.seq, name: cmd.name, args: cmd.args, options: cmd.options,
      });
      taskQueue.enqueue({ workflowId, seq: cmd.seq, name: cmd.name, args: cmd.args, options: cmd.options });
      kickActivityWorker();
      return false;
    }
    if (cmd.type === 'startTimer') {
      // Record the absolute fire-time, then arm. Resume re-arms from the marker.
      const fireAt = Date.now() + cmd.ms;
      await appendEvent(workflowId, { type: 'timerStarted', seq: cmd.seq, fireAt });
      timerService.schedule(workflowId, cmd.seq, fireAt);
      return false;
    }
    if (cmd.type === 'startChild') {
      // Both modes launch and park; the difference is whether the parent is later
      // woken by the child's result. Detached: no completion is threaded back.
      const childId = launch(cmd.childName, cmd.childArgs);
      recordChild(workflowId, cmd.seq, childId);
      if (!cmd.detached) {
        // Blocking: record the started marker and the reverse link, so when the
        // child settles its result is appended back here (notifyParentOfTerminal).
        await appendEvent(workflowId, { type: 'childStarted', seq: cmd.seq, childId });
        parentOfChild.set(childId, { parentId: workflowId, seq: cmd.seq });
      }
      return false;
    }
    if (cmd.type === 'cancelChild') {
      const childId = childrenByParent.get(workflowId)?.get(cmd.targetSeq);
      if (childId) await requestCancel(childId);
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
   * - **commands** — dispatch each. If at least one appended a completion event,
   *   loop to make more progress; if the batch only dispatched deferred work
   *   (everything does now) it made no progress, so park and return.
   * - **no commands** — parked on external input (a signal); return.
   *
   * Returning is not "finished": a parked execution is re-entered by a fresh
   * `driveExecution` when something wakes it — a signal, a timer firing, an
   * activity report, a child completing, or a cancel. Serializing concurrent wakes
   * is `pump`'s job (services/pump.ts); this assumes one drive per execution.
   *
   * Every command dispatch-and-parks — activities, timers, and both blocking and
   * fire-and-forget children — so no frame is ever held for an operation's duration.
   */
  async function driveExecution(workflowId: string): Promise<void> {
    for (;;) {
      const rec = await historyStore.get(workflowId);
      if (!rec || rec.status !== 'running') return;
      const suggested = rec.history.length >= CONTINUE_AS_NEW_SUGGEST_THRESHOLD;
      // fresh snapshot => cold replay each task, exactly as the old `drive` did
      const out = await workflowExecutor.replayTask(rec.name, rec.args, rec.history.slice(), suggested);
      if (out.done) {
        await historyStore.setStatus(workflowId, 'completed', { result: out.result });
        await notifyParentOfTerminal(workflowId);
        return;
      }
      if (out.failed) {
        await historyStore.setStatus(workflowId, 'failed', { failure: out.failure });
        await notifyParentOfTerminal(workflowId);
        return;
      }
      // Fourth terminal case: close this run and restart fresh on the same id.
      // Children are spared (we cancel nothing), and history accounting resets —
      // the suggestion is derived from history length, so it drops to false too.
      const caN = out.commands.find((c): c is ContinueAsNewCommand => c.type === 'continueAsNew');
      if (caN) { await historyStore.resetForContinueAsNew(workflowId, caN.args); continue; }
      if (out.commands.length === 0) return; // parked, waiting on an external signal
      let progressed = false;
      for (const cmd of out.commands) {
        if (await executeCommand(workflowId, cmd)) progressed = true;
      }
      // A batch that only dispatched deferred work appended nothing: park until a
      // timer fires, an activity reports, or a child completes.
      if (!progressed) return;
    }
  }

  async function appendSignal(workflowId: string, signalName: string, payload: unknown): Promise<void> {
    await historyStore.append(workflowId, [{ type: 'signal', name: signalName, payload }]);
  }

  // Cancellation as a recorded external input: append `cancelRequested`, cascade
  // to fire-and-forget children, then wake so replay applies it. Idempotent — a
  // second request on an already-cancelling/terminal run is a no-op.
  async function requestCancel(workflowId: string): Promise<void> {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return;
    if (rec.history.some((e) => e.type === 'cancelRequested')) return;
    await appendEvent(workflowId, { type: 'cancelRequested' });
    const kids = childrenByParent.get(workflowId);
    if (kids) for (const childId of kids.values()) await requestCancel(childId);
    wake(workflowId);
  }

  // Crash recovery. History is the source of truth: rebuild the parent/child
  // correlation from `childStarted` markers, then for each still-running execution
  // re-arm pending timers (from `timerStarted.fireAt`), re-enqueue pending
  // activities (from `activityScheduled` payloads), and recover any child result
  // that settled but whose notification to the parent was lost to the crash.
  async function resumeFromHistory(records: ExecutionRecord[]): Promise<void> {
    const byId = new Map(records.map((r) => [r.workflowId, r]));

    for (const rec of records) {
      for (const ev of rec.history) {
        if (ev.type === 'childStarted') recordChild(rec.workflowId, ev.seq, ev.childId);
      }
    }

    let anyActivity = false;
    for (const rec of records) {
      if (rec.status !== 'running') continue;
      const done = completedSeqs(rec.history);
      for (const ev of rec.history) {
        if (ev.type === 'activityScheduled' && !done.activities.has(ev.seq)) {
          taskQueue.enqueue({ workflowId: rec.workflowId, seq: ev.seq, name: ev.name, args: ev.args, options: ev.options });
          anyActivity = true;
        } else if (ev.type === 'timerStarted' && !done.timers.has(ev.seq)) {
          timerService.schedule(rec.workflowId, ev.seq, ev.fireAt);
        } else if (ev.type === 'childStarted' && !done.children.has(ev.seq)) {
          const child = byId.get(ev.childId);
          if (child && child.status !== 'running') {
            // child finished but the parent never got the notification — replay it
            await appendEvent(rec.workflowId, child.status === 'completed'
              ? { type: 'childCompleted', seq: ev.seq, result: child.result }
              : { type: 'childFailed', seq: ev.seq, error: errorMessage(child.failure) });
          } else {
            parentOfChild.set(ev.childId, { parentId: rec.workflowId, seq: ev.seq });
          }
        }
      }
    }
    if (anyActivity) kickActivityWorker();
  }

  return { driveExecution, appendSignal, requestCancel, reportActivityResult, resumeFromHistory };
}

/**
 * @fileoverview
 * The orchestration brain. It runs NO user code: workflow replay and activity
 * execution happen in workers that POLL it. The server hands out tasks
 * (buildWorkflowTask / pollActivityTask), applies what workers report back
 * (applyWorkflowTaskResult / reportActivityResult), and owns everything durable
 * via the ports. Waking an execution = enqueuing a workflow task; that queue's
 * coalescing is the distributed replacement for `pump` (docs/architecture/task-execution-and-concurrency.md, distribution.md).
 */

import type {
  ActivityResult,
  Command,
  ContinueAsNewCommand,
  HistoryEvent,
  LeasedActivityTask,
  TaskToken,
  WorkflowTask,
  WorkflowTaskResult,
} from '../protocol';
import type { ExecutionRecord, HistoryStore } from './ports/history_store';
import type { TaskQueue } from './ports/task_queue';
import type { WorkflowTaskQueue } from './ports/workflow_task_queue';
import type { TimerService } from './ports/timer_service';

const CONTINUE_AS_NEW_SUGGEST_THRESHOLD = 4;

export interface ServerCoreDeps {
  historyStore: HistoryStore;
  workflowTaskQueue: WorkflowTaskQueue;
  activityTaskQueue: TaskQueue;
  timerService: TimerService;
  /** Launch a child execution (non-blocking) and return its workflowId. */
  launch(name: string, args: unknown[]): string;
  /** Nudge the (async, in-proc) workflow worker to drain the workflow-task queue. */
  kickWorkflowWorker(): void;
  /** Nudge the (async, in-proc) activity worker to drain the activity-task queue. */
  kickActivityWorker(): void;
}

export interface ServerCore {
  /** Build the task for an execution the worker has claimed (or undefined if gone/terminal). */
  buildWorkflowTask(workflowId: string): Promise<WorkflowTask | undefined>;
  /** Apply a worker's replay result: settle, continue-as-new, or dispatch its commands. */
  applyWorkflowTaskResult(
    workflowId: string,
    result: WorkflowTaskResult,
  ): Promise<void>;
  /** The activity worker (in-proc) reports a finished activity: append + wake. */
  reportActivityResult(
    workflowId: string,
    seq: number,
    result: ActivityResult,
  ): Promise<void>;
  /** Append an externally injected signal, then wake. */
  appendSignal(
    workflowId: string,
    signalName: string,
    payload: unknown,
  ): Promise<void>;
  /** Request cancellation, cascading to fire-and-forget children. */
  requestCancel(workflowId: string): Promise<void>;
  /** Rebuild correlation + re-dispatch pending work from persisted history (crash recovery). */
  resumeFromHistory(records: ExecutionRecord[]): Promise<void>;
  // ── worker-facing seam (for out-of-process workers; see WorkflowService) ──
  pollWorkflowTask(): Promise<WorkflowTask | undefined>;
  completeWorkflowTask(
    token: TaskToken,
    result: WorkflowTaskResult,
  ): Promise<void>;
  pollActivityTask(): Promise<LeasedActivityTask | undefined>;
  completeActivityTask(token: TaskToken, result: ActivityResult): Promise<void>;
}

function completedSeqs(history: HistoryEvent[]): {
  activities: Set<number>;
  timers: Set<number>;
  children: Set<number>;
} {
  const activities = new Set<number>();
  const timers = new Set<number>();
  const children = new Set<number>();
  for (const ev of history) {
    if (ev.type === 'activityCompleted' || ev.type === 'activityFailed')
      activities.add(ev.seq);
    else if (ev.type === 'timerFired') timers.add(ev.seq);
    else if (ev.type === 'childCompleted' || ev.type === 'childFailed')
      children.add(ev.seq);
  }
  return { activities, timers, children };
}

export function createServerCore(deps: ServerCoreDeps): ServerCore {
  const {
    historyStore,
    workflowTaskQueue,
    activityTaskQueue,
    timerService,
    launch,
    kickWorkflowWorker,
    kickActivityWorker,
  } = deps;

  const childrenByParent = new Map<string, Map<number, string>>();
  const parentOfChild = new Map<string, { parentId: string; seq: number }>();
  // Seam bookkeeping: what each handed-out task token maps to, so `complete` can
  // report it back and (for workflow tasks) run the optimistic version check.
  const activityLeases = new Map<
    TaskToken,
    { workflowId: string; seq: number }
  >();
  const workflowLeases = new Map<
    TaskToken,
    { workflowId: string; version: number }
  >();

  function recordChild(parentId: string, seq: number, childId: string): void {
    let kids = childrenByParent.get(parentId);
    if (!kids) {
      kids = new Map();
      childrenByParent.set(parentId, kids);
    }
    kids.set(seq, childId);
  }

  const errorMessage = (e: unknown): string =>
    e instanceof Error ? e.message : String(e);

  const appendEvent = (
    workflowId: string,
    event: HistoryEvent,
  ): Promise<void> => historyStore.append(workflowId, [event]);

  // Wake an execution: it needs another workflow task. The queue coalesces, so a
  // wake during an in-flight task becomes exactly one more task.
  function wake(workflowId: string): void {
    workflowTaskQueue.enqueue(workflowId);
    kickWorkflowWorker();
  }

  async function notifyParentOfTerminal(childId: string): Promise<void> {
    const link = parentOfChild.get(childId);
    if (!link) return;
    parentOfChild.delete(childId);
    const parent = await historyStore.get(link.parentId);
    if (!parent || parent.status !== 'running') return;
    const child = await historyStore.get(childId);
    if (!child) return;
    await appendEvent(
      link.parentId,
      child.status === 'completed'
        ? { type: 'childCompleted', seq: link.seq, result: child.result }
        : {
            type: 'childFailed',
            seq: link.seq,
            error: errorMessage(child.failure),
          },
    );
    wake(link.parentId);
  }

  timerService.onFire(async (workflowId, seq) => {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return;
    await appendEvent(workflowId, { type: 'timerFired', seq });
    wake(workflowId);
  });

  // Dispatch one command. Everything dispatch-and-parks; its completion arrives
  // later as its own event and wakes the workflow.
  async function applyCommand(workflowId: string, cmd: Command): Promise<void> {
    if (cmd.type === 'scheduleActivity') {
      await appendEvent(workflowId, {
        type: 'activityScheduled',
        seq: cmd.seq,
        name: cmd.name,
        args: cmd.args,
        options: cmd.options,
      });
      activityTaskQueue.enqueue({
        workflowId,
        seq: cmd.seq,
        name: cmd.name,
        args: cmd.args,
        options: cmd.options,
      });
      kickActivityWorker();
    } else if (cmd.type === 'startTimer') {
      const fireAt = Date.now() + cmd.ms;
      await appendEvent(workflowId, {
        type: 'timerStarted',
        seq: cmd.seq,
        fireAt,
      });
      timerService.schedule(workflowId, cmd.seq, fireAt);
    } else if (cmd.type === 'startChild') {
      const childId = launch(cmd.childName, cmd.childArgs);
      recordChild(workflowId, cmd.seq, childId);
      if (!cmd.detached) {
        await appendEvent(workflowId, {
          type: 'childStarted',
          seq: cmd.seq,
          childId,
        });
        parentOfChild.set(childId, { parentId: workflowId, seq: cmd.seq });
      }
    } else if (cmd.type === 'cancelChild') {
      const childId = childrenByParent.get(workflowId)?.get(cmd.targetSeq);
      if (childId) await requestCancel(childId);
    }
  }

  async function buildWorkflowTask(
    workflowId: string,
  ): Promise<WorkflowTask | undefined> {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return undefined;
    return {
      token: workflowId,
      workflowId,
      name: rec.name,
      args: rec.args,
      history: rec.history.slice(),
      continueAsNewSuggested:
        rec.history.length >= CONTINUE_AS_NEW_SUGGEST_THRESHOLD,
    };
  }

  async function applyWorkflowTaskResult(
    workflowId: string,
    result: WorkflowTaskResult,
  ): Promise<void> {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return;
    if (result.done) {
      await historyStore.setStatus(workflowId, 'completed', {
        result: result.result,
      });
      await notifyParentOfTerminal(workflowId);
      return;
    }
    if (result.failed) {
      await historyStore.setStatus(workflowId, 'failed', {
        failure: result.failure,
      });
      await notifyParentOfTerminal(workflowId);
      return;
    }
    const caN = result.commands.find(
      (c): c is ContinueAsNewCommand => c.type === 'continueAsNew',
    );
    if (caN) {
      await historyStore.resetForContinueAsNew(workflowId, caN.args);
      wake(workflowId); // drive the fresh run
      return;
    }
    // Dispatch this batch; the execution then parks until a completion wakes it.
    for (const cmd of result.commands) await applyCommand(workflowId, cmd);
  }

  async function reportActivityResult(
    workflowId: string,
    seq: number,
    result: ActivityResult,
  ): Promise<void> {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return;
    await appendEvent(
      workflowId,
      result.ok
        ? { type: 'activityCompleted', seq, result: result.result }
        : { type: 'activityFailed', seq, error: result.error },
    );
    wake(workflowId);
  }

  async function appendSignal(
    workflowId: string,
    signalName: string,
    payload: unknown,
  ): Promise<void> {
    await historyStore.append(workflowId, [
      { type: 'signal', name: signalName, payload },
    ]);
    wake(workflowId);
  }

  async function requestCancel(workflowId: string): Promise<void> {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return;
    if (rec.history.some((e) => e.type === 'cancelRequested')) return;
    await appendEvent(workflowId, { type: 'cancelRequested' });
    const kids = childrenByParent.get(workflowId);
    if (kids) for (const childId of kids.values()) await requestCancel(childId);
    wake(workflowId);
  }

  async function resumeFromHistory(records: ExecutionRecord[]): Promise<void> {
    const byId = new Map(records.map((r) => [r.workflowId, r]));
    for (const rec of records) {
      for (const ev of rec.history) {
        if (ev.type === 'childStarted')
          recordChild(rec.workflowId, ev.seq, ev.childId);
      }
    }
    let anyActivity = false;
    for (const rec of records) {
      if (rec.status !== 'running') continue;
      const done = completedSeqs(rec.history);
      for (const ev of rec.history) {
        if (ev.type === 'activityScheduled' && !done.activities.has(ev.seq)) {
          activityTaskQueue.enqueue({
            workflowId: rec.workflowId,
            seq: ev.seq,
            name: ev.name,
            args: ev.args,
            options: ev.options,
          });
          anyActivity = true;
        } else if (ev.type === 'timerStarted' && !done.timers.has(ev.seq)) {
          timerService.schedule(rec.workflowId, ev.seq, ev.fireAt);
        } else if (ev.type === 'childStarted' && !done.children.has(ev.seq)) {
          const child = byId.get(ev.childId);
          if (child && child.status !== 'running') {
            await appendEvent(
              rec.workflowId,
              child.status === 'completed'
                ? { type: 'childCompleted', seq: ev.seq, result: child.result }
                : {
                    type: 'childFailed',
                    seq: ev.seq,
                    error: errorMessage(child.failure),
                  },
            );
          } else {
            parentOfChild.set(ev.childId, {
              parentId: rec.workflowId,
              seq: ev.seq,
            });
          }
        }
      }
      wake(rec.workflowId); // re-drive from history
    }
    if (anyActivity) kickActivityWorker();
  }

  // ── worker-facing seam (out-of-process workers) ──────────────────────────
  async function pollWorkflowTask(): Promise<WorkflowTask | undefined> {
    const leased = workflowTaskQueue.poll();
    if (!leased) return undefined;
    const rec = await historyStore.get(leased.workflowId);
    if (!rec || rec.status !== 'running') {
      workflowTaskQueue.complete(leased.token);
      return undefined;
    }
    // remember the version this task was built at, for the completion-time check
    workflowLeases.set(leased.token, {
      workflowId: leased.workflowId,
      version: rec.version,
    });
    return {
      token: leased.token,
      workflowId: leased.workflowId,
      name: rec.name,
      args: rec.args,
      history: rec.history.slice(),
      continueAsNewSuggested:
        rec.history.length >= CONTINUE_AS_NEW_SUGGEST_THRESHOLD,
    };
  }

  async function completeWorkflowTask(
    token: TaskToken,
    result: WorkflowTaskResult,
  ): Promise<void> {
    const lease = workflowLeases.get(token);
    if (lease) {
      workflowLeases.delete(token);
      const rec = await historyStore.get(lease.workflowId);
      // Optimistic version check: apply only if nothing advanced this execution
      // since the task was built. A lease-race loser sees a bumped version and is
      // discarded — safe, because replay commits no external effects (docs/architecture/distribution.md).
      if (rec && rec.status === 'running' && rec.version === lease.version) {
        await applyWorkflowTaskResult(lease.workflowId, result);
      }
    }
    workflowTaskQueue.complete(token);
  }

  async function pollActivityTask(): Promise<LeasedActivityTask | undefined> {
    const task = activityTaskQueue.poll();
    if (!task) return undefined;
    activityLeases.set(task.token, {
      workflowId: task.workflowId,
      seq: task.seq,
    });
    return task;
  }

  async function completeActivityTask(
    token: TaskToken,
    result: ActivityResult,
  ): Promise<void> {
    const lease = activityLeases.get(token);
    activityTaskQueue.complete(token);
    if (!lease) return; // lease expired → task redelivered → this completer is stale
    activityLeases.delete(token);
    await reportActivityResult(lease.workflowId, lease.seq, result);
  }

  return {
    buildWorkflowTask,
    applyWorkflowTaskResult,
    reportActivityResult,
    appendSignal,
    requestCancel,
    resumeFromHistory,
    pollWorkflowTask,
    completeWorkflowTask,
    pollActivityTask,
    completeActivityTask,
  };
}

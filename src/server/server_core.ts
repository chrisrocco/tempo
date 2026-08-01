/**
 * @fileoverview
 * The orchestration brain. It runs NO user code: workflow replay and activity
 * execution happen in workers that POLL it. The server hands out tasks
 * (buildWorkflowTask / pollActivityTask), applies what workers report back
 * (applyWorkflowTaskResult / reportActivityResult), and owns everything durable
 * via the ports. Waking an execution = enqueuing a workflow task; that queue
 * carries the per-execution exclusion and wake-coalescing guarantees (see
 * `ports/workflow_task_queue.ts`).
 *
 * `applyWorkflowTaskResult` is the transactional heart: on receiving a command
 * batch it appends events, creates downstream tasks, and closes the task —
 * conditional on a version check, so a lease-race loser is discarded.
 *
 * ## Dispatch-and-park, and the marker invariant
 *
 * No operation holds an orchestration frame while it runs. Dispatching an
 * activity, timer, or child writes a **marker event** (`activityScheduled` /
 * `timerStarted` / `childStarted`) and parks the workflow; the completion arrives
 * later as its own event and wakes it via a fresh task.
 *
 * **Every dispatched op must leave its marker** — this is the invariant to
 * respect when adding a command type. Markers do double duty: on replay their
 * presence is what stops a re-emitted command from dispatching a second time
 * (see `core/apply_event`, which no-ops them), and on restart they are the
 * "scheduled before running" record `resume` rebuilds pending work from. Skip the
 * marker and you get a double-dispatch under concurrency and an operation that
 * silently vanishes across a crash.
 *
 * The invariant is about **dispatch, not completion**, which is easy to get
 * backwards. A fire-and-forget child reports nothing back, so it is tempting to
 * record nothing for it — but it was still dispatched, and without the marker the
 * `startChild` command sits in front of the live edge forever: a resumed parent
 * re-emits it and launches a second child, and `childrenByParent` never rebuilds,
 * so `cancelChild` and the cancellation cascade quietly resolve to nothing. Hence
 * `childStarted.detached`: the marker is unconditional, and the flag tells the
 * recovery path which children have a completion coming.
 *
 * `cancelChild` is the one command that legitimately writes no marker of its own.
 * Its effect *is* a durable record — the `cancelRequested` event it appends to the
 * child's history — and `requestCancel` short-circuits on finding one, so a
 * re-dispatched cancel is idempotent rather than a second cancellation.
 *
 * ## `continueAsNew` is a terminal disposition here, not in the core
 *
 * When a command batch contains `continueAsNew`, this is where it becomes real:
 * close the current run, then start a **new run** of the same workflow — same
 * workflowId, new runId, fresh empty history seeded with the carried args — and
 * enqueue a workflow task for it, atomically. Two behaviors live specifically
 * here:
 *
 * - **Children survive.** Continue-as-new is not a real close, so parent-close
 *   policy must not fire — child workflows carry into the new run. Teardown must
 *   not cascade cancellation the way a genuine completion or termination does.
 * - **History accounting resets.** The new run starts empty (the whole point), so
 *   `continueAsNewSuggested` goes back to false on it.
 *
 * Because this threads through the service seam, local mode gets it for free:
 * `LocalService` runs the same close-and-restart against the in-memory store.
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
import { completedSeqs, pendingWork } from './pending_work';

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
  /**
   * The activity worker (in-proc) reports a finished activity: append + wake.
   * Idempotent per seq — a second report for a seq that already has a terminal
   * event is dropped, which is what makes at-least-once delivery harmless.
   */
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

  function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  function appendEvent(workflowId: string, event: HistoryEvent): Promise<void> {
    return historyStore.append(workflowId, [event]);
  }

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
      // Both kinds leave the marker — it is what stops replay re-launching the
      // child, and detached children need that as much as blocking ones do.
      await appendEvent(workflowId, {
        type: 'childStarted',
        seq: cmd.seq,
        childId,
        detached: cmd.detached,
      });
      // Only a blocking child threads a completion back to its parent.
      if (!cmd.detached)
        parentOfChild.set(childId, { parentId: workflowId, seq: cmd.seq });
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
    // Activity delivery is at-least-once, so a seq can be reported twice: a lease
    // expires, the task is redelivered and completed by a second worker, and the
    // first worker — slow, not dead — acks afterwards. The first terminal event
    // for the seq wins and the rest are dropped here. This is the only place that
    // can absorb them: replay cannot, because the waiter is deleted when the
    // first completion resolves, so a second one is a history event for an
    // unknown seq and `core/apply_event` throws nondeterminism on it.
    if (completedSeqs(rec.history).activities.has(seq)) return;
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
    // Both kinds of child go back into childrenByParent: that map is what
    // `cancelChild` and the cancellation cascade resolve through, and a detached
    // child is precisely the one a parent expects to be able to cancel later.
    for (const rec of records) {
      for (const ev of rec.history) {
        if (ev.type === 'childStarted')
          recordChild(rec.workflowId, ev.seq, ev.childId);
      }
    }
    let anyActivity = false;
    for (const rec of records) {
      if (rec.status !== 'running') continue;
      // The same derivation `describeExecution` reports, so what an operator is
      // told this execution awaits is exactly what recovery re-dispatches.
      const pending = pendingWork(rec.history);
      for (const ev of pending.activities) {
        activityTaskQueue.enqueue({
          workflowId: rec.workflowId,
          seq: ev.seq,
          name: ev.name,
          args: ev.args,
          options: ev.options,
        });
        anyActivity = true;
      }
      for (const ev of pending.timers)
        timerService.schedule(rec.workflowId, ev.seq, ev.fireAt);
      for (const ev of pending.children) {
        // A detached child reports nothing back, so there is no completion to
        // synthesize and no parent to reconnect — it resumes as its own
        // execution like any other. Only blocking children are correlated here.
        if (ev.detached) continue;
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
      wake(rec.workflowId); // re-drive from history
    }
    if (anyActivity) kickActivityWorker();
  }

  // ── worker-facing seam (out-of-process workers) ──────────────────────────
  /**
   * The next *runnable* task, or undefined when there is none.
   *
   * An execution can go terminal while its task sits queued, so a drawn entry is
   * not necessarily workable. Those are acked and skipped rather than returned as
   * `undefined`: the distinction matters to a caller that stops draining on
   * `undefined`, which would otherwise abandon real work still behind the dead
   * entry in the queue. A polling worker only paid a wasted idle interval for it,
   * which is why this went unnoticed while the seam had no in-process caller.
   */
  async function pollWorkflowTask(): Promise<WorkflowTask | undefined> {
    while (true) {
      const leased = workflowTaskQueue.poll();
      if (!leased) return undefined;
      const rec = await historyStore.get(leased.workflowId);
      if (!rec || rec.status !== 'running') {
        workflowTaskQueue.complete(leased.token);
        continue;
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
      // discarded — safe, because replay commits no external effects.
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
    // Nothing sweeps this map when the queue expires a lease, so an expired
    // token still resolves here — the redelivery case is caught downstream, by
    // the completion dedup in `reportActivityResult`. `!lease` therefore means
    // only a double-ack of the same token, or a token this server never issued.
    if (!lease) return;
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

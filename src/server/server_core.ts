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
  ActivityScheduledEvent,
  Command,
  ContinueAsNewCommand,
  HistoryEvent,
  LeasedActivityTask,
  ParkedCondition,
  QueueWorkers,
  TaskToken,
  WorkflowTask,
  WorkflowTaskResult,
} from '../protocol';
import {completedSeqs, pendingWork} from './pending_work';
import {createWorkerRegistry} from './worker_registry';
import type {
  ExecutionParent,
  ExecutionRecord,
  HistoryStore,
} from './ports/history_store';
import {silentLogger, type Logger} from './ports/logger';
import type {TaskQueue} from './ports/task_queue';
import type {TimerService} from './ports/timer_service';
import type {WorkflowTaskQueue} from './ports/workflow_task_queue';
import {
  backoffMs,
  maxAttempts,
  shouldRetry,
  workflowTaskBackoffMs,
} from './retry_policy';

/**
 * History length at which the server starts hinting that a workflow should roll
 * over — `continueAsNewSuggested` on the task.
 *
 * 4096 is what Temporal uses (`HistoryCountSuggestContinueAsNew`), and matching
 * it is not just deference: it sits an order of magnitude below where replay
 * cost becomes a problem, which is the property that matters. Temporal's other
 * two tiers, for orientation — it warns at 10,240 events and refuses at 51,200.
 *
 * This was 4 while nothing acted on the hint automatically, which made it a
 * test-scale number sitting in production code. `pollForever` now acts on it, at
 * which point 4 means a rollover every poll: a fresh run and a full record
 * rewrite every cycle, for a poller that found nothing.
 *
 * Count only, deliberately. Temporal also suggests on serialized *size* (4 MB),
 * which is arguably the better signal — 4096 tiny events are nothing, 4 MB is
 * real memory on every replay — but measuring it cheaply on every task is its
 * own design problem, so it is not attempted here.
 */
export const DEFAULT_CONTINUE_AS_NEW_SUGGEST_THRESHOLD = 4096;

/**
 * The id of the child dispatched by the `startChild` at `seq`, in `runId`, of
 * `parentId`.
 *
 * Derived rather than generated, because a counter cannot survive what this has
 * to survive. Server-side counters restart at zero on boot, so a long-running
 * parent that spawns children — a poller, say — collides with its own earlier
 * children the first time the server restarts, and `create` rejects an id that
 * already exists. Lineage is stable across restarts by construction, so there is
 * no state to reconstruct and nothing to get wrong.
 *
 * `runId` is in there because continue-as-new resets history, and with it the
 * `seq` counter: without it, the child at seq 3 of run 0 and the child at seq 3
 * of run 1 would be the same execution. A poller continues as new constantly, so
 * that is the common case rather than an exotic one.
 *
 * Dots read as a path, so a grandchild id shows its whole ancestry:
 * `poller-1.0.3` spawns `poller-1.0.3.0.1`.
 */
export function childExecutionId(
  parentId: string,
  runId: number,
  seq: number,
): string {
  return `${parentId}.${runId}.${seq}`;
}

export interface ServerCoreDeps {
  historyStore: HistoryStore;
  workflowTaskQueue: WorkflowTaskQueue;
  activityTaskQueue: TaskQueue;
  timerService: TimerService;
  /**
   * Create a child execution under an id the core has already chosen, and queue
   * its first task. The id is **not** the host's to invent: a generated one has
   * to be stable across a restart, and only the core knows the lineage that makes
   * it so (see `childExecutionId`).
   */
  launch(
    workflowId: string,
    name: string,
    args: unknown[],
    taskQueue: string,
    parent: ExecutionParent,
  ): void;
  /** Nudge the (async, in-proc) workflow worker to drain the workflow-task queue. */
  kickWorkflowWorker(): void;
  /** Nudge the (async, in-proc) activity worker to drain the activity-task queue. */
  kickActivityWorker(): void;
  /** Where lifecycle events go. Defaults to silence — see `ports/logger`. */
  log?: Logger;
  /**
   * History length at which to start suggesting continue-as-new. Defaults to
   * `DEFAULT_CONTINUE_AS_NEW_SUGGEST_THRESHOLD`.
   *
   * Injectable so that tests exercising rollover can use a small one, rather
   * than the whole system running at test scale to keep them fast — which is how
   * the default came to be 4.
   */
  continueAsNewSuggestThreshold?: number;
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
  /**
   * End an execution outright, without replaying it.
   *
   * The escape hatch `cancel` cannot be. Cancellation is *cooperative*: it
   * appends `cancelRequested` and relies on the workflow replaying to unwind
   * through its own try/catch. On a wedged execution replay is precisely what
   * throws, so a cancel is appended and never applied — the one case where an
   * operator most needs a way out is the one cancellation cannot serve. This
   * settles the record directly and runs no user code.
   */
  terminate(workflowId: string, reason: string): Promise<void>;
  /**
   * Truncate an execution's history to `keep` events and re-drive it.
   *
   * The other way out of a wedged execution, and the one that keeps the work:
   * `terminate` ends it, this rewinds it to before whatever the current code
   * cannot replay. Destructive — the dropped events are gone — and everything
   * dispatched after `keep` is invalidated first so a late completion cannot
   * land on the truncated history. See the implementation for why that order is
   * load-bearing.
   */
  resetToEvent(workflowId: string, keep: number): Promise<void>;
  /** Rebuild correlation + re-dispatch pending work from persisted history (crash recovery). */
  resumeFromHistory(records: ExecutionRecord[]): Promise<void>;
  /**
   * Which task queues are being polled, and when each was last asked.
   *
   * Lives here rather than beside the other read views because it is derived
   * from the poll calls this module serves, not from history — it is the one
   * piece of inspection with no durable record behind it. See
   * `worker_registry.ts`.
   */
  listQueues(): QueueWorkers[];
  /**
   * Drop the timers this core is holding, so a host can shut down.
   *
   * Needed because retry backoffs are **ref'd** — a pending retry is work the
   * process still owes, and must not let it exit silently (see
   * `scheduleProgress`). The cost of that is that an abandoned one would hold a
   * process open, so a host has to be able to let go of them. Attempt deadlines
   * are cleared too; they never held the loop, but leaving them armed after a
   * shutdown would fire `abandonAttempt` against a stopped server.
   */
  stop(): void;
  // ── worker-facing seam (for out-of-process workers; see WorkflowService) ──
  /**
   * Claim the next workflow task. `identity` names the worker asking, so the
   * server can count the fleet and explain a quiet queue; see `WorkerInfo`.
   */
  pollWorkflowTask(
    taskQueue?: string,
    identity?: string,
  ): Promise<WorkflowTask | undefined>;
  completeWorkflowTask(
    token: TaskToken,
    result: WorkflowTaskResult,
  ): Promise<void>;
  /**
   * A worker could not replay this task at all — a bug in the workflow, or a
   * nondeterminism error. Counts the failure durably and re-queues the execution
   * after a backoff. The execution is **never** settled here: workflow code is
   * redeployable, so a fix lets a wedged execution carry on from where it stopped
   * (see planning/sprints/05-phase-6-scope.md).
   */
  failWorkflowTask(token: TaskToken, reason: string): Promise<void>;
  /** Claim the next activity task; `identity` names the worker (see above). */
  pollActivityTask(
    taskQueue?: string,
    identity?: string,
  ): Promise<LeasedActivityTask | undefined>;
  completeActivityTask(token: TaskToken, result: ActivityResult): Promise<void>;
  /**
   * The attempt behind `token` is still alive: renew its lease and reset its
   * silence deadline. Ignored once the server has given up on that attempt.
   */
  heartbeatActivityTask(token: TaskToken): Promise<void>;
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
    log = silentLogger,
    continueAsNewSuggestThreshold = DEFAULT_CONTINUE_AS_NEW_SUGGEST_THRESHOLD,
  } = deps;

  const childrenByParent = new Map<string, Map<number, string>>();
  const parentOfChild = new Map<string, {parentId: string; seq: number}>();
  // Not injected and not persisted: worker liveness is an observation this
  // process made, and must not outlive it. See `worker_registry.ts`.
  const workerRegistry = createWorkerRegistry();
  // Backoffs that will produce work when they fire — a retrying workflow task,
  // a retrying activity. Tracked so `stop` can clear them; see `scheduleProgress`.
  const progressTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * Schedule something that will *make progress* when it fires.
   *
   * Ref'd, unlike the attempt deadlines below, and the distinction is the whole
   * point: a pending retry means work this process still owes someone, so it
   * keeps the process alive exactly as an in-flight activity would. These were
   * unref'd, which let a script whose first attempt failed exit 0 before the
   * retry ever ran — the same silent loss `MemoryTimerService` documents, and
   * invisible for the same reason.
   *
   * Tracked rather than fire-and-forget, because being ref'd means an
   * abandoned one would hold a process open. `stop` clears them, which is what
   * makes `shutdown` still work.
   */
  function scheduleProgress(run: () => void, delayMs: number): void {
    const handle = setTimeout(() => {
      progressTimers.delete(handle);
      run();
    }, delayMs);
    progressTimers.add(handle);
  }
  // Seam bookkeeping: what each handed-out task token maps to, so `complete` can
  // report it back and (for workflow tasks) run the optimistic version check.
  const activityLeases = new Map<
    TaskToken,
    {workflowId: string; seq: number}
  >();
  // `polledAt` exists purely so a completion can report how long the task was out
  // with a worker — the task-latency number Phase 7 wants to aggregate.
  const workflowLeases = new Map<
    TaskToken,
    {workflowId: string; version: number; polledAt: number}
  >();
  // Deadlines for attempts currently out with a worker, so a completion — or a
  // heartbeat, for the silence deadline — can cancel the ones that belong to it.
  interface AttemptTimers {
    startToClose?: ReturnType<typeof setTimeout>;
    heartbeat?: ReturnType<typeof setTimeout>;
  }
  const attemptTimers = new Map<TaskToken, AttemptTimers>();
  // The task behind each live attempt, so a heartbeat can read its options
  // without another trip to history.
  const heartbeatTasks = new Map<TaskToken, LeasedActivityTask>();

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

  /**
   * The one place an event enters durable history, and therefore the one place
   * it is timestamped.
   *
   * The stamp is the *server's* clock at append time, taken once. Workers cannot
   * supply it: they are stateless and interchangeable, so a task's timings would
   * be a mix of whichever machines happened to serve it. And it must not be
   * recomputed on read — an event's time is a fact about when it happened, not
   * about when someone asked.
   *
   * Everything funnels through here so that stays true. `appendSignal` used to
   * call the store directly, which would have left externally injected signals
   * as the one event kind with no time on it — the kind an operator is most
   * likely to be looking for.
   */
  function appendEvent(workflowId: string, event: HistoryEvent): Promise<void> {
    return historyStore.append(workflowId, [{...event, ts: Date.now()}]);
  }

  /**
   * What a parent is told about a child that has reached a terminal state. Three
   * paths need this — a child settling now, a child that settled during an
   * outage, and a claimed id that was already finished when it was claimed — and
   * they must agree on how a terminated child reads to its parent.
   */
  function childOutcomeEvent(
    seq: number,
    child: ExecutionRecord,
  ): HistoryEvent {
    // The id is carried on the outcome as well as on the `childStarted` that
    // dispatched it, so a reader holding one page of a long history can still
    // reach the child — see `ChildCompletedEvent`.
    return child.status === 'completed'
      ? {
          type: 'childCompleted',
          seq,
          result: child.result,
          childId: child.workflowId,
        }
      : {
          type: 'childFailed',
          seq,
          error: errorMessage(child.failure),
          childId: child.workflowId,
        };
  }

  // Wake an execution: it needs another workflow task. The queue coalesces, so a
  // wake during an in-flight task becomes exactly one more task.
  // `taskQueue` is only supplied where it is newly known — creating an execution,
  // or re-driving one after a restart. Every other wake omits it, because the
  // queue remembers an execution's routing from the first enqueue.
  function wake(workflowId: string, taskQueue?: string): void {
    workflowTaskQueue.enqueue(workflowId, taskQueue);
    kickWorkflowWorker();
  }

  // A wake held back, so a failing task retries on a schedule instead of at
  // whatever rate the workers happen to poll. The timer is in-memory: losing it
  // to a restart costs nothing, because `resume` re-enqueues every running
  // execution anyway.
  function wakeAfter(workflowId: string, delayMs: number): void {
    if (delayMs <= 0) {
      wake(workflowId);
      return;
    }
    scheduleProgress(() => wake(workflowId), delayMs);
  }

  async function notifyParentOfTerminal(childId: string): Promise<void> {
    const link = parentOfChild.get(childId);
    if (!link) return;
    parentOfChild.delete(childId);
    const parent = await historyStore.get(link.parentId);
    if (!parent || parent.status !== 'running') return;
    const child = await historyStore.get(childId);
    if (!child) return;
    await appendEvent(link.parentId, childOutcomeEvent(link.seq, child));
    wake(link.parentId);
  }

  timerService.onFire(async (workflowId, seq) => {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return;
    await appendEvent(workflowId, {type: 'timerFired', seq});
    wake(workflowId);
  });

  // Dispatch one command. Everything dispatch-and-parks; its completion arrives
  // later as its own event and wakes the workflow.
  async function applyCommand(
    workflowId: string,
    runId: number,
    taskQueue: string,
    cmd: Command,
  ): Promise<void> {
    if (cmd.type === 'scheduleActivity') {
      await appendEvent(workflowId, {
        type: 'activityScheduled',
        seq: cmd.seq,
        name: cmd.name,
        args: cmd.args,
        options: cmd.options,
      });
      // Inherit the execution's pool unless the activity names one. Defaulting
      // to a global queue instead would send an app's activities to workers that
      // have never heard of them, and the failure would look like a mystery.
      const activityQueue = cmd.options.taskQueue ?? taskQueue;
      activityTaskQueue.enqueue(
        {
          workflowId,
          seq: cmd.seq,
          name: cmd.name,
          args: cmd.args,
          options: cmd.options,
        },
        activityQueue,
      );
      log('activity.scheduled', {
        workflowId,
        seq: cmd.seq,
        name: cmd.name,
        taskQueue: activityQueue,
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
      const childId =
        cmd.workflowId ?? childExecutionId(workflowId, runId, cmd.seq);
      // An id the workflow chose is a claim, not a demand for a new execution:
      // if something already holds it, correlate to that rather than starting a
      // second. This is what makes "one child per calendar event" expressible.
      const existing = await historyStore.get(childId);
      if (existing) {
        log('child.reused', {
          workflowId,
          seq: cmd.seq,
          childId,
          status: existing.status,
        });
      } else {
        // A child is part of the same application unless told otherwise. The
        // parent goes on at creation for both kinds — a detached child has
        // nobody waiting on it, but it still came from somewhere, and that is
        // the question an operator looking at one arrives with.
        launch(
          childId,
          cmd.childName,
          cmd.childArgs,
          cmd.taskQueue ?? taskQueue,
          {workflowId, seq: cmd.seq},
        );
      }
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
      if (!cmd.detached) {
        // A claimed id may already point at a finished execution, in which case
        // no completion is ever coming and the parent would park forever. Settle
        // it now, the same way `resumeFromHistory` settles a child that finished
        // during an outage — and wake the parent, because unlike every other
        // command here this one produces a completion the parent can consume
        // immediately rather than something that will wake it later.
        if (existing && existing.status !== 'running') {
          await appendEvent(workflowId, childOutcomeEvent(cmd.seq, existing));
          wake(workflowId);
        } else {
          parentOfChild.set(childId, {parentId: workflowId, seq: cmd.seq});
        }
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
        rec.history.length >= continueAsNewSuggestThreshold,
      carryover: {...rec.carryover},
    };
  }

  async function applyWorkflowTaskResult(
    workflowId: string,
    result: WorkflowTaskResult,
  ): Promise<void> {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return;
    // Before the dispositions below, all of which return early. What the replay
    // ended parked on is true regardless of how the task then settles — and a
    // task that *completes* the execution reports an empty list, which is what
    // clears the entry left by the task that parked.
    await recordParked(workflowId, rec, result.parked);
    // Note what is deliberately *not* here: storing carryover on every task.
    //
    // The record's carryover is what every task of this run is built from, so
    // updating it mid-run would make two tasks of one run see different values.
    // The workflow re-runs from its first line on every task, so its commands
    // would then depend on state that is not in history and replay would diverge
    // — `nondeterminism at seq N`, and a wedged execution. It is adopted at
    // continue-as-new instead, which is where a new run legitimately begins.
    // Nothing is lost by waiting: the value is a function of the seed and the
    // history, so each replay recomputes it.
    if (result.done) {
      await historyStore.setStatus(workflowId, 'completed', {
        result: result.result,
      });
      log('execution.settled', {
        workflowId,
        status: 'completed',
        historyLength: rec.history.length,
      });
      await notifyParentOfTerminal(workflowId);
      return;
    }
    if (result.failed) {
      await historyStore.setStatus(workflowId, 'failed', {
        failure: result.failure,
        // In-process the stack is on `failure` itself; over RPC that object was
        // flattened to a message and the stack arrives here instead.
        failureStack:
          result.failureStack ??
          (result.failure instanceof Error ? result.failure.stack : undefined),
      });
      log('execution.settled', {
        workflowId,
        status: 'failed',
        historyLength: rec.history.length,
        failure: errorMessage(result.failure),
      });
      await notifyParentOfTerminal(workflowId);
      return;
    }
    const caN = result.commands.find(
      (c): c is ContinueAsNewCommand => c.type === 'continueAsNew',
    );
    if (caN) {
      // Adopt the run's writes first: the new run must be built from them, and
      // this is the one moment where changing the seed cannot split a run.
      if (result.carryover !== undefined)
        await historyStore.setCarryover(workflowId, result.carryover);
      await historyStore.resetForContinueAsNew(workflowId, caN.args);
      wake(workflowId); // drive the fresh run
      return;
    }
    // Dispatch this batch; the execution then parks until a completion wakes it.
    for (const cmd of result.commands)
      await applyCommand(workflowId, rec.runId, rec.taskQueue, cmd);
  }

  /**
   * Store where the workflow is now parked, if that changed.
   *
   * The guard is the point. Most workflows never call `condition`, so both sides
   * are empty on nearly every task — and without the comparison this would add a
   * store write to each one, which for the file adapter is a whole meta rewrite,
   * to record that nothing is waiting on anything.
   *
   * An absent `parked` means the worker predates this and said nothing, which is
   * different from a worker reporting an empty list. Only the latter clears.
   */
  async function recordParked(
    workflowId: string,
    rec: ExecutionRecord,
    parked: ParkedCondition[] | undefined,
  ): Promise<void> {
    if (parked === undefined) return;
    const stored = rec.parked ?? [];
    if (
      stored.length === parked.length &&
      stored.every(
        (s, i) => s.seq === parked[i]?.seq && s.site === parked[i]?.site,
      )
    )
      return;
    await historyStore.setParkedConditions(workflowId, parked);
  }

  /**
   * Put an activity back on the queue for another attempt, after its backoff.
   * The task is rebuilt from the `activityScheduled` marker rather than kept
   * around, so a retry works identically whether the previous attempt failed a
   * moment ago or the server has restarted since it was dispatched.
   *
   * The delay is an in-memory timer. Losing it to a restart costs nothing: the
   * marker is still in history with no completion, so `resume` re-dispatches the
   * activity anyway, and the durable attempt count means the retry budget is not
   * refreshed by the restart.
   */
  function redispatchAfter(
    workflowId: string,
    scheduled: ActivityScheduledEvent,
    taskQueue: string,
    delayMs: number,
  ): void {
    const enqueue = (): void => {
      activityTaskQueue.enqueue(
        {
          workflowId,
          seq: scheduled.seq,
          name: scheduled.name,
          args: scheduled.args,
          options: scheduled.options,
        },
        scheduled.options.taskQueue ?? taskQueue,
      );
      kickActivityWorker();
    };
    if (delayMs <= 0) {
      enqueue();
      return;
    }
    scheduleProgress(enqueue, delayMs);
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
    if (completedSeqs(rec.history).activities.has(seq)) {
      log('activity.duplicate_dropped', {workflowId, seq});
      return;
    }
    // A failed attempt is not yet a failed activity. The retry decision is the
    // server's: it holds the durable attempt count, so the budget survives a
    // worker dying mid-backoff and a server restart, neither of which a
    // worker-side loop can survive.
    // Hoisted out of the failure branch: the dispatch event is now the source of
    // the activity's name for `activity.settled` too, which is emitted on both
    // outcomes. Without a name there, grouping a log stream by activity needs a
    // join back to `activity.scheduled` — see `ActivityRetryGroup`.
    const scheduled = rec.history.find(
      (e): e is ActivityScheduledEvent =>
        e.type === 'activityScheduled' && e.seq === seq,
    );
    if (!result.ok) {
      const retry = scheduled?.options.retry;
      const attempts = await historyStore.recordActivityAttempt(
        workflowId,
        seq,
        result.error,
        scheduled?.name,
      );
      if (scheduled && shouldRetry(retry, attempts)) {
        const delayMs = backoffMs(retry, attempts);
        log('activity.retry_scheduled', {
          workflowId,
          seq,
          name: scheduled.name,
          attempts,
          maxAttempts: maxAttempts(retry),
          delayMs,
          error: result.error,
        });
        // Written before the redispatch is armed, so an operator polling during
        // the backoff never sees an activity waiting on a retry with no time
        // attached to it.
        await historyStore.setActivityNextAttempt(
          workflowId,
          seq,
          Date.now() + delayMs,
        );
        redispatchAfter(workflowId, scheduled, rec.taskQueue, delayMs);
        return;
      }
    }
    await appendEvent(
      workflowId,
      result.ok
        ? {type: 'activityCompleted', seq, result: result.result}
        : {
            type: 'activityFailed',
            seq,
            error: result.error,
            stack: result.stack,
          },
    );
    await historyStore.clearActivityAttempts(workflowId, seq);
    log('activity.settled', {
      workflowId,
      seq,
      name: scheduled?.name,
      ok: result.ok,
      ...(result.ok ? {} : {error: result.error}),
    });
    wake(workflowId);
  }

  async function appendSignal(
    workflowId: string,
    signalName: string,
    payload: unknown,
  ): Promise<void> {
    await appendEvent(workflowId, {
      type: 'signal',
      name: signalName,
      payload,
    });
    wake(workflowId);
  }

  async function requestCancel(workflowId: string): Promise<void> {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return;
    if (rec.history.some((e) => e.type === 'cancelRequested')) return;
    await appendEvent(workflowId, {type: 'cancelRequested'});
    const kids = childrenByParent.get(workflowId);
    if (kids) for (const childId of kids.values()) await requestCancel(childId);
    wake(workflowId);
  }

  async function terminate(workflowId: string, reason: string): Promise<void> {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return; // already settled — idempotent
    // No replay, no commands, no history event: the whole point is that this
    // works on an execution whose replay throws. Children survive, matching what
    // an ordinary close does today.
    await historyStore.setStatus(workflowId, 'terminated', {
      failure: new Error(reason),
    });
    log('execution.settled', {
      workflowId,
      status: 'terminated',
      historyLength: rec.history.length,
      reason,
      taskFailures: rec.taskFailures,
    });
    await notifyParentOfTerminal(workflowId);
    // Any backoff timer still pending is harmless: the wake it produces finds a
    // non-running execution, and `pollWorkflowTask` discards the task.
  }

  /**
   * Replay an execution from an earlier point in its own history.
   *
   * The escape hatch for the case `terminate` was previously the only answer to:
   * a workflow edited while it had live executions, whose replay now throws
   * nondeterminism at some seq. Truncating to before that point and re-driving
   * lets the *new* code produce the commands from there on.
   *
   * ## Why the in-flight work has to be dropped first
   *
   * Everything dispatched after `keep` loses its marker, and the completions are
   * already out with workers. A completion arriving afterwards would find no
   * terminal event for its seq — the dedup in `reportActivityResult` reads
   * history, which no longer has it — and be appended as an outcome for a
   * command the truncated history never issued. Replay then throws on it, which
   * is the exact failure this is supposed to escape.
   *
   * Dropping the lease is what prevents it: `completeActivityTask` returns early
   * when the token resolves to nothing, so a worker still holding the task acks
   * into a no-op. The queued-but-unpolled tasks go the same way, and the timers
   * are cancelled because replay will re-issue them from the truncated point.
   *
   * The version bump in `truncateHistory` closes the matching window for
   * workflow tasks: one already polled fails its CAS instead of appending onto a
   * history it did not replay.
   *
   * ## What it deliberately does not do
   *
   * It does not touch children. A `childStarted` dropped by the truncation does
   * not un-start the child, and replay re-issues `startChild` with the same
   * derived id — which `applyCommand` correlates to the existing execution
   * rather than starting a second. That is the same "claim, not demand" rule an
   * author-chosen child id already follows.
   *
   * `carryover` also survives, for the same reason it survives continue-as-new:
   * it is not history and was never replayed.
   */
  async function resetToEvent(workflowId: string, keep: number): Promise<void> {
    const rec = await historyStore.get(workflowId);
    if (!rec) return;
    // Read everything this needs up front. A store may hand back the live record
    // rather than a copy — the in-memory one does — so any field read after the
    // mutations below describes the state *after* them, which is how the first
    // version of this logged "dropped 0 events" every time.
    const before = {
      historyLength: rec.history.length,
      taskFailures: rec.taskFailures,
      status: rec.status,
      taskQueue: rec.taskQueue,
      attemptSeqs: Object.keys(rec.activityAttempts).map(Number),
      timers: pendingWork(rec.history).timers,
    };
    const bounded = Math.max(0, Math.min(keep, before.historyLength));

    // Order matters: leases go before the truncate so that nothing can settle
    // against the old history in the window between the two.
    for (const [token, lease] of [...activityLeases]) {
      if (lease.workflowId !== workflowId) continue;
      activityLeases.delete(token);
      clearAttemptTimers(token);
      activityTaskQueue.complete(token);
    }
    for (const timer of before.timers)
      timerService.cancel(workflowId, timer.seq);

    await historyStore.truncateHistory(workflowId, bounded);
    // A truncated dispatch's retry budget describes attempts at a command that
    // no longer exists; leaving it would charge the replayed one for them.
    for (const seq of before.attemptSeqs)
      await historyStore.clearActivityAttempts(workflowId, seq);
    // The failure count is why someone is here. Leaving it would keep the
    // execution reading as stuck until the next task happened to succeed.
    await historyStore.clearTaskFailures(workflowId);
    // A settled execution has to be reopened, or the task enqueued below is
    // built and immediately discarded — `buildWorkflowTask` only builds for a
    // running record. Reset means rewind and re-drive whatever the current
    // status, because "it failed, I fixed the code, run it again from before
    // the failure" is one of the two reasons anyone reaches for this. The old
    // outcome goes with it: it describes events that no longer exist.
    if (before.status !== 'running')
      await historyStore.setStatus(workflowId, 'running', {
        result: undefined,
        failure: undefined,
        failureStack: undefined,
      });

    log('execution.reset', {
      workflowId,
      keep: bounded,
      dropped: before.historyLength - bounded,
      reopenedFrom: before.status === 'running' ? undefined : before.status,
      taskFailures: before.taskFailures,
    });
    workflowTaskQueue.enqueue(workflowId, before.taskQueue);
    kickWorkflowWorker();
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
        activityTaskQueue.enqueue(
          {
            workflowId: rec.workflowId,
            seq: ev.seq,
            name: ev.name,
            args: ev.args,
            options: ev.options,
          },
          ev.options.taskQueue ?? rec.taskQueue,
        );
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
          await appendEvent(rec.workflowId, childOutcomeEvent(ev.seq, child));
        } else {
          parentOfChild.set(ev.childId, {
            parentId: rec.workflowId,
            seq: ev.seq,
          });
        }
      }
      wake(rec.workflowId, rec.taskQueue); // re-drive, on its own queue
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
  /**
   * The fleet, with each worker's poll record joined to what it is holding.
   *
   * The join is here rather than in `worker_registry` because the two halves
   * live in different places and neither should learn about the other: the
   * registry watches polls and the lease tables watch claims. This is the only
   * component that holds both, which makes it the only one that can say a
   * silent worker is mid-task rather than gone — the distinction the whole
   * identity-on-poll change exists to make. See `WorkerInfo.busy`.
   */
  function listQueues(): QueueWorkers[] {
    const holders = {
      workflow: workflowTaskQueue.leaseHolders(),
      activity: activityTaskQueue.leaseHolders(),
    };
    return workerRegistry.queues().map((queue) => ({
      ...queue,
      workers: queue.workers.map((worker) => ({
        ...worker,
        busy: holders[worker.role].has(worker.identity),
      })),
    }));
  }

  async function pollWorkflowTask(
    taskQueue?: string,
    identity?: string,
  ): Promise<WorkflowTask | undefined> {
    // Before the queue is consulted, so an idle poll counts. A worker waiting
    // on an empty queue is the strongest evidence of liveness there is, and
    // recording only polls that found work would report a healthy idle fleet as
    // absent — the exact inversion of what this is for.
    workerRegistry.recordPoll('workflow', taskQueue, identity);
    while (true) {
      const leased = workflowTaskQueue.poll(taskQueue, identity);
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
        polledAt: Date.now(),
      });
      return {
        token: leased.token,
        workflowId: leased.workflowId,
        name: rec.name,
        args: rec.args,
        history: rec.history.slice(),
        carryover: {...rec.carryover},
        continueAsNewSuggested:
          rec.history.length >= continueAsNewSuggestThreshold,
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
        log('workflow_task.completed', {
          workflowId: lease.workflowId,
          durationMs: Date.now() - lease.polledAt,
          commands: result.commands.length,
          historyLength: rec.history.length,
        });
        // A task got through, so whatever was failing is not failing now — start
        // the backoff schedule over rather than carrying a stale count forward.
        if (rec.taskFailures > 0)
          await historyStore.clearTaskFailures(lease.workflowId);
      } else {
        log('workflow_task.discarded', {
          workflowId: lease.workflowId,
          reason: 'execution advanced while the task was out',
        });
      }
    }
    workflowTaskQueue.complete(token);
  }

  async function failWorkflowTask(
    token: TaskToken,
    reason: string,
  ): Promise<void> {
    const lease = workflowLeases.get(token);
    // Ack first: while the task is still leased the queue folds any enqueue into
    // its rerun flag and redelivers the moment it is completed, which would skip
    // the backoff entirely.
    workflowTaskQueue.complete(token);
    if (!lease) return;
    workflowLeases.delete(token);
    const rec = await historyStore.get(lease.workflowId);
    if (!rec || rec.status !== 'running') return; // settled or terminated meanwhile
    const failures = await historyStore.recordTaskFailure(
      lease.workflowId,
      reason,
    );
    const backoffMs = workflowTaskBackoffMs(failures);
    // The wedged-execution signal. Nothing alerts on it yet (Phase 7), but a
    // consecutive count climbing in the log is the thing to alert on.
    log('workflow_task.failed', {
      workflowId: lease.workflowId,
      reason,
      consecutiveFailures: failures,
      retryInMs: backoffMs,
      durationMs: Date.now() - lease.polledAt,
    });
    wakeAfter(lease.workflowId, backoffMs);
  }

  /**
   * Stop waiting on an attempt and record it as failed.
   *
   * The server cannot stop a worker mid-activity — there is no channel back into
   * a running attempt, with or without heartbeats. What it can do is stop
   * *waiting*, record the outcome, and take the task out of the queue so the
   * lease does not later redeliver it into a second concurrent run. That ack is
   * what turns a deadline into a bound rather than just an early failure.
   *
   * Two deadlines end here and they mean different things: `startToClose` says
   * the attempt took too long, `heartbeat` says it went quiet. Both are failures
   * of the attempt, not of the activity — the retry policy applies to each.
   */
  function abandonAttempt(
    task: LeasedActivityTask,
    kind: 'startToClose' | 'heartbeat',
    timeoutMs: number,
  ): void {
    const lease = activityLeases.get(task.token);
    if (!lease) return; // already settled
    activityLeases.delete(task.token);
    clearAttemptTimers(task.token);
    activityTaskQueue.complete(task.token); // no redelivery for this attempt
    log('activity.timed_out', {
      workflowId: lease.workflowId,
      seq: lease.seq,
      name: task.name,
      kind,
      timeoutMs,
    });
    void reportActivityResult(lease.workflowId, lease.seq, {
      ok: false,
      error:
        kind === 'heartbeat'
          ? `activity ${task.name} stopped heartbeating for ${timeoutMs}ms`
          : `activity ${task.name} timed out after ${timeoutMs}ms`,
    });
  }

  /** Arm one of an attempt's deadlines, replacing any timer already set for it. */
  function armAttemptTimer(
    task: LeasedActivityTask,
    kind: 'startToClose' | 'heartbeat',
    timeoutMs: number,
  ): void {
    const timers = attemptTimers.get(task.token) ?? {};
    if (timers[kind]) clearTimeout(timers[kind]);
    const timer = setTimeout(
      () => abandonAttempt(task, kind, timeoutMs),
      timeoutMs,
    );
    timer.unref?.(); // a pending deadline must not hold the process open
    timers[kind] = timer;
    attemptTimers.set(task.token, timers);
  }

  function clearAttemptTimers(token: TaskToken): void {
    const timers = attemptTimers.get(token);
    if (!timers) return;
    if (timers.startToClose) clearTimeout(timers.startToClose);
    if (timers.heartbeat) clearTimeout(timers.heartbeat);
    attemptTimers.delete(token);
  }

  async function pollActivityTask(
    taskQueue?: string,
    identity?: string,
  ): Promise<LeasedActivityTask | undefined> {
    // See the note in `pollWorkflowTask`: recorded before the queue is
    // consulted, so an idle poll still counts as liveness.
    workerRegistry.recordPoll('activity', taskQueue, identity);
    const task = activityTaskQueue.poll(taskQueue, identity);
    if (!task) return undefined;
    activityLeases.set(task.token, {
      workflowId: task.workflowId,
      seq: task.seq,
    });
    // Armed on poll, not on dispatch: both deadlines bound the attempt, and the
    // attempt begins when a worker takes the task, not when it was queued.
    const {startToCloseTimeoutMs, heartbeatTimeoutMs} = task.options;
    if (startToCloseTimeoutMs !== undefined && startToCloseTimeoutMs > 0)
      armAttemptTimer(task, 'startToClose', startToCloseTimeoutMs);
    // The heartbeat clock starts now, so an attempt that never beats at all is
    // caught just as surely as one that stops partway.
    if (heartbeatTimeoutMs !== undefined && heartbeatTimeoutMs > 0)
      armAttemptTimer(task, 'heartbeat', heartbeatTimeoutMs);
    heartbeatTasks.set(task.token, task);
    return task;
  }

  async function heartbeatActivityTask(token: TaskToken): Promise<void> {
    const lease = activityLeases.get(token);
    const task = heartbeatTasks.get(token);
    // Silence is the only signal the server has, so a heartbeat for an attempt
    // it already gave up on must not resurrect anything: the task belongs to
    // whoever holds it now.
    if (!lease || !task) return;
    if (!activityTaskQueue.renew(token)) return;
    const timeoutMs = task.options.heartbeatTimeoutMs;
    if (timeoutMs !== undefined && timeoutMs > 0)
      armAttemptTimer(task, 'heartbeat', timeoutMs);
    log('activity.heartbeat', {
      workflowId: lease.workflowId,
      seq: lease.seq,
      name: task.name,
    });
  }

  async function completeActivityTask(
    token: TaskToken,
    result: ActivityResult,
  ): Promise<void> {
    const lease = activityLeases.get(token);
    clearAttemptTimers(token); // this attempt is over, whatever it reported
    heartbeatTasks.delete(token);
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
    terminate,
    resetToEvent,
    resumeFromHistory,
    listQueues,
    stop() {
      for (const handle of progressTimers) clearTimeout(handle);
      progressTimers.clear();
      for (const token of [...attemptTimers.keys()]) clearAttemptTimers(token);
    },
    pollWorkflowTask,
    completeWorkflowTask,
    failWorkflowTask,
    pollActivityTask,
    completeActivityTask,
    heartbeatActivityTask,
  };
}

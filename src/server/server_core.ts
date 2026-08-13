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
 * later as its own event and wakes it via a fresh task. `cancelChild` and
 * `signalWorkflow` write markers too and park nothing — they are dispatched and
 * finished in the same breath, which is a difference in what is *owed back*, not
 * in whether the dispatch is recorded.
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
 * **Every** command leaves one, with no exceptions left. `cancelChild` used to be
 * the exception, on the grounds that its effect is already a durable record — the
 * `cancelRequested` it appends to the *child's* history — and that `requestCancel`
 * short-circuits on finding one, so a re-dispatched cancel is idempotent rather
 * than a second cancellation. All of that is still true, and it is an argument
 * about **safety**: re-dispatch does no harm.
 *
 * It stopped being sufficient when replay began deciding what to emit by asking
 * whether history holds a command's seq (`core/workflow_api`). That question needs
 * **observability**, and a record living on another execution cannot supply it: a
 * cancel that reached the workflow mid-batch was dropped and never re-issued, with
 * not even a gap in the seqs to notice — the wedge of issue #39, surviving in the
 * one place its fix could not see (issue #50). `childCancelRequested` is what
 * closes it.
 *
 * `recordPatch` is the invariant read from the other end: a command that is
 * *nothing but* its marker. It dispatches no work, so there is no "record the
 * dispatch" to do — what it makes durable is a decision workflow code took, so that
 * a later replay by later code reaches the same fork (see `core/workflow_api.patched`).
 * It is the one command for which the ordering question below does not arise.
 *
 * ## Where the marker is written, and how little of that is forced
 *
 * Two branches of `applyCommand` write the marker before dispatching and three
 * write it after, which looks like an inconsistency and mostly is not one. Every
 * marker records the same fact — *this command was dispatched* — so the ordering
 * is not a difference in what is being recorded. It is a difference in **what can
 * rebuild the work afterwards if the process dies between the two writes.**
 *
 * `startChild`, `cancelChild` and `signalWorkflow` write theirs **last, and
 * must.** `resume` re-enqueues a pending `activityScheduled` and re-arms a pending
 * `timerStarted`, but it never *launches* a child, and does not re-drive cancels
 * or signals at all. So a marker written before the dispatch and then lost to a
 * crash leaves a marker for work nothing will ever create: the command suppressed
 * on the next replay, the parent waiting forever, nothing raised. Their recovery
 * is replay re-emitting the command, which is safe because all three dispatches
 * are idempotent — an id claim correlates to the existing execution,
 * `requestCancel` short-circuits on an existing `cancelRequested`, and a re-sent
 * signal is recognized by its `SignalSource` and dropped. A marker written first
 * is exactly what would suppress that recovery.
 *
 * Note which way that argument runs for the newest of the three. Idempotence was
 * a property `startChild` and `cancelChild` already had; `signalWorkflow` was
 * *given* one, because without it neither ordering is right — marker-first loses
 * the signal silently, marker-last duplicates it silently. "Which write goes
 * first" is answerable only once the dispatch can survive being repeated.
 *
 * `scheduleActivity` and `startTimer` write theirs **first, and that is
 * precautionary rather than forced.** It keeps the property `resume` reads —
 * nothing is dispatched that history does not already record as intended, the
 * "scheduled before running" phrasing above. But the window it closes was not
 * reachable when tried: moving the append after the enqueue, and then after
 * `kickActivityWorker` as well, left the suite green, and a completion could not
 * be made to land before its own marker under either store. The reason it is
 * unreachable is that the worker's poll path happens to yield more than the write
 * does, which is an accident of this implementation rather than a guarantee — so
 * the ordering stays, as cheap insurance against that changing. Do not read it as
 * load-bearing the way the two above are.
 *
 * ## `continueAsNew` is a terminal disposition here, not in the core
 *
 * When a command batch contains `continueAsNew`, this is where it becomes real:
 * roll the execution over into a fresh run — same workflowId, bumped runId,
 * history emptied and reseeded with the carried args — and enqueue a workflow
 * task for it, atomically.
 *
 * "New run" is a description of the *state*, not of a second record. There is
 * one `ExecutionRecord` per workflowId and the rollover overwrites it, so the
 * previous run's events are gone the moment this happens and cannot be read
 * back. That is a decision (ticket 05) and `resetForContinueAsNew` in
 * `ports/history_store.ts` owns the reasoning.
 *
 * Two behaviors live specifically here:
 *
 * - **Children survive.** Continue-as-new is not a real close, so a rollover must
 *   not tear down what the previous run started — child workflows carry into the
 *   new run. That is load-bearing for the poller-in-a-child shape, whose whole
 *   point is a child that outlives its parent's history.
 * - **History accounting resets.** The new run starts empty (the whole point), so
 *   `continueAsNewSuggested` goes back to false on it.
 *
 * Because this threads through the service seam, local mode gets it for free:
 * `LocalService` runs the same close-and-restart against the in-memory store.
 *
 * ## What a closing execution does to its children
 *
 * Two different questions, easily conflated, answered in two different places.
 *
 * **Cancelling** a parent cascades to every child unconditionally, in
 * `requestCancel`. Cancelling says *stop this work*, and a subtree of it is still
 * that work.
 *
 * **Closing** — completing, failing, or being terminated — applies each child's
 * own `parentClosePolicy` in `closeChildren`, recorded on its `childStarted`
 * marker when it was dispatched. `terminate` ends it, `cancel` asks it to unwind,
 * `abandon` leaves it running. `protocol/parent_close_policy.ts` owns the choice
 * of the three, the default, and why the two questions are kept apart.
 *
 * Both are the same three call sites the parent's own outcome flows through, so
 * `closeChildren` sits beside `notifyParentOfTerminal`: one tells the generation
 * above, the other deals with the one below. It recurses for free — the `terminate`
 * it calls itself closes, so a whole subtree comes down — and terminates on
 * cycles, because `terminate` returns early on an execution that is not running.
 *
 * Continue-as-new is not a close and fires nothing, which is the bullet above.
 */

import type {
  ActivityResult,
  ActivityScheduledEvent,
  Command,
  ContinueAsNewCommand,
  HistoryEvent,
  LeasedActivityTask,
  PollRequest,
  ExecutionStatus,
  ParentClosePolicy,
  ParkedCondition,
  QueueWorkers,
  WorkflowReport,
  WorkflowReportRequest,
  WorkflowSummary,
  SignalSource,
  TaskToken,
  WorkflowTask,
  WorkflowTaskResult,
} from '../protocol';
import {ANY_TASK_QUEUE} from '../protocol';
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

/**
 * One child, as its parent remembers it: which execution, and what to do with it
 * when the parent closes.
 *
 * In memory rather than derived from history on demand, because the two callers
 * that need it — `cancelChild` and `closeChildren` — both run at moments where a
 * history scan per child would be the wrong shape. It is rebuilt from the
 * `childStarted` markers on restart, which is why the policy has to be on them.
 */
interface ChildLink {
  childId: string;
  parentClosePolicy: ParentClosePolicy;
}

export interface ServerCoreDeps {
  historyStore: HistoryStore;
  workflowTaskQueue: WorkflowTaskQueue;
  activityTaskQueue: TaskQueue;
  timerService: TimerService;
  /**
   * Create an execution under an id the core has already chosen, and queue its
   * first task. The id is **not** the host's to invent: a generated one has to be
   * stable across a restart, and only the core knows the lineage that makes it so
   * (see `childExecutionId`).
   *
   * `parent` is absent for a `startWorkflow` dispatch, which is the one caller that
   * starts an execution with no lineage at all. Optional rather than a second method
   * because the host does the same work either way — the parent is a field on the
   * record, and the difference is entirely in what the core hands over.
   */
  launch(
    workflowId: string,
    name: string,
    args: unknown[],
    taskQueue: string,
    parent: ExecutionParent | undefined,
  ): void;
  /** Nudge the (async, in-proc) workflow worker to drain the workflow-task queue. */
  kickWorkflowWorker(): void;
  /** Nudge the (async, in-proc) activity worker to drain the activity-task queue. */
  kickActivityWorker(): void;
  /**
   * An execution reached a terminal state, however it got there.
   *
   * Exists because not every settle follows a workflow task. `LocalService`
   * learns an execution's outcome by watching its own drain loop — it applies a
   * task, re-reads the record, and settles the caller's `getResult` — and
   * `terminate` produces no task at all, so it used to patch its bookkeeping by
   * hand from the client side.
   *
   * That stopped being enough when the server acquired a reason of its own to
   * terminate an execution nobody asked about: a child whose parent closed under
   * a `terminate` policy (see `closeChildren`). Without this the child would be
   * `terminated` on the record while local mode still reported it `running`, and
   * anyone holding its `getResult` promise would wait forever for an outcome
   * that had already happened.
   *
   * Called at every terminal transition rather than only that one, so there is
   * no rule to remember about which settles are observable. Optional because a
   * host that reads the store — the RPC server does — needs none of it.
   */
  onSettled?(
    workflowId: string,
    status: ExecutionStatus,
    outcome: {result?: unknown; failure?: unknown},
  ): void;
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
  /**
   * Request cancellation, cascading to **every** child this execution started.
   *
   * Not only the fire-and-forget ones, which is what this used to say: both kinds
   * go into `childrenByParent`, so a blocking child is cancelled alongside a
   * detached one. That is the intended behaviour — a parent unwinding through a
   * `CancelledFailure` is not going to consume the result it was awaiting — and
   * cancellation remains the only thing that walks downward at all (see the
   * header).
   */
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
  /** Record what a worker says it has registered. See `WorkflowReportRequest`. */
  reportWorkflows(report: WorkflowReportRequest): void;
  /** Every workflow any worker has reported, deduped by name. */
  listWorkflows(): WorkflowSummary[];
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
  pollWorkflowTask(request?: PollRequest): Promise<WorkflowTask | undefined>;
  completeWorkflowTask(
    token: TaskToken,
    result: WorkflowTaskResult,
  ): Promise<void>;
  /**
   * A worker could not replay this task at all — a bug in the workflow, or a
   * nondeterminism error. Counts the failure durably and re-queues the execution
   * after a backoff.
   *
   * **The execution is never settled here, and that is a decision.** The original
   * plan was to dead-letter a poison execution past some threshold. Temporal's
   * design won instead: a failing workflow task retries indefinitely with backoff,
   * the execution stays open, and the failure is made impossible to miss rather
   * than fatal.
   *
   * What decided it: a workflow-task failure is almost always a *code* bug, and
   * workflow code is redeployable. Fix it, roll the workers, and the execution
   * replays past the throw and carries on — work auto-termination would have
   * destroyed. Loud and recoverable beats terminal and diagnosable.
   *
   * That trade only holds while the loudness is real, which is what makes the
   * attempt count, the retained reason, and `describe` load-bearing rather than
   * nice-to-have. Two things follow and are not optional:
   *
   * - **`terminate` is mandatory**, not a convenience. Retrying forever with no
   *   way out is worse than the bug.
   * - **No per-attempt *failure* events.** The counter lives on `ExecutionRecord`;
   *   history records the *first* failure so the log shows something went wrong,
   *   not one event per failure. Temporal keeps attempt counts in mutable state for
   *   the same reason — history bloat — and it applies here with more force, since
   *   every task replays the whole history.
   *
   *   **Narrowed twice, and what survives is a line rather than a rule.** Each
   *   *pickup* appends an `activityStarted` (see `pollActivityTask`), because the
   *   alternative left queue time and execution time indistinguishable and made a
   *   retried activity's span cover every attempt plus every backoff gap as one bar.
   *   Each activity retry now appends an `activityRetryScheduled` too, because a
   *   started attempt with no completion could otherwise mean either "running" or
   *   "idle in backoff" — opposite readings of the same silence.
   *
   *   What stays out is a per-failure event for a *workflow task*, and the reason it
   *   stays out is the reason the other two came in. An activity's failures are
   *   bounded by `maximumAttempts`, a number the author chose; a workflow task's are
   *   bounded by nothing at all, by the design at the top of this comment. The rule
   *   is therefore about the budget, not about history bloat in the abstract: events
   *   per failure are affordable exactly where the failures are capped. Here they
   *   are not, and the counter with the retained reason is what answers instead.
   */
  failWorkflowTask(token: TaskToken, reason: string): Promise<void>;
  /** Claim the next activity task; `identity` names the worker (see above). */
  pollActivityTask(
    request?: PollRequest,
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
    onSettled = () => {},
    log = silentLogger,
    continueAsNewSuggestThreshold = DEFAULT_CONTINUE_AS_NEW_SUGGEST_THRESHOLD,
  } = deps;

  // Keyed by the `startChild` seq that spawned each child, so `cancelChild` can
  // resolve a target the workflow named by seq. The policy rides along because
  // this map is also what a closing parent is applied against — see `closeChildren`.
  const childrenByParent = new Map<string, Map<number, ChildLink>>();
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

  function recordChild(
    parentId: string,
    seq: number,
    childId: string,
    parentClosePolicy: ParentClosePolicy,
  ): void {
    let kids = childrenByParent.get(parentId);
    if (!kids) {
      kids = new Map();
      childrenByParent.set(parentId, kids);
    }
    kids.set(seq, {childId, parentClosePolicy});
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

  /**
   * Apply each child's parent-close policy, now that this execution has closed.
   *
   * Called from all three terminal paths — completed, failed, terminated — and
   * from none of the others. A rollover is not a close (`continueAsNew` keeps its
   * children by design) and a cancel is not one either: cancellation cascades
   * unconditionally in `requestCancel`, and the policy is deliberately not
   * consulted there. `parent_close_policy.ts` owns that distinction.
   *
   * Recursion falls out of the shape rather than being written: `terminate` is
   * itself a close, so terminating a child closes *its* children in turn, and a
   * whole subtree comes down. A cycle — reachable only by a workflow claiming an
   * ancestor's id — cannot spin, because `terminate` and `requestCancel` both
   * return early on an execution that is no longer running.
   *
   * **`terminate` does not overrule a cancel already in flight.** A child holding
   * a `cancelRequested` is already tearing itself down through its own
   * `try`/`finally`, and the common way to reach that state is the parent being
   * cancelled — whose own failure then arrives here a moment later. Killing the
   * child at that point would cut short the cleanup the cascade just asked it to
   * do, and would quietly turn "cancel a parent" into "terminate its children".
   * The escape hatch stays available: an operator terminating a wedged child
   * still terminates it.
   */
  async function closeChildren(workflowId: string): Promise<void> {
    const kids = childrenByParent.get(workflowId);
    if (!kids) return;
    for (const child of [...kids.values()]) {
      if (child.parentClosePolicy === 'abandon') continue;
      if (child.parentClosePolicy === 'cancel') {
        await requestCancel(child.childId);
        continue;
      }
      const rec = await historyStore.get(child.childId);
      if (!rec || rec.status !== 'running') continue;
      if (rec.history.some((e) => e.type === 'cancelRequested')) continue;
      await terminate(child.childId, `parent ${workflowId} closed`);
    }
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
      recordChild(workflowId, cmd.seq, childId, cmd.parentClosePolicy);
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
    } else if (cmd.type === 'startWorkflow') {
      // The same claim check `startChild` makes, and here it is the entire dedup
      // story: an independent start threads nothing back, so a caller cannot notice
      // a duplicate the way a parent awaiting a child would.
      const existing = await historyStore.get(cmd.targetId);
      if (existing) {
        log('workflow.start_reused', {
          workflowId,
          seq: cmd.seq,
          targetId: cmd.targetId,
          status: existing.status,
        });
      } else {
        // No parent argument, and that is the point of the command rather than an
        // omission. `recordChild` is deliberately not called either: nothing here
        // enters `childrenByParent`, so no close policy fires on it and the
        // cancellation cascade cannot reach it.
        launch(
          cmd.targetId,
          cmd.name,
          cmd.args,
          cmd.taskQueue ?? taskQueue,
          undefined,
        );
      }
      // Marker last, like `startChild`, `cancelChild` and `signalWorkflow`, and
      // safe for the reason `signalWorkflow` needs and gets from `SignalSource`:
      // the dispatch is idempotent. Here the claim check above is what provides
      // it — a replayed command finds the execution it created and correlates.
      await appendEvent(workflowId, {
        type: 'workflowStarted',
        seq: cmd.seq,
        targetId: cmd.targetId,
        name: cmd.name,
        created: !existing,
      });
    } else if (cmd.type === 'cancelChild') {
      const childId = childrenByParent
        .get(workflowId)
        ?.get(cmd.targetSeq)?.childId;
      if (childId) await requestCancel(childId);
      // Marker last, like `startChild` above and for the same reason — nothing
      // re-drives a cancel, so replay re-emitting the command is its only
      // recovery, and a marker written first is what would suppress it. The
      // header section on write ordering owns the argument.
      //
      // Worth knowing while reading it: on the happy path both orderings finish
      // with both effects done and are indistinguishable. The crash window is
      // the entire argument. What makes it worth ordering deliberately anyway is
      // that the failure is silent — a cancel suppressed by its own marker never
      // happens and never reports.
      //
      // Recorded even when no child was found. The marker is the record of
      // *dispatch*, not of effect: a cancel naming a seq this parent never
      // spawned is still a cancel the workflow issued and must not issue twice,
      // and the alternative — no marker on that path — puts the silent drop back
      // exactly where it was.
      await appendEvent(workflowId, {
        type: 'childCancelRequested',
        seq: cmd.seq,
        targetSeq: cmd.targetSeq,
      });
    } else if (cmd.type === 'signalWorkflow') {
      const delivered = await deliverSignal(
        cmd.targetId,
        cmd.signalName,
        cmd.payload,
        {workflowId, runId, seq: cmd.seq},
      );
      if (!delivered)
        // Logged rather than thrown, and logged even though the marker records
        // it too: the sender cannot see the marker (nothing parks on a signal it
        // sent), and an operator watching a poller relay items has no reason to
        // be reading its history until something has already gone wrong.
        log('signal.undelivered', {
          workflowId,
          seq: cmd.seq,
          targetId: cmd.targetId,
          name: cmd.signalName,
        });
      // Marker last, like `startChild` and `cancelChild`, and forced for the same
      // reason: nothing re-drives a signal on restart, so replay re-emitting the
      // command is its only recovery, and a marker written first would suppress
      // it. What makes that safe here is that the delivery is idempotent —
      // `deliverSignal` recognizes its own re-send by `SignalSource`. Without
      // that dedup neither ordering would be right: marker-first silently loses
      // the signal, marker-last silently duplicates it.
      await appendEvent(workflowId, {
        type: 'workflowSignaled',
        seq: cmd.seq,
        targetId: cmd.targetId,
        signalName: cmd.signalName,
        delivered,
      });
    } else if (cmd.type === 'recordPatch') {
      // The one command with no dispatch at all: the marker *is* the effect. The
      // workflow decided which side of a version branch it is on and is asking for
      // that to be durable, so there is nothing to enqueue, nothing to arm, nobody
      // to tell, and no ordering question to answer — the two writes the section
      // above weighs against each other are one write here.
      //
      // Nothing is logged either. Every other line in this function reports work
      // entering the system; this reports that a replay agreed with itself, which
      // is the normal case on every task of every patched execution and would be
      // pure volume. The marker is in history, which is where an operator asking
      // "did this execution get the fix" looks.
      await appendEvent(workflowId, {
        type: 'patchRecorded',
        seq: cmd.seq,
        patchId: cmd.patchId,
      });
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
      // Straight off the record: a child's parentage is durable and unchanging,
      // so this is the same value on every task of every run.
      parent: rec.parent && {...rec.parent},
    };
  }

  async function applyWorkflowTaskResult(
    workflowId: string,
    result: WorkflowTaskResult,
  ): Promise<void> {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return;
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
    const caN = result.commands.find(
      (c): c is ContinueAsNewCommand => c.type === 'continueAsNew',
    );
    // Dispatch before settling, not instead of it. A task can both issue
    // commands and finish the workflow — `signalWorkflow(parent, done); return
    // result;` is one activation — and the dispositions below all return early,
    // so a batch reaching them used to be discarded. Nothing raised: the
    // execution completed normally, having silently not done what its last line
    // said. Every command has this shape, and the fire-and-forget ones have it
    // worst, since they are the ones with no promise whose absence would be
    // noticed.
    //
    // Safe for a settling execution because a dispatch outliving it is already
    // the rule elsewhere: children survive a close, a timer that fires against a
    // settled record is dropped by `timerService.onFire`, and a late activity
    // completion is dropped by `reportActivityResult`. The work is done, its
    // result goes nowhere, and that is what "the workflow asked for it and then
    // returned" should mean.
    //
    // **Except on continue-as-new**, which is why this is guarded. A rollover
    // empties history, so a marker written a moment earlier is erased — and an
    // armed timer whose `timerStarted` went with it fires into a fresh run that
    // never issued that seq, which is a nondeterminism error and a wedged
    // execution. Dropping a command there is wrong too, but it is wrong in a way
    // that needs its own design rather than a reordering.
    if (!caN)
      for (const cmd of result.commands)
        await applyCommand(workflowId, rec.runId, rec.taskQueue, cmd);
    // After the batch and before the dispositions, and both halves are load-bearing.
    //
    // *Before the dispositions* because they all return early: what the replay ended
    // parked on is true regardless of how the task then settles, and a task that
    // completes the execution reports an empty list, which is what clears the entry
    // left by the task that parked.
    //
    // *After the batch* because this now appends history of its own. An activation
    // that dispatches and then parks did those things in that order — recording the
    // park first would put a workflow's wait ahead of the dispatch it is waiting for,
    // which is wrong in the one place these events exist to be read: a timeline.
    await recordParked(workflowId, rec, result.parked);
    if (result.done) {
      await historyStore.setStatus(workflowId, 'completed', {
        result: result.result,
      });
      log('execution.settled', {
        workflowId,
        status: 'completed',
        historyLength: rec.history.length,
      });
      // A settled execution is not waiting on anything, so nothing should still be
      // armed on its behalf. Dropping them is not required for correctness: onFire
      // already ignores a fire for a non-running record, and `resumeFromHistory` skips
      // one on restart — but an hour-long sleep in a cancelled workflow otherwise keeps
      // a live handle for an hour, and long sleeps in cancelled executions is exactly
      // the scheduler shape.
      timerService.cancelAll(workflowId);
      onSettled(workflowId, 'completed', {result: result.result});
      // Children before the parent: by the time the generation above is woken by
      // this outcome, the generation below has already been dealt with, so an
      // execution reading its child's result never sees a subtree mid-teardown.
      await closeChildren(workflowId);
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
      // A settled execution is not waiting on anything, so nothing should still be
      // armed on its behalf. Dropping them is not required for correctness: onFire
      // already ignores a fire for a non-running record, and `resumeFromHistory` skips
      // one on restart — but an hour-long sleep in a cancelled workflow otherwise keeps
      // a live handle for an hour, and long sleeps in cancelled executions is exactly
      // the scheduler shape.
      timerService.cancelAll(workflowId);
      onSettled(workflowId, 'failed', {failure: result.failure});
      await closeChildren(workflowId);
      await notifyParentOfTerminal(workflowId);
      return;
    }
    if (caN) {
      // Adopt the run's writes first: the new run must be built from them, and
      // this is the one moment where changing the seed cannot split a run.
      if (result.carryover !== undefined)
        await historyStore.setCarryover(workflowId, result.carryover);
      await historyStore.resetForContinueAsNew(workflowId, caN.args);
      wake(workflowId); // drive the fresh run
      return;
    }
    // Nothing left to do: the batch was dispatched above, and the execution now
    // parks until one of those dispatches wakes it.
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
   *
   * The same guard is what makes the history events below affordable. They record
   * the *transition*, so a condition still parked across ten tasks appends nothing
   * on nine of them — history stays proportional to how often a workflow's waiting
   * changes rather than to how often it is woken, which for anything signal-driven
   * are very different numbers. See `ConditionParkedEvent`.
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
    const was = new Set(stored.map((s) => s.seq));
    const now = new Set(parked.map((p) => p.seq));
    // Unparks before parks. A task that leaves one condition and arrives at
    // another did those things in that order, and a reader building spans off
    // these events would otherwise see the two overlap.
    for (const s of stored)
      if (!now.has(s.seq))
        await appendEvent(workflowId, {
          type: 'conditionUnparked',
          condSeq: s.seq,
        });
    for (const p of parked)
      if (!was.has(p.seq))
        await appendEvent(workflowId, {
          type: 'conditionParked',
          condSeq: p.seq,
          site: p.site,
        });
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
        // One clock for both copies below. Two `Date.now()` calls would let the
        // event and the pending view disagree about when the same attempt is due.
        const nextAttemptAt = Date.now() + delayMs;
        log('activity.retry_scheduled', {
          workflowId,
          seq,
          name: scheduled.name,
          attempts,
          maxAttempts: maxAttempts(retry),
          delayMs,
          error: result.error,
        });
        // In history as well as in the log and the pending view, because neither of
        // those survives the question being asked later: the view is cleared when
        // the activity settles, and the log is a separate stream with its own
        // retention and no ordering against this history. This is the copy still
        // there when someone reconstructs the execution afterwards, and it is what
        // stops a backoff gap reading as a running attempt — see
        // `ActivityRetryScheduledEvent`.
        await appendEvent(workflowId, {
          type: 'activityRetryScheduled',
          seq,
          attempt: attempts,
          maxAttempts: maxAttempts(retry),
          nextAttemptAt,
          error: result.error,
        });
        // Written before the redispatch is armed, so an operator polling during
        // the backoff never sees an activity waiting on a retry with no time
        // attached to it.
        await historyStore.setActivityNextAttempt(
          workflowId,
          seq,
          nextAttemptAt,
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

  /**
   * Deliver a signal a *workflow* sent, and say whether it landed.
   *
   * Separate from `appendSignal` — the client path above — because it knows two
   * things that path does not. It has a sender to attribute the signal to, and it
   * owes an answer: `signalWorkflow` records `delivered` in the sender's history,
   * so "there is no such execution" stops being silent.
   *
   * The `source` check is what lets the marker be written last. Replay re-emits a
   * `signalWorkflow` whose marker was lost to a crash, and this recognizes the
   * re-send as the delivery it already made rather than handing the target a
   * second copy. It reports `true`: the signal *was* delivered, by the dispatch
   * this one repeats. The scan is over the target's history, which is bounded by
   * the same continue-as-new threshold everything else here is — and is the same
   * cost `reportActivityResult` already pays per completion.
   */
  async function deliverSignal(
    targetId: string,
    signalName: string,
    payload: unknown,
    source: SignalSource,
  ): Promise<boolean> {
    const target = await historyStore.get(targetId);
    // A settled target is as undeliverable as a missing one: nothing will replay
    // it, so an appended signal would sit in history unread. Reporting that back
    // is the whole reason this returns a boolean.
    if (!target || target.status !== 'running') return false;
    const already = target.history.some(
      (e) =>
        e.type === 'signal' &&
        e.source !== undefined &&
        e.source.workflowId === source.workflowId &&
        e.source.runId === source.runId &&
        e.source.seq === source.seq,
    );
    if (already) return true;
    await appendEvent(targetId, {
      type: 'signal',
      name: signalName,
      payload,
      source,
    });
    wake(targetId);
    return true;
  }

  async function requestCancel(workflowId: string): Promise<void> {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return;
    if (rec.history.some((e) => e.type === 'cancelRequested')) return;
    await appendEvent(workflowId, {type: 'cancelRequested'});
    const kids = childrenByParent.get(workflowId);
    // Every child, whatever its parent-close policy: cancelling says *stop this
    // work*, and a subtree of it is still that work. The policy answers the
    // different question of what happens when a parent finishes — see
    // `parent_close_policy.ts`, which owns that distinction.
    if (kids)
      for (const child of kids.values()) await requestCancel(child.childId);
    wake(workflowId);
  }

  async function terminate(workflowId: string, reason: string): Promise<void> {
    const rec = await historyStore.get(workflowId);
    if (!rec || rec.status !== 'running') return; // already settled — idempotent
    // No replay, no commands, no history event: the whole point is that this
    // works on an execution whose replay throws. Children are dealt with below,
    // by their own parent-close policies, the same as for any other close.
    await historyStore.setStatus(workflowId, 'terminated', {
      failure: new Error(reason),
    });
    // Same as the two dispositions above: nothing should stay armed for an
    // execution that is not waiting on it.
    timerService.cancelAll(workflowId);
    log('execution.settled', {
      workflowId,
      status: 'terminated',
      historyLength: rec.history.length,
      reason,
      taskFailures: rec.taskFailures,
    });
    onSettled(workflowId, 'terminated', {failure: new Error(reason)});
    await closeChildren(workflowId);
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
          recordChild(
            rec.workflowId,
            ev.seq,
            ev.childId,
            // Absent means a child dispatched before policies existed, when the
            // engine left children running unconditionally. See `ChildStartedEvent`.
            ev.parentClosePolicy ?? 'abandon',
          );
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
  /**
   * Fold every worker's report into one catalogue, keyed by workflow name.
   *
   * First report wins on a disagreement, and the disagreement is *reported* rather than
   * resolved: two workers describing one name differently is a fleet running two versions
   * of a worker binary, and which is right is not something the server can know. Choosing
   * silently would be the thing that hides it — so `conflicting` is raised and the reader
   * decides what to do about it.
   *
   * Comparison is on the description only. Two workers serving the same workflow from the
   * same code will report identical descriptions, and the queues they serve it on are
   * accumulated rather than compared, since serving one workflow from two pools is a
   * deployment choice rather than a disagreement.
   */
  function listWorkflows(): WorkflowSummary[] {
    const byName = new Map<string, WorkflowSummary>();
    // The description each name was *first* reported with, kept beside the summary so the
    // comparison is against what a worker actually sent rather than against a summary this
    // function has already added resolved fields to.
    const firstSeen = new Map<string, string>();

    for (const report of workerRegistry.reports())
      for (const workflow of report.workflows) {
        const described = JSON.stringify(workflow);
        const existing = byName.get(workflow.name);
        if (!existing) {
          byName.set(workflow.name, {
            ...workflow,
            title: workflow.title ?? workflow.name,
            taskQueues: [report.taskQueue],
          });
          firstSeen.set(workflow.name, described);
          continue;
        }
        if (!existing.taskQueues.includes(report.taskQueue))
          existing.taskQueues.push(report.taskQueue);
        if (firstSeen.get(workflow.name) !== described)
          existing.conflicting = true;
      }

    return [...byName.values()];
  }

  function reportWorkflows(report: WorkflowReportRequest): void {
    workerRegistry.recordReport(report);
  }

  function listQueues(): QueueWorkers[] {
    const holders = {
      workflow: workflowTaskQueue.leaseHolders(),
      activity: activityTaskQueue.leaseHolders(),
    };
    const backlog = {
      workflow: workflowTaskQueue.backlog(),
      activity: activityTaskQueue.backlog(),
    };

    const rows = workerRegistry.queues().map((queue) => ({
      ...queue,
      // The wildcard row is workers that serve *every* pool, not a pool named
      // `*`; nothing is ever enqueued to it. Its backlog is on the named rows,
      // and reporting a total here would double-count the same tasks.
      pendingWorkflowTasks:
        queue.taskQueue === ANY_TASK_QUEUE
          ? 0
          : (backlog.workflow.get(queue.taskQueue) ?? 0),
      pendingActivities:
        queue.taskQueue === ANY_TASK_QUEUE
          ? 0
          : (backlog.activity.get(queue.taskQueue) ?? 0),
      workers: queue.workers.map((worker) => ({
        ...worker,
        busy: holders[worker.role].has(worker.identity),
      })),
    }));

    // A pool with work and no poller is absent from the registry entirely — it
    // only knows pools something has *asked* about — so it would be missing from
    // the one report whose job is to explain a queue nobody is serving. That is
    // the most urgent row this function can return, and until backlog existed
    // there was no way to know the pool was there at all.
    const known = new Set(rows.map((row) => row.taskQueue));
    for (const taskQueue of [
      ...backlog.workflow.keys(),
      ...backlog.activity.keys(),
    ]) {
      if (known.has(taskQueue)) continue;
      known.add(taskQueue);
      rows.push({
        taskQueue,
        pendingWorkflowTasks: backlog.workflow.get(taskQueue) ?? 0,
        pendingActivities: backlog.activity.get(taskQueue) ?? 0,
        // No poll timestamps and no workers, which is the whole point: this row
        // exists to say that nothing has ever asked for this pool's work.
        workers: [],
      });
    }
    return rows;
  }

  async function pollWorkflowTask(
    request: PollRequest = {},
  ): Promise<WorkflowTask | undefined> {
    const {taskQueue, identity, serves} = request;
    // Before the queue is consulted, so an idle poll counts. A worker waiting
    // on an empty queue is the strongest evidence of liveness there is, and
    // recording only polls that found work would report a healthy idle fleet as
    // absent — the exact inversion of what this is for.
    workerRegistry.recordPoll('workflow', taskQueue, identity, serves);
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
        parent: rec.parent && {...rec.parent},
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
    request: PollRequest = {},
  ): Promise<LeasedActivityTask | undefined> {
    const {taskQueue, identity, serves} = request;
    // See the note in `pollWorkflowTask`: recorded before the queue is
    // consulted, so an idle poll still counts as liveness.
    workerRegistry.recordPoll('activity', taskQueue, identity, serves);
    const task = activityTaskQueue.poll(taskQueue, identity);
    if (!task) return undefined;
    activityLeases.set(task.token, {
      workflowId: task.workflowId,
      seq: task.seq,
    });
    // Stamped here rather than reported by the worker at completion, for two
    // reasons. One clock: a `startedAt` from the worker is on the worker's clock,
    // and a skewed one could claim to have started after the server recorded it
    // finished. And it is written *now*, so an attempt still running is visible —
    // a value carried on the completion event would say nothing until it was over,
    // which is the half of the question an operator actually asks first.
    await appendEvent(task.workflowId, {
      type: 'activityStarted',
      seq: task.seq,
      identity,
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
    listWorkflows,
    reportWorkflows,
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

/**
 * @fileoverview
 * The service contract: what a host/client calls to drive workflows, plus the
 * task payloads the server hands to workers and gets back. These are pure data +
 * signatures — the seam that `LocalService` (in-proc) and `RemoteService` (RPC)
 * both satisfy. Living in `protocol/` is what lets `server` and `worker` share the
 * task shapes without importing each other.
 *
 * This seam is why local vs. distributed is a *choice of implementation* rather
 * than a fork of the runtime: workers and the client are written once against it,
 * and the integration suite runs unchanged against either side. It unifies the
 * code path, not the failure semantics — see the caveat on `LocalService`.
 */

import type {ActivityOptions} from './activity_options';
import type {Command} from './commands';
import type {HistoryEvent} from './history_events';
import type {TaskToken} from './task_token';

/**
 * `terminated` is deliberately its own status rather than a flavour of `failed`.
 * They answer different questions in a postmortem — "your code raised" versus "an
 * operator pulled the plug" — and folding them together loses that exactly where
 * it is being looked for. Adding the member also makes every switch over status a
 * compile error until it is considered, which is the point.
 */
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'terminated';

/** The pool every execution and activity falls back to when none is named. */
export const DEFAULT_TASK_QUEUE = 'default';

export interface StartWorkflowOptions {
  /**
   * The execution's id. Generated when omitted; **a claim on a name when given**.
   *
   * A caller-chosen id exists to tie an execution to something in the world — an
   * order, a ticket, a calendar event — and the caller owns making it uniquely
   * identify that thing. Starting twice under one id therefore does not start
   * twice: the second call returns the execution that already holds the id, and
   * `StartResult.created` says which happened. This is the same rule
   * `startChild` follows, and it is what makes "one workflow per order"
   * expressible without the caller keeping its own table of what it has started.
   *
   * The consequence to know: **the second call's arguments are discarded.** The
   * execution you get back is the one that already existed, running what it was
   * started with. Two starts for one order with different amounts is a bug in
   * the caller, and the engine will not arbitrate it — it records the reuse and
   * flags whether the request matched, so the bug is greppable rather than
   * invisible.
   */
  workflowId?: string;
  /**
   * Which pool of workers runs this execution. Recorded on the execution, so
   * every workflow task it ever produces routes the same way, and its activities
   * and children inherit it unless they say otherwise.
   */
  taskQueue?: string;
}

/**
 * What a start did.
 *
 * `created` is the whole reason this is not just an id: starting under an id
 * that already exists is a claim rather than an error (see
 * `StartWorkflowOptions.workflowId`), and a caller that cannot tell the two
 * apart has no way to notice that its arguments went nowhere.
 *
 * Only the RPC-facing `ServerHost` returns this. `WorkflowService.start` stays
 * synchronous and returns the id alone, because `client.ts` builds a handle from
 * it in one expression and `RemoteService` generates the id locally so that
 * handle works before the round trip lands — neither can wait to find out.
 */
export interface StartResult {
  workflowId: string;
  /** False when the id was already taken and this returned that execution. */
  created: boolean;
}

// ── inspection (read-only views) ─────────────────────────────────────────
// Derived from history rather than stored, so they cannot drift from the truth
// and no adapter has to maintain them. Deliberately projections, not the
// server's own record types: `ExecutionRecord` carries a `version` for the
// optimistic CAS and raw `failure` values that need not be serializable, and
// neither belongs on the wire.

/** One line of `tempo list`: enough to identify an execution and its state. */
export interface ExecutionSummary {
  workflowId: string;
  /** Increments on each continue-as-new; the workflowId is stable across runs. */
  runId: number;
  name: string;
  status: ExecutionStatus;
  historyLength: number;
  /** Which worker pool it runs on — what a listing needs in order to group. */
  taskQueue: string;
  /** When it was created, epoch ms. The listing's sort key and its "age" column. */
  createdAt: number;
  /**
   * Consecutive workflow-task failures. Non-zero on a `running` execution is the
   * signal that it is wedged rather than merely waiting — the engine cannot
   * replay it, and is retrying on a backoff.
   *
   * This lives on the *summary* rather than only the detail because a wedged
   * execution is otherwise indistinguishable from a healthy one in a listing:
   * both read `running`. Finding them meant describing every running execution
   * in turn and reading this field off each — one request per execution, each
   * carrying a full history, to answer a question the listing should answer.
   */
  taskFailures: number;
  /** Why the most recent workflow task failed. */
  lastTaskFailure?: string;
}

/**
 * Is this execution wedged — running, but failing to replay?
 *
 * Both halves matter. `taskFailures > 0` alone would flag a settled execution
 * that recovered or was terminated after a rough patch, and `running` alone is
 * the normal state of every healthy workflow that is merely waiting on a timer
 * or an activity. Defined here, beside the type, so `tempo list` and any other
 * client cannot drift into two different answers.
 */
export function isStuck(execution: ExecutionSummary): boolean {
  return execution.status === 'running' && execution.taskFailures > 0;
}

/**
 * What to ask a listing for. Every field narrows; omitting all of them means
 * everything, which is what `tempo list` has always done.
 *
 * `stuck` is not a status — it is the derived predicate above — but it belongs
 * here rather than in the caller, because filtering after the fact would mean
 * fetching every execution to find the handful that are broken, which is the
 * exact cost this interface exists to avoid.
 */
export interface ExecutionFilter {
  status?: ExecutionStatus;
  name?: string;
  taskQueue?: string;
  /** Match executions whose id starts with this — the listing's search box. */
  workflowIdPrefix?: string;
  /** Only executions the engine cannot replay. */
  stuck?: boolean;
  /** How many to return. The server caps this; see `MAX_PAGE_SIZE`. */
  limit?: number;
  /** Resume after this point — an opaque value from a previous page. */
  cursor?: string;
}

/**
 * One page of a listing, newest first.
 *
 * The cursor is opaque on purpose: it currently encodes the sort key of the last
 * row, and a caller that parsed it would be depending on an ordering this is
 * free to change.
 */
export interface ExecutionPage {
  executions: ExecutionSummary[];
  /** Absent when this is the last page. */
  nextCursor?: string;
}

/**
 * The most any one listing returns, however large a `limit` is asked for.
 *
 * A ceiling rather than a suggestion, because the caller most likely to ask for
 * everything is a dashboard doing it every two seconds, and the server has no
 * way to refuse work it has already done.
 */
export const MAX_PAGE_SIZE = 200;

/**
 * The most history events one `describeExecution` returns.
 *
 * A history of a few thousand events is now the *expected* size rather than a
 * pathological one — `DEFAULT_CONTINUE_AS_NEW_SUGGEST_THRESHOLD` is 4096, so a
 * long-lived workflow sits just under it by design. Returning all of it on every
 * describe means a dashboard polling one execution ships megabytes a minute.
 */
export const MAX_HISTORY_PAGE = 500;

/**
 * Which slice of an execution's history to return.
 *
 * Paged by **index**, not by a cursor, because history is append-only: event 40
 * is event 40 forever, so an offset cannot go stale or skip a row the way a
 * cursor over a mutable set can. That is a property of the data, not a
 * simplification.
 */
export interface DescribeOptions {
  /**
   * Index of the first event to return.
   *
   * Omitted means **the most recent page**, not the first. `describe` is a
   * diagnostic command, and the question it is asked — what is this doing, what
   * went wrong — is answered at the end of a history rather than the start. For
   * anything shorter than a page, which is nearly everything, this is the whole
   * history either way.
   */
  fromEvent?: number;
  /** How many events. Capped at `MAX_HISTORY_PAGE`. */
  limit?: number;
}

/**
 * Dispatched work whose completion has not arrived — why a running execution is
 * parked. An execution that is `running` with nothing pending is either mid-task
 * or genuinely stuck, and that distinction is the first thing an operator wants.
 */
export interface PendingWorkView {
  activities: PendingActivityView[];
  timers: {seq: number; fireAt: number}[];
  children: {seq: number; childId: string; detached: boolean}[];
}

/**
 * One dispatched activity, and how its retrying is going.
 *
 * The retry fields are the reason this is a named type rather than an inline
 * shape. Without them a dispatched activity is a name, and an activity on its
 * fourth backoff is indistinguishable from one running for the first time —
 * both read as "waiting on: charge". That is the case an operator is most often
 * looking at when they open an execution that is not moving, and answering it
 * previously meant reading the server's logs.
 */
export interface PendingActivityView {
  seq: number;
  name: string;
  /**
   * Which attempt is running or about to run, counting from 1.
   *
   * Deliberately not the stored count of *failed* attempts: every consumer wants
   * to render "attempt 3 of 5", and making each one add 1 is an off-by-one
   * waiting to happen. `attempt === 1` means nothing has failed yet.
   */
  attempt: number;
  /** How many the retry policy allows in total. 1 means no retry. */
  maxAttempts: number;
  /** Why the previous attempt failed; absent while `attempt` is 1. */
  lastError?: string;
  /**
   * When the next attempt is due, epoch ms.
   *
   * Absent when the activity is running rather than waiting out a backoff, so a
   * reader must treat it as "not between attempts" rather than as "due now".
   */
  nextAttemptAt?: number;
}

/**
 * Which execution started this one.
 *
 * On the detail rather than the summary: a listing has no column for lineage and
 * most executions have no parent, so putting it on every row would grow the
 * common response to answer a question only the detail view asks.
 */
export interface ExecutionParentView {
  workflowId: string;
  /** The `startChild` seq in the parent, which its history is keyed by. */
  seq: number;
}

/** `tempo describe`: the summary, plus history and what the execution awaits. */
export interface ExecutionDetail extends ExecutionSummary {
  args: unknown[];
  /**
   * Absent on an execution a client started directly.
   *
   * Also absent on a child created before the parent was recorded — the two are
   * indistinguishable, and both degrade to the dead end this field exists to
   * remove rather than to a link that goes nowhere.
   */
  parent?: ExecutionParentView;
  /**
   * One page of history — see `DescribeOptions`. `historyLength` on the summary
   * is the total, so `historyOffset + history.length < historyLength` means
   * there is more after this page.
   */
  history: HistoryEvent[];
  /** Index of the first event in `history`, within the whole history. */
  historyOffset: number;
  pending: PendingWorkView;
  cancelRequested: boolean;
  result?: unknown;
  /** A message, not an Error — failures cross the wire as text. */
  failure?: string;
  /** The stack behind `failure`, when the failure originated somewhere that had one. */
  failureStack?: string;
  /**
   * The execution's carryover state. Shown because ambient is not the same as
   * hidden: state that decides whether an item gets processed has to be legible
   * to whoever is asking why it was not.
   */
  carryover?: Carryover;
}

// ── grouped counts ───────────────────────────────────────────────────────
// "Which pools and which workflows are failing" — a question about the shape of
// the whole set, which a paged listing structurally cannot answer. A client
// counting the rows it was given would be reporting on its page rather than on
// the server, and would be wrong by exactly the amount that matters once there
// is enough data to need paging.

/**
 * Executions sharing one key, counted by status.
 *
 * `stuck` overlaps `running` rather than sitting beside it — a wedged execution
 * *is* running (see `isStuck`) — so the four statuses sum to `total` and `stuck`
 * does not. Making it a fifth disjoint bucket would have meant either lying
 * about the status or dropping the distinction, and this is the count someone
 * scanning for trouble reads first.
 */
export interface ExecutionGroup {
  key: string;
  total: number;
  running: number;
  completed: number;
  failed: number;
  terminated: number;
  /** Running, but the engine cannot replay them. A subset of `running`. */
  stuck: number;
}

/**
 * The two groupings worth having, from one scan.
 *
 * Both together rather than one call each, because they answer one question —
 * where is the trouble — and the caller is a dashboard that would otherwise
 * make two requests every couple of seconds to scan the same set twice.
 */
export interface ExecutionGroups {
  byTaskQueue: ExecutionGroup[];
  byName: ExecutionGroup[];
}

// ── worker liveness ──────────────────────────────────────────────────────
// Which pools are being asked for work. Everything above describes executions;
// this describes the fleet, and it is the one question the execution views
// cannot answer. An execution waiting on an activity looks identical whether a
// worker is about to pick it up or no worker has ever existed for its queue —
// and the second is the more common cause of "it's stuck".

/** The two poll loops a worker runs; a queue can have one without the other. */
export type WorkerRole = 'workflow' | 'activity';

/**
 * The queue name recorded for a worker that polls with no queue at all.
 *
 * Omitting the queue means "any queue" (see `pollWorkflowTask`), which is what
 * the in-process runtime does — one set of loops there serves every execution
 * however it was routed. Recording that under a real queue name would be wrong,
 * and dropping it would report every queue as unserved under `createLocalRuntime`,
 * which is the configuration most of the suite runs in.
 */
export const ANY_TASK_QUEUE = '*';

/**
 * How recently a queue must have been polled to count as served.
 *
 * Generous next to the 5ms idle poll interval, because the thing being detected
 * is absence, and a false "nothing is serving this" is worse than a slow one:
 * it sends an operator to look at a deployment that is fine.
 */
export const QUEUE_STALE_MS = 10_000;

/**
 * When each role last asked a queue for work.
 *
 * A record of **polls**, not of workers. The server never learns a worker's
 * identity — nothing in the poll carries one — so it cannot report how many
 * there are, only whether anything is asking. That is enough for the question
 * this exists to answer, and claiming more would mean inventing an identity the
 * protocol does not have.
 */
export interface QueueWorkers {
  taskQueue: string;
  /** Epoch ms of the last workflow-task poll, absent if there has never been one. */
  workflowPolledAt?: number;
  /** Epoch ms of the last activity-task poll. */
  activityPolledAt?: number;
}

/**
 * Is anything currently asking `taskQueue` for `role` work?
 *
 * Defined here, beside the type, so the CLI and the dashboard cannot drift into
 * two different answers — the same reason `isStuck` lives here.
 *
 * **A busy worker looks like an absent one.** The activity loop is sequential:
 * it awaits the activity it claimed before polling again, so a worker running a
 * single 60-second activity stops polling for 60 seconds and its queue goes
 * stale. Both readings — nothing is serving this queue, or everything serving
 * it is saturated — are things an operator wants to know, and this cannot tell
 * them apart. Callers should say what was observed (nothing has polled) rather
 * than what it implies (no worker exists). Distinguishing them needs
 * outstanding-lease tracking, which is a bigger change than this one.
 */
export function isQueueServed(
  queues: QueueWorkers[],
  taskQueue: string,
  role: WorkerRole,
  now: number,
): boolean {
  const field = role === 'workflow' ? 'workflowPolledAt' : 'activityPolledAt';
  return queues.some((q) => {
    // A worker polling every queue serves this one too.
    if (q.taskQueue !== taskQueue && q.taskQueue !== ANY_TASK_QUEUE)
      return false;
    const at = q[field];
    return at !== undefined && now - at <= QUEUE_STALE_MS;
  });
}

/**
 * The seam both `LocalService` (in-proc) and, later, `RemoteService` (RPC) satisfy.
 * It has two faces: the client-facing methods (start/signal/cancel/get*) and the
 * worker-facing poll/respond methods. Workers are written once against the latter
 * — the in-proc workers poll a local implementation; distributed workers poll a
 * remote one over RPC.
 */
export interface WorkflowService {
  // ── client-facing ──
  start(
    name: string,
    args?: unknown[],
    opts?: StartWorkflowOptions,
  ): {workflowId: string};
  signal(workflowId: string, signalName: string, payload?: unknown): void;
  cancel(workflowId: string): void;
  /**
   * End an execution outright, without replaying it. Distinct from `cancel`,
   * which is cooperative and therefore cannot reach an execution whose replay is
   * the thing that throws.
   */
  terminate(workflowId: string, reason: string): void;
  /**
   * Drop every event from `keep` onward and replay from there.
   *
   * The counterpart to `terminate` for a wedged execution: that one ends it,
   * this one rewinds it to before whatever the deployed code cannot replay, so
   * the work is kept. Destructive — the dropped events do not come back — and
   * the caller is expected to have said so.
   *
   * `keep` is an index into the history, so event `keep` is the first one
   * dropped. Out-of-range values are clamped rather than rejected: a history
   * that grew between reading it and acting on it is ordinary, and a reset to
   * "the end" is a no-op rather than an error.
   */
  reset(workflowId: string, keep: number): void;
  getResult(workflowId: string): Promise<unknown>;
  getStatus(workflowId: string): ExecutionStatus;
  /** Inspect one execution: status, history, and what it is waiting on. */
  describeExecution(
    workflowId: string,
    options?: DescribeOptions,
  ): Promise<ExecutionDetail | undefined>;
  /** One page of the executions the server knows about, newest first. */
  listExecutions(filter?: ExecutionFilter): Promise<ExecutionPage>;
  /** Which task queues are being polled, and when each was last asked. */
  listQueues(): Promise<QueueWorkers[]>;
  /** Every execution counted by status, grouped by task queue and by name. */
  groupExecutions(): Promise<ExecutionGroups>;
  // ── worker-facing (poll a task, respond when done) ──
  /**
   * Claim the next workflow task on `taskQueue`.
   *
   * Omitting the queue means **any queue**, which exists for the in-process
   * runtime: one set of loops there serves every execution regardless of how it
   * was routed, so `createLocalRuntime` keeps working as a test harness whatever
   * queue names a workflow uses. A deployed worker always names its queue.
   */
  pollWorkflowTask(taskQueue?: string): Promise<WorkflowTask | undefined>;
  completeWorkflowTask(
    token: TaskToken,
    result: WorkflowTaskResult,
  ): Promise<void>;
  /**
   * Report that this task could not be replayed at all. Distinct from a
   * `WorkflowTaskResult` carrying `failed` — that is the *workflow* failing, a
   * normal outcome the engine records and settles. This is the *engine* unable to
   * run it: a nondeterminism error, or a bug thrown outside the workflow's own
   * control flow. The execution keeps running and the task is retried.
   */
  failWorkflowTask(token: TaskToken, reason: string): Promise<void>;
  /** Claim the next activity task on `taskQueue`; omitted means any (see above). */
  pollActivityTask(taskQueue?: string): Promise<LeasedActivityTask | undefined>;
  completeActivityTask(token: TaskToken, result: ActivityResult): Promise<void>;
  /**
   * Report that this attempt is still alive. Renews the task's lease so it is not
   * redelivered, and resets the `heartbeatTimeoutMs` deadline if one is set.
   *
   * A no-op for an attempt the server has already given up on — the worker finds
   * out when it reports a result and the completion is dropped, not here.
   */
  heartbeatActivityTask(token: TaskToken): Promise<void>;
}

// ── worker task contracts ───────────────────────────────────────────────
/** A unit of activity work: which activity to run, for which execution/command. */
export interface ActivityTask {
  workflowId: string;
  seq: number;
  name: string;
  args: unknown[];
  /** Carried so the worker can apply the retry policy while the workflow stays parked. */
  options: ActivityOptions;
}

/** What an activity worker reports back after running an activity function. */
/**
 * `stack` is the activity's own stack, captured in the worker that ran it — the
 * only process that ever holds the thrown `Error`. Without it a failure arrives
 * as a bare message ("Cannot read properties of undefined") naming no file and no
 * line, and the frames are unrecoverable: they died with the object.
 */
export type ActivityResult =
  {ok: true; result: unknown} | {ok: false; error: string; stack?: string};

/** An activity task handed to a worker, with the lease token to complete it. */
export interface LeasedActivityTask extends ActivityTask {
  token: TaskToken;
}

/**
 * A workflow task handed to a workflow worker: replay this history and respond
 * with the resulting commands + terminal state. The `token` identifies the task
 * on complete; `continueAsNewSuggested` is the server's history-growth hint.
 */
/**
 * State a workflow keeps across its own runs, without putting it in its
 * signature — see `core/carryover.ts` for what it is for and what it is not.
 */
export type Carryover = Record<string, unknown>;

/**
 * A ceiling on the serialized carryover, enforced when a task reports back.
 *
 * Carryover is written on every workflow task and copied into every new run, so
 * something that grows without bound there degrades quietly: a slowly fattening
 * record, and rollovers that get more expensive the longer a workflow has been
 * alive. The cap converts that into a loud, immediate failure naming the
 * offending state, at the moment the code that grows it is first run.
 */
export const MAX_CARRYOVER_BYTES = 16 * 1024;

export interface WorkflowTask {
  token: TaskToken;
  workflowId: string;
  name: string;
  args: unknown[];
  history: HistoryEvent[];
  continueAsNewSuggested: boolean;
  /** What the previous task (or the previous run) left behind. */
  carryover: Carryover;
}

/** What a workflow worker returns after replaying one workflow task. */
export interface WorkflowTaskResult {
  done: boolean;
  result: unknown;
  failed: boolean;
  failure: unknown;
  /**
   * The failure's stack, carried separately because `failure` is flattened to a
   * message at the RPC boundary (an `Error` JSON-serializes to `{}`). In-process
   * callers read it off `failure` itself; this is what survives the wire.
   */
  failureStack?: string;
  commands: Command[];
  /**
   * Carryover as it stands at the end of this task. Returned on **every** task,
   * not only on the one that rolls the run over: storing it per task is what
   * makes it survive a crash and what makes `tempo describe` show the live value
   * rather than the one from the last rollover.
   */
  carryover?: Carryover;
}

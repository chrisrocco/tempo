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

/** One line of `Client.list()`: enough to identify an execution and its state. */
export interface ExecutionSummary {
  workflowId: string;
  /**
   * How many times this execution has continued-as-new; the workflowId is
   * stable across runs.
   *
   * **A count, not an address.** Unlike Temporal's RunId this does not identify
   * a fetchable run: rollover overwrites one record in place, so `runId: 5`
   * means five rollovers happened, not that runs 0–4 can be read. There is no
   * request that returns an earlier run, by design — see
   * `resetForContinueAsNew`.
   */
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
 * or an activity. Defined here, beside the type, so `Client.list()` and any other
 * client cannot drift into two different answers.
 */
export function isStuck(execution: ExecutionSummary): boolean {
  return execution.status === 'running' && execution.taskFailures > 0;
}

/**
 * What to ask a listing for. Every field narrows; omitting all of them means
 * everything, which is what `Client.list()` has always done.
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
  /**
   * Only the children of this execution — the query behind a lineage view.
   *
   * The parent link itself stays on the detail and off the summary, for the
   * reason on `ExecutionParentView`: a listing has no lineage column, and most
   * executions have no parent. This asks the question from the other end, which
   * is the end that needs a server: a caller filtering by parent already knows
   * what the parent is, so the rows do not have to repeat it, and the response
   * gets smaller rather than larger.
   *
   * It is the only way to see a child that has **finished**.
   * `ExecutionDetail.pending.children` lists the ones still outstanding, so a
   * completed child vanishes from the parent's view at the moment it succeeds —
   * fine for "what is this execution waiting on", useless for "what did this
   * execution do". Reconstructing it otherwise means describing every execution
   * on the server and keeping the ones whose parent matches.
   *
   * Direct children only. A tree is walked a level at a time, which is also how
   * a UI renders one.
   */
  parentWorkflowId?: string;
  /**
   * Created at or after this instant, as epoch milliseconds.
   *
   * Absolute rather than a duration, because this is a wire contract and
   * "the last hour" would be relative to a clock the two ends do not share.
   * A client that thinks in durations resolves them before it asks; the
   * dashboard does exactly that in `time_range.ts`.
   */
  createdAfter?: number;
  /**
   * Created strictly before this instant, as epoch milliseconds.
   *
   * The range is half-open — `[createdAfter, createdBefore)` — so adjacent
   * windows tile exactly rather than double-counting the execution that lands
   * on the boundary. The names read as though both ends were exclusive; only
   * this one is.
   */
  createdBefore?: number;
  /** How many to return. The server caps this; see `MAX_PAGE_SIZE`. */
  limit?: number;
  /** Resume after this point — an opaque value from a previous page. */
  cursor?: string;
}

/**
 * What a server says about itself when asked.
 *
 * **There is no `ok` field, deliberately.** Liveness is carried by the response
 * arriving at all — a boolean that is `true` in every reply it is possible to
 * receive tells a caller nothing, and invites one to branch on it as though it
 * did. A server too sick to answer does not answer, and that is the signal.
 *
 * Everything here is already in memory. Nothing on this type may require a
 * store scan: the caller is a status command or a supervisor probe, and a
 * health check that walks every execution is a health check that falls over on
 * exactly the server that most needs probing. Execution counts are what
 * `groupExecutions` is for.
 */
export interface ServerHealth {
  /**
   * How long this server has been up, in milliseconds.
   *
   * A duration rather than a `startedAt` instant because it is computed on the
   * server, so it survives the two ends disagreeing about what time it is. A
   * timestamp would silently become an inaccurate uptime the moment a client's
   * clock drifted from the server's.
   */
  uptimeMs: number;
  /** Whether state survives a restart — `false` is the in-memory default. */
  durable: boolean;
  /**
   * Where durable state lives, for a human reading a status line. Absent when
   * in-memory. Never parse it — see `HistoryStore.location`.
   */
  dataLocation?: string;
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

/** `Client.describe()`: the summary, plus history and what the execution awaits. */
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
  /**
   * The `condition()` calls the execution is parked on.
   *
   * Empty is the common case and does not mean "not waiting" — an execution
   * parked on an activity has pending work and no parked conditions. The two
   * together are what distinguish a workflow that is genuinely waiting from one
   * that is mid-task, which `pending` alone could not: a `running` execution
   * with neither is the only remaining shape, and it means the task is in flight.
   */
  parked: ParkedCondition[];
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
 * Activities of one name that are **between attempts right now**.
 *
 * Deliberately a live view rather than a historical one, and it is worth being
 * precise about why, because the obvious reading of "which activity is failing"
 * is the one this does not answer.
 *
 * History records an activity's *final* outcome: `activityFailed` is written
 * once the retry budget is spent, and the per-attempt state is discarded the
 * moment the activity settles. So an activity that fails four times and
 * succeeds on the fifth leaves a history containing `activityScheduled` and
 * `activityCompleted` — identical to one that succeeded immediately. **Flakiness
 * is not derivable from history at all**, at any cost; counting it over time
 * would need a durable counter that outlives settling, which is the opposite of
 * the rule that keeps `activityAttempts` bounded.
 *
 * Rather than answer a narrower question and let a reader assume the wider one,
 * this reports what the engine genuinely knows: what is burning retries at this
 * moment. That is also the cheap thing — the counts come from state the scan
 * already loads. For failure rates over time, `activity.settled` and
 * `activity.retry_scheduled` carry the activity name into the log stream, which
 * is where an aggregate over history belongs.
 *
 * Its own type rather than an `ExecutionGroup`, because none of that type's
 * statuses (`running` / `completed` / `terminated` / `stuck`) mean anything for
 * an attempt that has already failed and is waiting to run again.
 */
export interface ActivityRetryGroup {
  /** The activity's registered name. */
  name: string;
  /** How many activities of this name are between attempts right now. */
  retrying: number;
  /** Failed attempts summed across them — the size of the retry burden. */
  attempts: number;
  /** The most recent failure among them, so a reader need not open one. */
  lastError?: string;
  /**
   * The soonest attempt due among them, epoch ms. Absent when none of them has
   * been scheduled yet — see `ActivityRetryState.nextAttemptAt`, which a reader
   * must treat as unknown rather than as "now".
   */
  nextAttemptAt?: number;
}

/**
 * The groupings worth having, from one scan.
 *
 * Together rather than one call each, because they answer one question — where
 * is the trouble — and the caller is a dashboard that would otherwise make
 * three requests every couple of seconds to scan the same set three times.
 *
 * `retryingActivities` joined the other two for exactly that reason, and is the
 * one grouping that is not about executions: an execution stuck behind a
 * retrying activity is `running` and healthy-looking in both of the others.
 */
export interface ExecutionGroups {
  byTaskQueue: ExecutionGroup[];
  byName: ExecutionGroup[];
  /** What is between attempts now, by activity. See `ActivityRetryGroup`. */
  retryingActivities: ActivityRetryGroup[];
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
/**
 * One worker process, in one role, as the server has observed it.
 *
 * A worker is only ever known by having asked for work — there is no
 * registration, so a process that crashes before its first poll is
 * indistinguishable from one that was never deployed. Answering *that* needs
 * process state from the deployment tier, not this.
 *
 * A process running both loops appears **twice**, once per role, under one
 * identity. That is deliberate: the roles poll independently and fail
 * independently, and a worker whose activity loop is wedged while its workflow
 * loop is healthy is a real and confusing state that one merged row would hide.
 */
export interface WorkerInfo {
  /**
   * What the worker calls itself. `${pid}@${hostname}` by default, matching the
   * convention Temporal uses, so the string is something an operator can act on
   * — find the process, read its logs — rather than an opaque handle.
   *
   * Chosen by the worker and never verified. Two processes that claim the same
   * identity are counted once, which is a misconfiguration this cannot detect
   * and does not try to.
   */
  identity: string;
  role: WorkerRole;
  /** The pool it polls; `ANY_TASK_QUEUE` when it polls every one. */
  taskQueue: string;
  /** Epoch ms of its most recent poll. */
  lastPolledAt: number;
  /**
   * Holding a task right now — which is *why* it may have stopped polling.
   *
   * The field that makes a quiet queue readable. The activity loop is
   * sequential, so a worker running a 60-second activity polls nothing for 60
   * seconds and looks exactly like one that died. Holding a live lease is the
   * positive evidence that separates them, and it is the reason a poll carries
   * an identity at all.
   */
  busy: boolean;
}

export interface QueueWorkers {
  taskQueue: string;
  /** Epoch ms of the last workflow-task poll, absent if there has never been one. */
  workflowPolledAt?: number;
  /** Epoch ms of the last activity-task poll. */
  activityPolledAt?: number;
  /**
   * Executions waiting for a workflow task on this pool, right now.
   *
   * **Waiting, not outstanding**: a task a worker is holding is being worked and
   * is not backlog — `workers[].busy` reports those. Coalesced, so this counts
   * executions rather than wakes.
   *
   * Paired with the poll timestamps, this is what separates the two ways a pool
   * can be quiet. Backlog with no recent poll is work nobody is coming for;
   * backlog with a recent poll is a pool that is merely behind. Neither reading
   * was available before — the timestamps alone cannot tell "nothing to do" from
   * "nobody doing it".
   *
   * A live reading of an in-memory queue: it does not survive a restart, and it
   * says nothing about how long anything has waited.
   */
  pendingWorkflowTasks: number;
  /** Activity tasks waiting to be claimed on this pool. Same contract as above. */
  pendingActivities: number;
  /**
   * The workers seen on this queue, newest poll first.
   *
   * The two timestamps above are the aggregate — "something asked" — and remain
   * the right answer to "is this pool served at all". This is the breakdown, and
   * the only thing that can say *how many* and *which*.
   */
  workers: WorkerInfo[];
}

/**
 * The half of `QueueWorkers` that says who is serving a pool, without the half
 * that says how much is waiting on it.
 *
 * The two predicates below read polls and workers and nothing else, so this is
 * what they ask for. A `QueueWorkers` satisfies it, which is what every real
 * caller passes; asking for the wider type instead would make a caller that only
 * has liveness — a test, a future source of fleet data that is not the task
 * queues — invent a backlog number to answer a question about workers.
 */
export type QueueLiveness = Omit<
  QueueWorkers,
  'pendingWorkflowTasks' | 'pendingActivities'
>;

/**
 * Is anything currently asking `taskQueue` for `role` work?
 *
 * Defined here, beside the type, so the CLI and the dashboard cannot drift into
 * two different answers — the same reason `isStuck` lives here.
 *
 * **A busy worker used to look like an absent one.** The activity loop is
 * sequential: it awaits the activity it claimed before polling again, so a
 * worker running a single 60-second activity stops polling for 60 seconds and
 * its queue goes stale. That is now distinguishable — a worker holding a live
 * lease is reported `busy` (see `WorkerInfo`), and a busy worker serves its
 * queue however long it has been since it last asked for more.
 *
 * The recency test remains for the idle case, which is the common one: a worker
 * with nothing to do holds no lease and is known only by polling.
 */
export function isQueueServed(
  queues: readonly QueueLiveness[],
  taskQueue: string,
  role: WorkerRole,
  now: number,
): boolean {
  const field = role === 'workflow' ? 'workflowPolledAt' : 'activityPolledAt';
  return queues.some((q) => {
    // A worker polling every queue serves this one too.
    if (q.taskQueue !== taskQueue && q.taskQueue !== ANY_TASK_QUEUE)
      return false;
    if (q.workers.some((w) => w.role === role && w.busy)) return true;
    const at = q[field];
    return at !== undefined && now - at <= QUEUE_STALE_MS;
  });
}

/**
 * The workers that serve `taskQueue` in `role`, including the ones polling
 * every queue.
 *
 * Beside `isQueueServed` and for the same reason: "a worker on `*` serves
 * `email` too" is a rule, and two clients applying it differently would
 * disagree about how big a fleet is. Returns every worker ever seen, however
 * long ago — staleness is `lastPolledAt`, which the caller can read, and
 * filtering here would hide the worker that went quiet, which is usually the
 * one being looked for.
 */
export function workersServing(
  queues: readonly QueueLiveness[],
  taskQueue: string,
  role: WorkerRole,
): WorkerInfo[] {
  return queues
    .filter((q) => q.taskQueue === taskQueue || q.taskQueue === ANY_TASK_QUEUE)
    .flatMap((q) => q.workers.filter((w) => w.role === role));
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
   *
   * `identity` names the worker asking. Optional, because a client that does
   * not supply one still gets tasks — it is only the fleet view that suffers,
   * reporting that something polled without being able to say what. See
   * `WorkerInfo`.
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
   * Report that this task could not be replayed at all. Distinct from a
   * `WorkflowTaskResult` carrying `failed` — that is the *workflow* failing, a
   * normal outcome the engine records and settles. This is the *engine* unable to
   * run it: a nondeterminism error, or a bug thrown outside the workflow's own
   * control flow. The execution keeps running and the task is retried.
   */
  failWorkflowTask(token: TaskToken, reason: string): Promise<void>;
  /** Claim the next activity task on `taskQueue`; omitted means any (see above). */
  pollActivityTask(
    taskQueue?: string,
    identity?: string,
  ): Promise<LeasedActivityTask | undefined>;
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

/**
 * A `WorkflowService` reached over a wire, plus the one thing only such a client
 * can ask.
 *
 * **`health` is here rather than on `WorkflowService` because there is no server
 * in the local case**: `LocalService` is the engine running in your own process,
 * and asking it for its uptime and data directory would be asking it to invent
 * answers about a tier that does not exist. The seam both implement stays the
 * workflow operations; this is the extra reach a remote client has.
 *
 * The distinction lives here, beside `WorkflowService`, so that anything written
 * against the seam can name it — `client/` builds a handle-shaped surface over one
 * or the other and may not import from `services/`, where the implementation is.
 */
export interface RemoteWorkflowService extends WorkflowService {
  /** Liveness and what the server is. See `ServerHealth`. */
  health(): Promise<ServerHealth>;
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
  /**
   * Which execution started this one; absent when a client did.
   *
   * The same projection the detail view carries, on the task because the workflow
   * itself needs it: `workflowInfo().parent` is how a child addresses its parent
   * without being handed the id. It is a fact about the execution rather than
   * about this task — like `args`, and unlike `history` — so it is identical on
   * every task of every run.
   */
  parent?: ExecutionParentView;
}

/** What a workflow worker returns after replaying one workflow task. */
/**
 * A `condition()` the workflow is still waiting on.
 *
 * The answer to the one diagnostic question the engine could not previously
 * answer: an execution that is `running` with nothing pending is either mid-task
 * or parked, and those are opposite conclusions. Pending work is derived from
 * history; a parked condition leaves no history at all — that is the point of it
 * — so it has to be reported by the worker that replayed it.
 */
export interface ParkedCondition {
  /**
   * The condition's own id. From `condSeq`, which is deliberately separate from
   * the command `seq` counter so that parking never perturbs command numbering —
   * this is *not* a seq you will find in history.
   */
  seq: number;
  /**
   * Where `condition()` was called, frames innermost first.
   *
   * Absent when the runtime has no stack-capture API, and absent on state
   * recorded before sites were captured. A reader must treat it as unknown
   * rather than as "no site".
   */
  site?: string;
}

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
   * makes it survive a crash and what makes `Client.describe()` show the live value
   * rather than the one from the last rollover.
   */
  carryover?: Carryover;
  /**
   * What the workflow is parked on at the end of this task.
   *
   * Reported on every task and replaces whatever was stored, rather than
   * accumulating: a condition that unparked is no longer where the workflow is,
   * and a list that only grew would describe everywhere it had ever waited.
   */
  parked?: ParkedCondition[];
}

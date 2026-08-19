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
import type {WorkflowReport, WorkflowSummary} from './workflow_descriptor';

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
   *
   * **The claim lasts as long as the record.** A server configured with a
   * retention window deletes closed executions after it, and a start under a
   * deleted id creates a fresh execution — "one workflow per order" holds for
   * the window, not forever. A server without retention (the default) keeps
   * every claim for its store's lifetime.
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
   * A client that thinks in durations — an operator UI offering "last hour",
   * "last day" — resolves them against its own clock before it asks, which is
   * the only clock it can honestly resolve them against.
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
 * Where a server is bound, and which machine it is bound on.
 *
 * **All three or none.** They are read from a single `listen`, so a server that
 * knows any of them knows all of them, and a server with no transport in front
 * of it — which `createServerHost()` on its own is, and which the specs use —
 * knows none. `ServerHealth` therefore carries this as a `Partial` rather than
 * as three independently optional fields, which would offer eight combinations
 * where only two exist.
 *
 * A fact about the *process*, not about the store or the executions: none of it
 * changes after the port is bound, and none of it costs a scan to answer.
 *
 * Every field here is something the server observed about itself. Nothing here
 * is inferred — where to *dial* the server is an inference, and it lives in
 * `serverUrl` below, on the reader's side of the wire where it can be
 * corrected.
 */
export interface ServerEndpoint {
  /**
   * The interface bound, as the transport reports it — `127.0.0.1`, `0.0.0.0`,
   * `::`.
   *
   * This is the field that answers "why can nothing else reach this server". A
   * server on loopback is unreachable from every other machine, and nothing else
   * it says distinguishes it from one listening to the world: both are up, both
   * report their durability, and both answer this probe perfectly well for
   * whoever can already reach them. It is also the one thing here a caller
   * cannot work out for itself — it knows the address that happened to work for
   * *it*, which says nothing about what else the server accepts.
   */
  host: string;
  /**
   * The port bound — the resolved value after `--port=0`, over the wire.
   *
   * `server_main.ts` prints it on stdout as well, and says there why that line
   * is a convenience rather than the contract: it is observable only by whoever
   * spawned the process, holding a pipe, at the moment it started. This answers
   * the same question from anywhere, at any time, about a process nobody here
   * spawned.
   */
  port: number;
  /**
   * The machine the process runs on, as it calls itself — `os.hostname()`.
   *
   * What turns a fleet of identically-configured servers into distinguishable
   * ones, and the only field here that is about the box rather than the socket.
   * The workers already have this: `DEFAULT_IDENTITY` is `${pid}@${hostname}`,
   * on the reasoning that an identity should be something an operator can act on
   * — find the process, read its logs. The server was the one tier with no such
   * identity, which is the gap this closes.
   *
   * Read once at bind time, not per probe.
   */
  hostname: string;
}

/**
 * Bind addresses that mean "every interface" rather than a reachable one.
 *
 * Node normalizes to these two: `--host=0.0.0.0` reports `0.0.0.0`, and both
 * `::` and an omitted host on a dual-stack build report `::`.
 */
const WILDCARD_BINDS: ReadonlySet<string> = new Set(['0.0.0.0', '::']);

/**
 * Where to dial the server a `health()` reply came from — **the reader's
 * inference, not the server's claim.**
 *
 * A function here rather than a `serverUrl` field on `ServerEndpoint`, and the
 * difference is not cosmetic. The server knows what it bound. It does not know
 * what sits in front of that — a reverse proxy, a published container port, a
 * NAT, a Service — and cannot, because nothing tells it. Putting a URL on the
 * wire would dress that guess as a fact the server had checked, and it would be
 * *least* accurate exactly where it was most wanted: in the single-VM case the
 * answer is the address the caller already dialed, and in the containerized and
 * proxied cases the issue asks about, it is wrong. A plausible wrong value is
 * worse than an obviously missing one, because a placeholder gets filled in and
 * a URL gets pasted into a unit file.
 *
 * So the inference belongs on the side that can correct it. This is the same
 * move as `isStuck`, `isQueueServed` and `isNameServed`: derived answers ship as
 * exported functions over the projection types, so no consumer reimplements one
 * and gets it subtly wrong, and none of them is mistaken for something the
 * server asserted. Living in `protocol/` also makes it importable by a browser,
 * which the transport-side code that produces the endpoint is not.
 *
 * Two rules, which are the whole reason this is not a template literal at the
 * call site:
 *
 * - **A wildcard bind is substituted with `hostname`.** `http://0.0.0.0:7777`
 *   is an address to listen on rather than one to dial. Every interface would
 *   be an equally correct answer, so the machine's own name is used — the one
 *   candidate that does not require picking an interface for the reader.
 * - **An IPv6 literal is bracketed.** Without it `::1` and port 7777 concatenate
 *   to `http://::1:7777`, which no URL parser accepts — so the failure is not a
 *   subtly wrong address but a consumer that cannot dial at all.
 *
 * `undefined` when the reply carries no endpoint, which is the honest answer for
 * a server that has not been told where it is bound rather than a URL invented
 * on its behalf. A *complete* `ServerEndpoint` always yields one, which is what
 * the first overload says — the tier that just bound a listener should not have
 * to handle an absence it knows cannot happen.
 *
 * **If a deployment needs an authoritative URL**, the server has to be *told*
 * one — an advertise flag, supplied by whoever knows the topology — and that
 * would be a real field on this type, because a human asserted it. Nothing has
 * asked for one; this is the door it would come through.
 */
export function serverUrl(endpoint: ServerEndpoint): string;
export function serverUrl(
  endpoint: Partial<ServerEndpoint>,
): string | undefined;
export function serverUrl(
  endpoint: Partial<ServerEndpoint>,
): string | undefined {
  const {host, port, hostname} = endpoint;
  if (host === undefined || port === undefined) return undefined;
  const dialable = WILDCARD_BINDS.has(host) ? hostname : host;
  if (dialable === undefined) return undefined;
  // Bracket by the colon rather than by address family: the value may be a
  // hostname substituted for a wildcard, and hostnames never contain one.
  return `http://${dialable.includes(':') ? `[${dialable}]` : dialable}:${port}`;
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
 *
 * The `ServerEndpoint` half is present when something has told the host where
 * it is bound, which every deployed server does and a bare `createServerHost()`
 * does not — see that type for why it arrives whole or not at all.
 */
export interface ServerHealth extends Partial<ServerEndpoint> {
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
 * looking at when they open an execution that is not moving.
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
  props: unknown;
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
 * ## History answers it too
 *
 * Every retry round leaves an `activityRetryScheduled` carrying the attempt, the
 * ceiling, the backoff deadline and the error, so an activity that failed four
 * times and succeeded on the fifth is distinguishable from one that succeeded
 * first time. Reducing those per `seq` counts retries after the fact, and a
 * timeline renders them like any other event.
 * `spec/server/activity_retry_scheduled.spec.ts` pins what makes that reduction
 * sound — one event per retry rather than per failure, and the per-attempt error
 * nothing else keeps.
 *
 * Two things qualify it. A rollover empties history, so earlier runs' retries are
 * gone. And a task redelivered because its lease expired — a worker that died
 * mid-attempt — leaves no `activityRetryScheduled` and burns no budget, because
 * nothing reported a result for it; the re-run is still visible, since every
 * *pickup* appends an `activityStarted`. So the two counts answer different
 * questions: `activityRetryScheduled` per `seq` counts failures the retry policy
 * acted on, `activityStarted` per `seq` counts times the work was attempted,
 * crash-redeliveries included. A reader who wants the second and counts the
 * first undercounts, silently.
 *
 * ## Why this stays a live view
 *
 * Not because history cannot answer it, but because of what asking costs. The
 * question is about the whole server, and deriving it from history means
 * fetching every execution and reducing each one — the exact cost the grouped
 * counts above exist to avoid. These come from state the scan already loads,
 * and they answer about *now*, which is what is wanted when something is on
 * fire and what a total over all time blurs.
 *
 * For rates over time either source serves: reduce `activityRetryScheduled`
 * across the executions in question, or read `activity.settled` and
 * `activity.retry_scheduled` off the log stream, which carry the activity name
 * for a pipeline already ingesting stderr.
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
 * What a worker says about itself when asking for a task.
 *
 * An object rather than a positional list, for the reason `WorkflowWorker.replayTask`
 * gives about its own signature: a list lets a call site omit a field and type-check
 * anyway, and it grows by one each time the fleet view learns to report something new.
 * This one has now grown once.
 *
 * Every field is optional, and each absence degrades a different thing rather than
 * breaking dispatch — a caller supplying none still gets tasks.
 */
/** What a worker sends when it declares what it can run. */
export interface WorkflowReportRequest {
  identity: string;
  taskQueue?: string;
  /**
   * A digest of `workflows`, which the worker also puts on every poll.
   *
   * This is what makes a slow push safe: the server can tell whether the copy it holds is
   * still the one the worker is running, without the worker resending it. A mismatch means
   * stale, and stale is reported as *unknown* rather than as fact.
   */
  hash: string;
  workflows: readonly WorkflowReport[];
}

export interface PollRequest {
  /**
   * Which pool to take work from. **Omitted means any queue**, which exists for the
   * in-process runtime: one set of loops there serves every execution regardless of
   * how it was routed, so `createLocalRuntime` keeps working as a harness whatever
   * queue names a workflow uses. A deployed worker always names its queue.
   */
  taskQueue?: string;
  /**
   * Who is asking. Optional, because a worker that does not name itself still gets
   * tasks — only the fleet view suffers, reporting that something polled without
   * being able to say what. See `WorkerInfo`.
   */
  identity?: string;
  /**
   * A digest of what this worker has registered — the same value it sends with
   * `reportWorkflows`.
   *
   * This carried the **names themselves** at first, which was correct and expensive:
   * a poll runs at the idle interval, five milliseconds, so a worker with fifty
   * workflows re-sent about a kilobyte a couple of hundred times a second to repeat an
   * answer that changes only when the binary does.
   *
   * A digest keeps every property that mattered and costs sixteen bytes. It is sent on
   * **every** poll rather than announced once, which is what makes it self-healing: a
   * worker redeployed under one identity, or a server restarted beneath a live fleet,
   * converges on the next poll.
   *
   * ## It is a staleness check, not only a saving
   *
   * The names now arrive on a slow push, which raises a question the poll answers: is
   * the copy the server holds still the one this worker is running? Matching hashes say
   * yes. A mismatch says the report is stale — a worker redeployed since it last
   * reported — and stale is treated as **unknown** rather than as fact, which is why
   * `isNameServed` is three-valued.
   *
   * **Absent means unknown, not none**, the same as before: a worker that sends no
   * digest is reported as unknown rather than as serving nothing, because "this queue
   * serves no workflows" and "we cannot tell" want different responses.
   *
   * Reported, never enforced — see `isNameServed` for why refusing would be wrong.
   */
  servesHash?: string;
}

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
   * The workflow names this worker has registered — **resolved**, not merely relayed.
   *
   * It is the report this worker last pushed, but only when the digest on its most
   * recent poll still matches the digest that report was sent under. When they differ
   * the worker has been redeployed since it reported, so the server's copy describes
   * code that is no longer running, and this is absent rather than wrong.
   *
   * **Absent therefore means unknown**, and covers three cases that deserve the same
   * treatment: a worker that never reported, one that reports no digest on its polls,
   * and one whose report has gone stale. None of them justify the stronger claim that
   * the queue serves nothing — see `isNameServed`, which is three-valued for exactly
   * this reason.
   *
   * Two workers on one queue resolving to *different* sets is a fleet running two
   * versions of one worker binary, the condition #65 says is invisible. This is what
   * makes it a diff rather than a mystery.
   */
  serves?: readonly string[];
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
   *
   * Quiet workers linger here for minutes, then go: long enough that the one
   * being hunted is still listed with when it went quiet, bounded so restarted
   * dev workers — a fresh `pid@host` identity per restart — do not pile up.
   * The aggregate timestamps outlive them.
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
 * Defined here, beside the type, so no two clients drift into different answers
 * to the same question — the same reason `isStuck` lives here. Both predicates
 * are exported from `workflow-engine/protocol` for that reason: a tool outside
 * this repo reading `QueueWorkers` gets the verdict rather than reimplementing
 * it, and reimplementing it is how "served" quietly comes to mean two things.
 *
 * **A busy worker would otherwise look like an absent one.** The activity loop
 * is sequential: it awaits the activity it claimed before polling again, so a
 * worker running a single 60-second activity stops polling for 60 seconds and
 * its queue goes stale. That is distinguishable — a worker holding a live
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
 * Can anything on `taskQueue` actually run `name` — a workflow type for a
 * `workflow` role, an activity name for an `activity` one?
 *
 * The companion to `isQueueServed`, and the difference between them is the whole
 * point of #88. `isQueueServed` asks *is anyone there*; this asks *can any of them
 * do this*. A queue can be busily served by workers that have never heard of the
 * workflow being dispatched to it, and until a poll carried a manifest the server
 * could not tell that from a deploy still rolling out.
 *
 * ## Three answers, not two
 *
 * `true` and `false` are the easy ones. **`undefined` means nobody said**, and
 * collapsing it into `false` is the mistake this signature exists to prevent: a
 * worker that reports no manifest would then read as a worker that can run nothing,
 * and every queue served by an older binary would look broken.
 *
 * So a caller gets to distinguish "confirmed missing" from "unknown", which matters
 * because they warrant different words — "no worker on `reports` runs `nightly`"
 * against "cannot confirm; workers here do not report what they serve".
 *
 * ## Never a reason to refuse
 *
 * `false` is a **report**, not a veto. `spec/integration/distributed.spec.ts` settles
 * this: an unregistered name used to fail an execution on the reading that it was a
 * typo, and that was wrong, because once tasks route by queue it far more often means
 * a deploy still rolling — *"failing fast would trade a recoverable state for an
 * unrecoverable one"*. What a manifest adds is the ability to say which of the two it
 * is, not permission to act on the answer.
 */
export function isNameServed(
  queues: readonly QueueLiveness[],
  taskQueue: string,
  role: WorkerRole,
  name: string,
): boolean | undefined {
  const workers = workersServing(queues, taskQueue, role);
  if (workers.length === 0) return undefined;
  // Silence from *any* worker makes the whole answer unknown: one that did not say
  // may be the one that can run it, so a `false` derived from the others would be a
  // claim the fleet does not support.
  if (workers.some((w) => w.serves === undefined)) return undefined;
  return workers.some((w) => w.serves?.includes(name) === true);
}

/**
 * The workers that serve `taskQueue` in `role`, including the ones polling
 * every queue.
 *
 * Beside `isQueueServed` and for the same reason: "a worker on `*` serves
 * `email` too" is a rule, and two clients applying it differently would
 * disagree about how big a fleet is. Returns every worker in the rows it is
 * given, however long quiet — staleness is `lastPolledAt`, which the caller can
 * read, and filtering here would hide the worker that went quiet, which is
 * usually the one being looked for. The server bounds how long that can be:
 * it retains a quiet worker's row for minutes, not forever, so a recently-dead
 * worker is listed and an old session's pile is not (`WORKER_RETENTION_MS`,
 * server-side).
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
    props?: unknown,
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
  /**
   * Every workflow the live fleet reports, deduped by name.
   *
   * The catalogue a dashboard lists. Sourced from what workers push rather than from
   * executions, so a workflow that has never run still appears — which is the point, since
   * the question it answers is "what can I start".
   *
   * *Live* fleet, present tense: a report only counts while the worker that pushed it
   * still polls with a digest matching it (or is mid-task). A worker that stopped takes
   * its workflows — and the queues it served them on — out of the catalogue with it,
   * rather than a queue last served a week ago reading as one that can run work today.
   */
  listWorkflows(): Promise<WorkflowSummary[]>;
  /**
   * A worker declaring what it has registered.
   *
   * Pushed rather than polled, and on its own call rather than on the poll, because
   * descriptions are large and the poll runs at the idle interval — see
   * `PollRequest.servesHash` for how the two are reconciled.
   */
  reportWorkflows(report: WorkflowReportRequest): Promise<void>;
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
  pollWorkflowTask(request?: PollRequest): Promise<WorkflowTask | undefined>;
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
  /** Claim the next activity task; see `PollRequest`. */
  pollActivityTask(
    request?: PollRequest,
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
  props: unknown;
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
 * The answer to the one diagnostic question nothing else can settle: an
 * execution that is `running` with nothing pending is either mid-task
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

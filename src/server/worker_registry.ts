/**
 * @fileoverview
 * Who is asking for work: the last time each task queue was polled, per role.
 *
 * This is the only part of the server that knows anything about the *fleet*
 * rather than about executions. It exists because the execution views cannot
 * answer the question operators actually arrive with. An execution parked on an
 * activity renders identically whether a worker is a millisecond from claiming
 * it or no worker has ever polled its queue — and in practice the second is the
 * more common cause of "it's stuck", because it is a deployment mistake rather
 * than a code one.
 *
 * ## Deliberately in memory, and deliberately not a port
 *
 * Every other piece of server state has a `ports/` contract with a memory and a
 * file adapter behind it. This one has neither, because worker liveness is not
 * a fact that should survive the process that observed it. A restarted server
 * that restored "queue `email` was polled" from disk would be asserting
 * something it has not seen, and asserting it exactly when it is least likely
 * to be true — during a restart, when workers may also be down. Losing the
 * table on restart is correct: workers poll every few milliseconds, so it
 * refills almost immediately, and until it does the honest answer is "nothing
 * has polled yet".
 *
 * ## Workers, now, and not only polls
 *
 * Polls carry an identity, so this counts and names workers rather than merely
 * observing that *something* asked. The aggregate timestamps are still kept
 * beside the per-worker rows: they answer "is this pool served at all", which
 * survives a worker that never identified itself, and they are the cheapest
 * thing for a caller that only needs a yes or no.
 *
 * An unidentified poll still updates the aggregate and creates no worker row.
 * That is the honest reading — something asked, and it did not say who — and it
 * keeps `createLocalRuntime` and any hand-rolled client working unchanged.
 *
 * ## What it still cannot see
 *
 * Whether a worker is *busy* is not knowable from polls, and is not decided
 * here: the activity loop is sequential, so a worker mid-activity stops asking
 * and looks identical to one that died. `server_core` joins these rows against
 * the outstanding leases to settle that, because the lease tables are the only
 * things that know. See `isQueueServed` in `protocol/service.ts` for how the
 * combined reading is interpreted.
 */

import {
  ANY_TASK_QUEUE,
  type WorkerInfo,
  type WorkerRole,
  type WorkflowReport,
  type WorkflowReportRequest,
} from '../protocol';

export interface WorkerRegistry {
  /**
   * Note that `role` just asked `taskQueue` for work. Called on every poll,
   * including the ones that come back empty — an idle poll is the strongest
   * evidence there is that a worker is alive and waiting.
   *
   * `taskQueue` `undefined` means the caller polls every queue; it is recorded
   * under `ANY_TASK_QUEUE`. `identity` `undefined` means the caller did not say
   * who it is: the queue's aggregate still moves, and no worker row appears.
   */
  recordPoll(
    role: WorkerRole,
    taskQueue: string | undefined,
    identity?: string,
    servesHash?: string,
  ): void;
  /**
   * Every queue that has ever been polled, in the order first seen, each with
   * the workers seen on it.
   *
   * Returns `ObservedQueue`, not `QueueWorkers`: what a table of polls can say
   * is strictly less than what the server reports, and the difference is not
   * cosmetic. `busy` needs the lease tables and backlog needs the task queues;
   * neither is knowable here. This used to return the wire type with
   * `busy: false` filled in — a conservative placeholder, but still a row
   * asserting something it had not observed. Saying it in the type instead makes
   * the gap impossible to read past, and it is `server_core.listQueues` that
   * closes it.
   */
  queues(): ObservedQueue[];
  /**
   * Record what a worker says it has registered.
   *
   * Kept per worker rather than merged into one catalogue, because two workers reporting
   * different descriptions for one name is the fact worth surfacing (#65) and a merge
   * would be the thing that hides it.
   */
  recordReport(report: WorkflowReportRequest): void;
  /** What each worker last reported, one row per worker that has reported at all. */
  reports(): ReportedWorkflows[];
}

/** One worker's reported set, with the digest it was reported under. */
export interface ReportedWorkflows {
  identity: string;
  taskQueue: string;
  hash: string;
  workflows: readonly WorkflowReport[];
}

/** A worker as polls alone can describe it: everything but whether it is busy. */
export type ObservedWorker = Omit<WorkerInfo, 'busy'>;

/**
 * A queue as polls alone can describe it: who asked, and when.
 *
 * The same shape as `QueueWorkers` minus every field that needs a source this
 * module does not have. Deliberately not `Partial<QueueWorkers>`, which would
 * make the missing fields look optional rather than unknowable.
 */
export interface ObservedQueue {
  taskQueue: string;
  workflowPolledAt?: number;
  activityPolledAt?: number;
  workers: ObservedWorker[];
}

/** A worker row, before anything knows whether it is busy. */
interface Observed {
  identity: string;
  role: WorkerRole;
  lastPolledAt: number;
  /** The digest from its most recent poll. Absent when it sent none. */
  servesHash?: string;
}

export function createWorkerRegistry(
  now: () => number = Date.now,
): WorkerRegistry {
  // Insertion-ordered, which is what a Map gives us, so a listing is stable
  // between reads rather than reshuffling under a polling dashboard.
  const seen = new Map<string, ObservedQueue>();
  // Keyed by queue, then by role and identity together — a row per role,
  // because a process running both loops fails at them independently. The
  // composite is only ever a key: both halves are kept on the value rather than
  // parsed back out of it, so no separator has to be chosen that an
  // operator-supplied identity cannot contain.
  const workers = new Map<string, Map<string, Observed>>();
  // Keyed by identity and queue, and deliberately *not* by role: a worker reports what it
  // has registered, which is a property of the process rather than of the loop that
  // happens to be asking. A process serving both roles reports once.
  const reported = new Map<string, ReportedWorkflows>();

  /** Distinct per (role, identity); never parsed, only compared. */
  function workerKeyOf(role: WorkerRole, identity: string): string {
    return `${role} ${identity}`;
  }

  /**
   * The names a worker resolves to, or nothing when the answer is unknown.
   *
   * Unknown covers three cases that all deserve silence rather than a claim: the worker
   * has never reported, it sends no digest on its polls, or its report is stale because
   * the digest moved. `WorkerInfo.serves` documents why they are not distinguished.
   */
  function servesOf(
    taskQueue: string,
    observed: Observed,
  ): {serves?: readonly string[]} {
    if (observed.servesHash === undefined) return {};
    const report = reported.get(`${observed.identity} ${taskQueue}`);
    if (!report || report.hash !== observed.servesHash) return {};
    return {serves: report.workflows.map((w) => w.name)};
  }

  return {
    recordPoll(role, taskQueue, identity, servesHash) {
      const key = taskQueue ?? ANY_TASK_QUEUE;
      let entry = seen.get(key);
      if (!entry) {
        entry = {taskQueue: key, workers: []};
        seen.set(key, entry);
      }
      // Mutated in place rather than replaced: this runs on every poll from
      // every worker — hundreds a second at the default 5ms idle interval — and
      // it is the hottest write in the server.
      const at = now();
      if (role === 'workflow') entry.workflowPolledAt = at;
      else entry.activityPolledAt = at;
      if (identity === undefined) return;
      let onQueue = workers.get(key);
      if (!onQueue) {
        onQueue = new Map();
        workers.set(key, onQueue);
      }
      const workerKey = workerKeyOf(role, identity);
      const worker = onQueue.get(workerKey);
      if (worker) {
        worker.lastPolledAt = at;
        // Overwritten on every poll, so a redeployed worker replaces its digest
        // rather than keeping the one it started with — which is what lets a stale
        // report be recognised as stale.
        if (servesHash !== undefined) worker.servesHash = servesHash;
      } else
        onQueue.set(workerKey, {
          identity,
          role,
          lastPolledAt: at,
          ...(servesHash === undefined ? {} : {servesHash}),
        });
    },

    recordReport(report) {
      const key = `${report.identity} ${report.taskQueue ?? ANY_TASK_QUEUE}`;
      // Replaced wholesale, never merged. A worker redeployed under one identity must
      // report what it runs *now*; accumulating the union across deploys is precisely
      // what would hide a fleet running two versions of one worker binary.
      reported.set(key, {
        identity: report.identity,
        taskQueue: report.taskQueue ?? ANY_TASK_QUEUE,
        hash: report.hash,
        workflows: [...report.workflows],
      });
    },

    reports() {
      // Copied, like `queues()`, so a caller cannot hold a reference that changes under
      // it while it renders.
      return [...reported.values()].map((r) => ({
        ...r,
        workflows: [...r.workflows],
      }));
    },

    queues() {
      // Copied, so a caller cannot hold a reference that keeps changing under
      // it while it renders.
      return [...seen.values()].map((q) => ({
        ...q,
        workers: [...(workers.get(q.taskQueue)?.values() ?? [])]
          // Field by field rather than spread, because `taskQueue` comes from the
          // enclosing row and not from the worker. The cost is that a new field on
          // `Observed` is silently dropped here unless it is added — `serves` was,
          // and the spec that caught it is `worker_manifest.spec.ts`.
          .map((observed) => ({
            identity: observed.identity,
            role: observed.role,
            taskQueue: q.taskQueue,
            lastPolledAt: observed.lastPolledAt,
            // Resolved here rather than relayed, by matching the digest on the poll
            // against the digest the report was pushed under. They agree only while the
            // server's copy still describes what this worker is running; a redeployed
            // worker's poll carries a new digest from its first poll onward, so its
            // stale report stops being reported the moment it is stale rather than when
            // the replacement happens to arrive.
            //
            // Omitted rather than set to `undefined`, so a worker with nothing resolved
            // produces a row with no such key. The two are equivalent over JSON and are
            // not equivalent to `toEqual`, and an explicit `serves: undefined` reads as
            // an assertion where silence is meant.
            ...servesOf(q.taskQueue, observed),
          }))
          // Newest poll first, tie-broken by identity so two reads of an idle
          // fleet cannot disagree about the order.
          .sort(
            (a, b) =>
              b.lastPolledAt - a.lastPolledAt ||
              (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0),
          ),
      }));
    },
  };
}

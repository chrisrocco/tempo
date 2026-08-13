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
} from '../protocol/service';

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
    serves?: readonly string[],
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
  /** What it last said it can run. Absent when it never said — see `PollRequest.serves`. */
  serves?: readonly string[];
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

  /** Distinct per (role, identity); never parsed, only compared. */
  function workerKeyOf(role: WorkerRole, identity: string): string {
    return `${role} ${identity}`;
  }

  return {
    recordPoll(role, taskQueue, identity, serves) {
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
        // Overwritten on every poll rather than merged, so a redeployed worker
        // replaces its manifest instead of accumulating the union of what it has
        // ever been able to run — which is the case #65 is about.
        if (serves !== undefined) worker.serves = serves;
      } else
        onQueue.set(workerKey, {
          identity,
          role,
          lastPolledAt: at,
          ...(serves === undefined ? {} : {serves}),
        });
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
            // Omitted rather than set to `undefined`, so a worker that said nothing
            // produces a row with no such key. The two are equivalent over JSON and
            // are not equivalent to `toEqual`, and a row carrying an explicit
            // `serves: undefined` reads as an assertion where silence is meant.
            ...(observed.serves === undefined ? {} : {serves: observed.serves}),
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

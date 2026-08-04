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
 * ## Polls, not workers
 *
 * Nothing in `pollWorkflowTask` or `pollActivityTask` carries a worker
 * identity, so the server cannot count workers or name them — only observe that
 * *something* asked. Adding an identity to the poll would make "3 workers on
 * `default`, one silent for 5 minutes" possible, and is the natural next step;
 * it is a change to the worker-facing protocol and every implementation of it,
 * which is why it is not folded in here.
 *
 * See `isQueueServed` in `protocol/service.ts` for how a reading is
 * interpreted, including the case a poll record cannot distinguish: a
 * sequential worker busy inside a long activity stops polling, and looks
 * exactly like one that is gone.
 */

import {
  ANY_TASK_QUEUE,
  type QueueWorkers,
  type WorkerRole,
} from '../protocol/service';

export interface WorkerRegistry {
  /**
   * Note that `role` just asked `taskQueue` for work. Called on every poll,
   * including the ones that come back empty — an idle poll is the strongest
   * evidence there is that a worker is alive and waiting.
   *
   * `undefined` means the caller polls every queue; it is recorded under
   * `ANY_TASK_QUEUE`.
   */
  recordPoll(role: WorkerRole, taskQueue: string | undefined): void;
  /** Every queue that has ever been polled, in the order first seen. */
  queues(): QueueWorkers[];
}

export function createWorkerRegistry(
  now: () => number = Date.now,
): WorkerRegistry {
  // Insertion-ordered, which is what a Map gives us, so a listing is stable
  // between reads rather than reshuffling under a polling dashboard.
  const seen = new Map<string, QueueWorkers>();

  return {
    recordPoll(role, taskQueue) {
      const key = taskQueue ?? ANY_TASK_QUEUE;
      let entry = seen.get(key);
      if (!entry) {
        entry = {taskQueue: key};
        seen.set(key, entry);
      }
      // Mutated in place rather than replaced: this runs on every poll from
      // every worker — hundreds a second at the default 5ms idle interval — and
      // it is the hottest write in the server.
      if (role === 'workflow') entry.workflowPolledAt = now();
      else entry.activityPolledAt = now();
    },

    queues() {
      // Copied, so a caller cannot hold a reference that keeps changing under
      // it while it renders.
      return [...seen.values()].map((q) => ({...q}));
    },
  };
}

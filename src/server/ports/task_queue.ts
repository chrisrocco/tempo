/**
 * @fileoverview
 * The port activity work is dispatched through. Poll hands out a leased task
 * (with a token + timeout); `complete` acks it. A task not completed before its
 * lease expires is redelivered — which is why activities are at-least-once and
 * their side effects must be idempotent. `ActivityTask`/`LeasedActivityTask` live
 * in `protocol` because they are the shared server/worker contract.
 *
 * Redelivery means a seq can be *reported* twice — the redelivered task acks, and
 * then the original worker acks late. History is kept clean of that by the server,
 * not by this port and not by replay: `reportActivityResult` drops a completion
 * for a seq that already has a terminal event (see `server_core`). Activity **side
 * effects** are the author's problem — use an idempotency key. The framework
 * guarantees at-least-once; exactly-once effects are out of scope by design.
 *
 * Lease expiry is not the only way an attempt ends. An activity carrying
 * `startToCloseTimeoutMs` is given up on at its deadline, and the server `complete`s
 * the token then — deliberately acking work that never finished, so this queue
 * does not redeliver it into a second concurrent run. From here that is
 * indistinguishable from a normal ack, which is the point: the queue delivers and
 * expires, and the server owns every policy about when an attempt is over.
 */

import type {ActivityTask, LeasedActivityTask, TaskToken} from '../../protocol';

export interface TaskQueue {
  /** `taskQueue` names the pool that may serve this task. */
  enqueue(task: ActivityTask, taskQueue: string): void;
  /**
   * The next task on `taskQueue`, leased with a token, or undefined when that
   * pool has nothing waiting. Omitting the name matches **any** pool, which is
   * how the in-process runtime serves every execution with one set of loops.
   */
  poll(taskQueue?: string, identity?: string): LeasedActivityTask | undefined;
  /**
   * The worker identities holding a live lease right now.
   *
   * Exposed on the port because it is the only evidence that separates a worker
   * busy inside a long activity from one that has gone away — both stop polling.
   * See `LeaseTable.holders`.
   */
  leaseHolders(): Set<string>;
  /**
   * How many activity tasks are waiting to be handed out, per pool.
   *
   * **Waiting, not outstanding.** A task a worker is holding a live lease on is
   * being worked and is not backlog; `leaseHolders` is what reports those. A
   * task whose lease has *lapsed* is counted here, because it is going back out
   * on the next poll — and on a pool nobody is polling, that next poll never
   * comes, which is precisely the pool an operator is asking about.
   *
   * Keyed by pool name, and pools with nothing waiting are absent rather than
   * present with a zero — the map's keys are then "pools with work", which is
   * what lets a caller notice a pool that has a backlog and no workers at all.
   * That pool is invisible everywhere else: the worker registry only knows pools
   * something has *polled*.
   *
   * A count, not a promise about the future: it is a live reading of an
   * in-memory queue, and says nothing about how long any of it has waited.
   */
  backlog(): ReadonlyMap<string, number>;
  /** Ack a leased task. A token whose lease already expired is a no-op (redelivered). */
  complete(token: TaskToken): void;
  /**
   * Extend a lease because the worker holding it says it is still working.
   * Returns false if the lease had already expired, in which case the task is
   * someone else's now and must not be reclaimed.
   *
   * `leaseMs` sets how long this one lease runs for, now and on every later
   * renewal — an implementation may hold it longer than that but never shorter,
   * so the queue's own default is a floor. It exists because the server, not
   * this port, knows when an attempt is over: an activity carrying
   * `heartbeatTimeoutMs` is reaped by that deadline, and a generic lease
   * expiring underneath it would redeliver work the server has not given up on.
   * Omitted, the lease keeps whatever duration it already had.
   */
  renew(token: TaskToken, leaseMs?: number): boolean;
}

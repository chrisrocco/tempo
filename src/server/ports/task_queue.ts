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

import type {
  ActivityTask,
  LeasedActivityTask,
  TaskToken,
} from '../../protocol';

export interface TaskQueue {
  /** `taskQueue` names the pool that may serve this task. */
  enqueue(task: ActivityTask, taskQueue: string): void;
  /**
   * The next task on `taskQueue`, leased with a token, or undefined when that
   * pool has nothing waiting. Omitting the name matches **any** pool, which is
   * how the in-process runtime serves every execution with one set of loops.
   */
  poll(taskQueue?: string): LeasedActivityTask | undefined;
  /** Ack a leased task. A token whose lease already expired is a no-op (redelivered). */
  complete(token: TaskToken): void;
  /**
   * Extend a lease because the worker holding it says it is still working.
   * Returns false if the lease had already expired, in which case the task is
   * someone else's now and must not be reclaimed.
   */
  renew(token: TaskToken): boolean;
}

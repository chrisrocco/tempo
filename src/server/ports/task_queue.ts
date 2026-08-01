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
 */

import type {
  ActivityTask,
  LeasedActivityTask,
  TaskToken,
} from '../../protocol';

export interface TaskQueue {
  enqueue(task: ActivityTask): void;
  /** The next task, leased with a token, or undefined when the queue is empty. */
  poll(): LeasedActivityTask | undefined;
  /** Ack a leased task. A token whose lease already expired is a no-op (redelivered). */
  complete(token: TaskToken): void;
}

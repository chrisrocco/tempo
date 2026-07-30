/**
 * @fileoverview
 * The port activity work is dispatched through. Poll hands out a leased task
 * (with a token + timeout); `complete` acks it. A task not completed before its
 * lease expires is redelivered — which is why activities are at-least-once and
 * their side effects must be idempotent. `ActivityTask`/`LeasedActivityTask` live
 * in `protocol` because they are the shared server/worker contract.
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

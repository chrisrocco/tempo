// The port activity work is dispatched through. In the in-proc form the server
// enqueues a task and hands it straight to the activity worker; in the
// distributed form (Phase 5) `poll` grows a lease + timeout and redelivery, and
// activity workers poll it across the network. `ActivityTask` lives in `protocol`
// because it is the shared server/worker contract.
import type { ActivityTask } from '../../protocol';

export interface TaskQueue {
  enqueue(task: ActivityTask): void;
  /** The next available task, or undefined when the queue is empty. */
  poll(): ActivityTask | undefined;
  // Phase 5: lease(token, timeoutMs), ack(token), expireAndRequeue().
}

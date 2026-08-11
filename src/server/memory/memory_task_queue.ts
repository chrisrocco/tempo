/**
 * @fileoverview
 * In-memory TaskQueue: a FIFO with leasing. `poll` leases the next task with a
 * token + timeout; `complete` acks it. On each poll, tasks whose leases expired
 * are redelivered (unshifted to the front) — a crashed activity worker's task
 * runs again, which is the at-least-once behavior activity authors must be
 * idempotent against. Lease/expiry semantics come from the shared LeaseTable.
 */

import type {ActivityTask, LeasedActivityTask, TaskToken} from '../../protocol';
import {LeaseTable} from '../lease';
import type {TaskQueue} from '../ports/task_queue';

const DEFAULT_LEASE_MS = 30_000;

/** A queued task plus the pool allowed to serve it. */
interface Routed {
  task: ActivityTask;
  taskQueue: string;
}

export class MemoryTaskQueue implements TaskQueue {
  private readonly queue: Routed[] = [];
  private readonly leases = new LeaseTable<Routed>('act');

  constructor(private readonly leaseMs: number = DEFAULT_LEASE_MS) {}

  enqueue(task: ActivityTask, taskQueue: string): void {
    this.queue.push({task, taskQueue});
  }

  /**
   * Routing is a filtered scan of one list rather than a queue per name. The
   * alternative — a map of queues — would fragment the lease table too, so a
   * token would no longer identify a task on its own and `complete`/`renew`
   * would need their own routing. Scanning keeps leases and tokens exactly as
   * they were; it costs O(depth) per poll, which is the in-memory adapter's
   * business and not a property of the port.
   */
  poll(taskQueue?: string, identity?: string): LeasedActivityTask | undefined {
    for (const entry of this.leases.reclaimExpired()) this.queue.unshift(entry); // redeliver
    const index =
      taskQueue === undefined
        ? 0
        : this.queue.findIndex((e) => e.taskQueue === taskQueue);
    if (index < 0 || this.queue.length === 0) return undefined;
    const [entry] = this.queue.splice(index, 1);
    return {
      ...entry.task,
      token: this.leases.lease(entry, this.leaseMs, identity),
    };
  }

  leaseHolders(): Set<string> {
    return this.leases.holders();
  }

  backlog(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    const count = (taskQueue: string): void => {
      counts.set(taskQueue, (counts.get(taskQueue) ?? 0) + 1);
    };
    for (const entry of this.queue) count(entry.taskQueue);
    // Lapsed leases are queued again on the next poll, so they are waiting even
    // though they are not in `queue` yet. Read rather than reclaimed: counting
    // must not be what redelivers a task. See `LeaseTable.expired`.
    for (const entry of this.leases.expired()) count(entry.taskQueue);
    return counts;
  }

  complete(token: TaskToken): void {
    this.leases.ack(token); // expired token → no-op (task already redelivered)
  }

  renew(token: TaskToken): boolean {
    return this.leases.renew(token, this.leaseMs);
  }
}

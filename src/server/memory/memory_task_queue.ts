/**
 * @fileoverview
 * In-memory TaskQueue: a FIFO with leasing. `poll` leases the next task with a
 * token + timeout; `complete` acks it. On each poll, tasks whose leases expired
 * are redelivered (unshifted to the front) — a crashed activity worker's task
 * runs again, which is the at-least-once behavior activity authors must be
 * idempotent against. Lease/expiry semantics come from the shared LeaseTable.
 */

import type { ActivityTask, LeasedActivityTask, TaskToken } from '../../protocol';
import type { TaskQueue } from '../ports/task_queue';
import { LeaseTable } from '../lease';

const DEFAULT_LEASE_MS = 30_000;

export class MemoryTaskQueue implements TaskQueue {
  private readonly queue: ActivityTask[] = [];
  private readonly leases = new LeaseTable<ActivityTask>('act');

  constructor(private readonly leaseMs: number = DEFAULT_LEASE_MS) {}

  enqueue(task: ActivityTask): void {
    this.queue.push(task);
  }

  poll(): LeasedActivityTask | undefined {
    for (const task of this.leases.reclaimExpired()) this.queue.unshift(task); // redeliver
    const task = this.queue.shift();
    if (!task) return undefined;
    return { ...task, token: this.leases.lease(task, this.leaseMs) };
  }

  complete(token: TaskToken): void {
    this.leases.ack(token); // expired token → no-op (task already redelivered)
  }
}

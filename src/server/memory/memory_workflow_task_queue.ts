/**
 * @fileoverview
 * In-memory WorkflowTaskQueue with `pump`'s coalescing plus leasing.
 * `pending`/`inFlight`/`rerun` are the queue form of pump's running/rerun flags;
 * the LeaseTable adds a timeout so a task claimed by a crashed worker redelivers.
 * `poll` first sweeps expired leases back to pending (redelivery), so the two
 * mechanisms compose: a lease-race redelivers the task, and the losing worker's
 * version-checked append is then rejected by the server (see server_core).
 */

import {DEFAULT_TASK_QUEUE, type TaskToken} from '../../protocol';
import {LeaseTable} from '../lease';
import type {WorkflowTaskQueue} from '../ports/workflow_task_queue';

const DEFAULT_LEASE_MS = 30_000;

export class MemoryWorkflowTaskQueue implements WorkflowTaskQueue {
  private readonly pending: string[] = [];
  private readonly inFlight = new Set<string>();
  private readonly rerun = new Set<string>();
  private readonly leases = new LeaseTable<string>('wft');

  constructor(private readonly leaseMs: number = DEFAULT_LEASE_MS) {}

  /**
   * An execution's queue never changes, so it is remembered on first enqueue
   * rather than repeated by every caller. `wake` fires from a dozen places —
   * a signal, a timer, a completion, a backoff — and none of them should have to
   * know how the execution was routed.
   */
  private readonly queueOf = new Map<string, string>();

  enqueue(workflowId: string, taskQueue?: string): void {
    if (taskQueue !== undefined) this.queueOf.set(workflowId, taskQueue);
    if (this.inFlight.has(workflowId)) {
      this.rerun.add(workflowId);
      return;
    } // coalesce
    if (!this.pending.includes(workflowId)) this.pending.push(workflowId);
  }

  leaseHolders(): Set<string> {
    return this.leases.holders();
  }

  backlog(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    // The same resolution `poll` uses, so the count and the matching cannot
    // disagree: an execution enqueued without a queue name is served by, and
    // therefore counted on, `default`.
    const count = (workflowId: string): void => {
      const taskQueue = this.queueOf.get(workflowId) ?? DEFAULT_TASK_QUEUE;
      counts.set(taskQueue, (counts.get(taskQueue) ?? 0) + 1);
    };
    for (const workflowId of this.pending) count(workflowId);
    // Lapsed leases go back to pending on the next poll. `rerun` is deliberately
    // not counted: those executions are in flight, and their re-run is a
    // consequence of the task that is already running rather than a queue depth.
    for (const workflowId of this.leases.expired()) count(workflowId);
    return counts;
  }

  poll(
    taskQueue?: string,
    identity?: string,
  ): {token: TaskToken; workflowId: string} | undefined {
    for (const id of this.leases.reclaimExpired()) {
      // redeliver crashed workers' tasks
      this.inFlight.delete(id);
      this.enqueue(id);
    }
    const index =
      taskQueue === undefined
        ? 0
        : this.pending.findIndex(
            (id) => (this.queueOf.get(id) ?? DEFAULT_TASK_QUEUE) === taskQueue,
          );
    if (index < 0 || this.pending.length === 0) return undefined;
    const [workflowId] = this.pending.splice(index, 1);
    this.inFlight.add(workflowId);
    return {
      token: this.leases.lease(workflowId, this.leaseMs, identity),
      workflowId,
    };
  }

  complete(token: TaskToken): void {
    const workflowId = this.leases.ack(token);
    if (workflowId === undefined) return; // lease expired → task already redelivered
    this.inFlight.delete(workflowId);
    if (this.rerun.delete(workflowId)) this.enqueue(workflowId); // a wake arrived mid-task
  }
}

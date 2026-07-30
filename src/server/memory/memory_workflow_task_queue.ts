// In-memory WorkflowTaskQueue with `pump`'s coalescing plus leasing.
// `pending`/`inFlight`/`rerun` are the queue form of pump's running/rerun flags;
// the LeaseTable adds a timeout so a task claimed by a crashed worker redelivers.
// `poll` first sweeps expired leases back to pending (redelivery), so the two
// mechanisms compose: a lease-race redelivers the task, and the losing worker's
// version-checked append is then rejected by the server (see server_core).
import type { TaskToken } from '../../protocol';
import type { WorkflowTaskQueue } from '../ports/workflow_task_queue';
import { LeaseTable } from '../lease';

const DEFAULT_LEASE_MS = 30_000;

export class MemoryWorkflowTaskQueue implements WorkflowTaskQueue {
  private readonly pending: string[] = [];
  private readonly inFlight = new Set<string>();
  private readonly rerun = new Set<string>();
  private readonly leases = new LeaseTable<string>('wft');

  constructor(private readonly leaseMs: number = DEFAULT_LEASE_MS) {}

  enqueue(workflowId: string): void {
    if (this.inFlight.has(workflowId)) { this.rerun.add(workflowId); return; } // coalesce
    if (!this.pending.includes(workflowId)) this.pending.push(workflowId);
  }

  poll(): { token: TaskToken; workflowId: string } | undefined {
    for (const id of this.leases.reclaimExpired()) { // redeliver crashed workers' tasks
      this.inFlight.delete(id);
      this.enqueue(id);
    }
    const workflowId = this.pending.shift();
    if (workflowId === undefined) return undefined;
    this.inFlight.add(workflowId);
    return { token: this.leases.lease(workflowId, this.leaseMs), workflowId };
  }

  complete(token: TaskToken): void {
    const workflowId = this.leases.ack(token);
    if (workflowId === undefined) return; // lease expired → task already redelivered
    this.inFlight.delete(workflowId);
    if (this.rerun.delete(workflowId)) this.enqueue(workflowId); // a wake arrived mid-task
  }
}

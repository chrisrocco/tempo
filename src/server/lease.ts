/**
 * @fileoverview
 * Leasing: when a worker polls a task it gets a token + a deadline. If it acks
 * (completes) before the deadline, the task is done; if it doesn't (the worker
 * crashed or stalled), the lease expires and the task is redelivered to another
 * worker. This is what makes worker crashes survivable — the distributed form of
 * the per-execution exclusion the workflow-task queue provides in one process
 * (see `ports/workflow_task_queue.ts`). `ack` returns the leased item so the queue can
 * release it; a token whose lease already expired acks to `undefined` (its task
 * was redelivered, so this late completer is ignored).
 */

export class LeaseTable<T> {
  private readonly leases = new Map<string, {item: T; deadline: number}>();
  private counter = 0;

  constructor(private readonly prefix: string) {}

  /** Lease an item for `timeoutMs`, returning its token. */
  lease(item: T, timeoutMs: number): string {
    const token = `${this.prefix}-${++this.counter}`;
    this.leases.set(token, {item, deadline: Date.now() + timeoutMs});
    return token;
  }

  /**
   * Push a lease's deadline out by `timeoutMs` from now, reporting whether the
   * lease was still held. This is what a heartbeat buys: an attempt that keeps
   * proving it is alive keeps its claim, so elapsed time alone stops being
   * evidence that a worker died.
   *
   * An expired token renews nothing and returns false — the task has already
   * gone to someone else, and quietly reviving it here would hand the same work
   * to two workers.
   */
  renew(token: string, timeoutMs: number): boolean {
    const lease = this.leases.get(token);
    if (!lease) return false;
    lease.deadline = Date.now() + timeoutMs;
    return true;
  }

  /** Release a lease, returning its item — or undefined if the lease already expired. */
  ack(token: string): T | undefined {
    const lease = this.leases.get(token);
    if (!lease) return undefined;
    this.leases.delete(token);
    return lease.item;
  }

  /** Remove and return the items whose leases have expired (for redelivery). */
  reclaimExpired(now = Date.now()): T[] {
    const expired: T[] = [];
    for (const [token, lease] of this.leases) {
      if (lease.deadline <= now) {
        expired.push(lease.item);
        this.leases.delete(token);
      }
    }
    return expired;
  }
}

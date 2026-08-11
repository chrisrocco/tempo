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
  private readonly leases = new Map<
    string,
    {item: T; deadline: number; holder?: string}
  >();
  private counter = 0;

  constructor(private readonly prefix: string) {}

  /**
   * Lease an item for `timeoutMs`, returning its token.
   *
   * `holder` is the identity of the worker taking it, and is what turns this
   * table into an answer to "is that worker busy or gone?" — see `holders`.
   * Optional because a caller that does not identify itself still gets a lease;
   * the lease is what protects the task, and the identity only explains it.
   */
  lease(item: T, timeoutMs: number, holder?: string): string {
    const token = `${this.prefix}-${++this.counter}`;
    this.leases.set(token, {
      item,
      deadline: Date.now() + timeoutMs,
      ...(holder === undefined ? {} : {holder}),
    });
    return token;
  }

  /**
   * The identities currently holding a live lease.
   *
   * The point of recording the holder at all. A worker running one activity
   * stops polling for as long as it takes — the loop is sequential — so elapsed
   * silence cannot distinguish it from a worker that died. Holding a lease is
   * the positive evidence that closes that gap: silent *and* holding something
   * is busy, silent and holding nothing is gone.
   *
   * Filters by deadline rather than trusting the map, because expired leases are
   * only swept on the next poll: on an idle queue nothing polls, so a dead
   * worker's lease would otherwise keep vouching for it indefinitely.
   */
  holders(now = Date.now()): Set<string> {
    const held = new Set<string>();
    for (const lease of this.leases.values())
      if (lease.holder !== undefined && lease.deadline > now)
        held.add(lease.holder);
    return held;
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

  /**
   * The items whose leases have lapsed, **without** reclaiming them.
   *
   * The read-only counterpart to `reclaimExpired`, and it exists for the same
   * reason `holders` filters by deadline rather than trusting the map: expired
   * leases are only swept on the next poll, so on a queue nothing is polling
   * they sit indefinitely. To `holders` that would mean a dead worker vouching
   * for itself forever; to a backlog count it means work that is waiting to be
   * redelivered reading as work in progress — on exactly the queue where nobody
   * is coming to sweep it.
   *
   * Separate from `reclaimExpired` because a caller answering a question must
   * not have the side effect of a caller doing work: counting the backlog cannot
   * be the thing that redelivers a task.
   */
  expired(now = Date.now()): T[] {
    const lapsed: T[] = [];
    for (const lease of this.leases.values())
      if (lease.deadline <= now) lapsed.push(lease.item);
    return lapsed;
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

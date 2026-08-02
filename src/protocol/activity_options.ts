/**
 * @fileoverview
 * Per-activity options: shared vocabulary that rides on `ScheduleActivityCommand`.
 * Declared here in `protocol` because it is part of the wire format, but the core
 * only *emits* it — it is **interpreted only by the server** when a command is
 * turned into activity work (retry decisions, later timeouts/task-queue routing).
 * Declared in one layer and enforced in another, each touching it only as much as
 * the determinism boundary allows.
 */

export interface RetryPolicy {
  /**
   * Total attempts including the first. Defaults to 1 (no retry), so an activity
   * without an explicit policy fails on its first error. Set > 1 to opt in.
   *
   * Enforced by the **server**, which counts attempts on the execution record —
   * so the budget is the same however the engine is hosted, and survives a worker
   * dying mid-backoff or a server restart. It used to be applied by whichever
   * loop happened to be running the activity, which meant local mode honoured it
   * and distributed mode silently ignored it.
   */
  maximumAttempts?: number;
  /** Delay before the second attempt. Grows by `backoffCoefficient` each retry. */
  initialIntervalMs?: number;
  /** Multiplier applied to the interval per retry. Defaults to 2. */
  backoffCoefficient?: number;
  /** Upper bound on the retry interval. */
  maximumIntervalMs?: number;
}

export interface ActivityOptions {
  retry?: RetryPolicy;
  /**
   * How long a single attempt may run before the server gives up on it, measured
   * from when a worker polls the task. Unset means unbounded.
   *
   * Setting it changes what happens when an attempt overruns, and that is the
   * whole point. **Unset**, the lease eventually expires and the task is
   * redelivered — so a slow activity ends up running *concurrently* with the
   * attempt already in flight, once per lease period. **Set**, the server fails
   * the attempt at the deadline and stops redelivering it, so the workflow sees a
   * timeout instead of the engine quietly running the work twice.
   *
   * It does not stop the worker. Nothing here can — there is no heartbeat, so the
   * server cannot tell a slow worker from a dead one, and cannot reach into one
   * that is still going. The guarantee is about what the *engine* does: one
   * attempt is dispatched, one outcome is recorded.
   *
   * Must be shorter than the server's `ACTIVITY_LEASE_MS`, or the lease expires
   * first and redelivers before this deadline is reached.
   */
  startToCloseTimeoutMs?: number;
  /**
   * How long the server will tolerate *silence* from an attempt that is
   * heartbeating. Unset means it will not expect one.
   *
   * This is the other half of `startToCloseTimeoutMs`, and they bound different
   * things. Start-to-close bounds how long an attempt may take; a heartbeat
   * timeout bounds how long it may go without saying anything. A long, honest
   * activity — an agent that thinks for ten minutes — wants a generous
   * start-to-close (or none) and a short heartbeat timeout: it keeps its claim
   * for as long as it is demonstrably working, and is given up on within seconds
   * of its worker dying.
   *
   * Each heartbeat also renews the task's lease, which is what stops the queue
   * redelivering long work to a second worker. Without heartbeats that
   * redelivery is the only outcome for anything slower than
   * `ACTIVITY_LEASE_MS` — see `worker/activity_worker`.
   */
  heartbeatTimeoutMs?: number;
  // taskQueue — later phases.
}

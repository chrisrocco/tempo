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
   * Total attempts including the first. Defaults to 1 (no retry) in the in-memory
   * server, so an activity without an explicit policy fails on first error — the
   * pre-Phase-3 behavior. Set > 1 to opt into retries.
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
  // heartbeatTimeoutMs, taskQueue — later phases.
}

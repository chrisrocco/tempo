// Per-activity options: shared vocabulary that rides on `ScheduleActivityCommand`.
// Declared here in `protocol` because it is part of the wire format, but the core
// only *emits* it — it is **interpreted only by the server** when a command is
// turned into activity work (retry decisions, later timeouts/task-queue routing).
// See docs/concepts/type-model.md and docs/architecture/distribution.md.

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
  // startToCloseTimeoutMs, heartbeatTimeoutMs, taskQueue — later phases.
}

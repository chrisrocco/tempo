/**
 * @fileoverview
 * Per-activity options: shared vocabulary that rides on `ScheduleActivityCommand`.
 * Declared here in `protocol` because it is part of the wire format, but the core
 * only *emits* it — it is **interpreted only by the server** when a command is
 * turned into activity work (retry decisions, later timeouts/task-queue routing).
 * Declared in one layer and enforced in another, each touching it only as much as
 * the determinism boundary allows.
 *
 * This is the wire truth, in milliseconds with `…Ms` names. The author-facing
 * spelling of the same options — `Duration` fields like `'5 minutes'` — is
 * `ActivityOptionsInput` in `core/activity_options_input.ts`, kept out of here
 * so `protocol/` stays free of the `walltime/` library it would otherwise have
 * to import. A field added here must be added there; its fileoverview says why
 * the pairing is split.
 */

export interface RetryPolicy {
  /**
   * Total attempts including the first. Defaults to 1 (no retry), so an activity
   * without an explicit policy fails on its first error. Set > 1 to opt in.
   *
   * Enforced by the **server**, which counts attempts on the execution record —
   * so the budget is the same however the engine is hosted, and survives a worker
   * dying mid-backoff or a server restart. Applied instead by whichever loop
   * happens to be running the activity, the budget would be a property of the
   * host rather than of the policy: local mode honours it, distributed mode
   * silently ignores it.
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
   * from when a worker polls the task.
   *
   * **Unset does not mean unbounded.** An activity that configures no deadline
   * at all — neither this field nor `heartbeatTimeoutMs` — is given the
   * server's default (`DEFAULT_START_TO_CLOSE_MS`, 10 minutes), because a
   * deadline-less activity whose worker dies silently parks its workflow
   * forever with an operator reset as the only way out. The default is the
   * server's policy, applied at dispatch and configurable per server
   * (`defaultStartToCloseTimeoutMs`); the error it produces says it was the
   * default. To genuinely run without a ceiling, opt out explicitly with `0` —
   * or heartbeat, which is the better contract for long work: the attempt
   * keeps its claim for as long as it is demonstrably alive.
   *
   * Setting a value changes what happens when an attempt overruns, and that is
   * the whole point: the server fails the attempt at the deadline and stops
   * waiting, so the workflow sees a timeout instead of the engine quietly
   * running the work twice.
   *
   * It does not stop the worker. Nothing here can — there is no heartbeat, so the
   * server cannot tell a slow worker from a dead one, and cannot reach into one
   * that is still going. The guarantee is about what the *engine* does: one
   * attempt is dispatched, one outcome is recorded.
   *
   * Keep it shorter than the server's `ACTIVITY_LEASE_MS` when you can: a
   * deadline longer than the lease still decides the outcome (its failure
   * settles the seq, and stale redeliveries are dropped at poll), but every
   * lease period until it fires redelivers the attempt into a concurrent run.
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
  /**
   * Which pool of workers may run this activity. Defaults to the queue its
   * *execution* is running on — so an app's activities land on the app's own
   * workers without anyone saying so, and only a step with different needs (a
   * GPU, a particular network) has to name a queue.
   *
   * A queue name is a contract: every worker polling it must register the same
   * activities. A worker that receives work it cannot serve fails the attempt,
   * which is a routing bug wearing a retry's clothes.
   */
  taskQueue?: string;
}

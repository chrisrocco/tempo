/**
 * @fileoverview
 * Per-activity options: shared vocabulary that rides on `ScheduleActivityCommand`.
 * Declared here in `protocol` because it is part of the wire format, but the core
 * only *emits* it — it is **interpreted only by the server** when a command is
 * turned into activity work (retry decisions, later timeouts/task-queue routing).
 * Declared in one layer and enforced in another, each touching it only as much as
 * the determinism boundary allows.
 *
 * Two shapes on purpose: `ActivityOptions` is the wire truth, in milliseconds
 * with `…Ms` names; `ActivityOptionsInput` is the same options as an author
 * writes them, with `Duration` fields (`'5 minutes'`). They live side by side so
 * a field added to one is visibly missing from the other, and
 * `normalizeActivityOptions` is the only crossing between them —
 * `proxyActivities` calls it once, at declaration, so a typo in a duration fails
 * at module load rather than mid-replay, and nothing downstream of the author
 * surface ever sees a string.
 */

import {durationToMs, type Duration} from './duration';

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

/** `RetryPolicy` as an author writes it — see `ActivityOptionsInput`. */
export interface RetryPolicyInput {
  maximumAttempts?: number;
  backoffCoefficient?: number;
  /** `initialIntervalMs`, as a `Duration`. Set one or the other, not both. */
  initialInterval?: Duration;
  initialIntervalMs?: number;
  /** `maximumIntervalMs`, as a `Duration`. Set one or the other, not both. */
  maximumInterval?: Duration;
  maximumIntervalMs?: number;
}

/**
 * What `proxyActivities` accepts: every `ActivityOptions` field, plus a
 * `Duration`-typed spelling of each timing field (`startToCloseTimeout: '5
 * minutes'`). The `…Ms` names stay valid so existing declarations keep
 * compiling; writing both spellings of one field is refused rather than
 * tie-broken, because whichever silently won, the loser reads as the truth.
 */
export interface ActivityOptionsInput {
  retry?: RetryPolicyInput;
  /** `startToCloseTimeoutMs`, as a `Duration`. Set one or the other, not both. */
  startToCloseTimeout?: Duration;
  startToCloseTimeoutMs?: number;
  /** `heartbeatTimeoutMs`, as a `Duration`. Set one or the other, not both. */
  heartbeatTimeout?: Duration;
  heartbeatTimeoutMs?: number;
  taskQueue?: string;
}

/**
 * One timing field, whichever spelling it arrived in, as milliseconds — or
 * undefined when neither was given. Both at once is the caller contradicting
 * themselves, so it throws with both names in the message.
 */
function pickMs(
  name: string,
  duration: Duration | undefined,
  msName: string,
  ms: number | undefined,
): number | undefined {
  if (duration !== undefined && ms !== undefined)
    throw new Error(
      `set ${name} or ${msName}, not both — they are the same field in two spellings`,
    );
  return duration === undefined ? ms : durationToMs(duration);
}

/** Only defined fields, so a normalized object round-trips like a hand-written one. */
function defined<T extends object>(fields: T): T {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as T;
}

/** Author-shape options as wire-shape options. The only crossing — see the fileoverview. */
export function normalizeActivityOptions(
  input: ActivityOptionsInput,
): ActivityOptions {
  const {retry} = input;
  return defined({
    retry:
      retry === undefined
        ? undefined
        : defined({
            maximumAttempts: retry.maximumAttempts,
            backoffCoefficient: retry.backoffCoefficient,
            initialIntervalMs: pickMs(
              'initialInterval',
              retry.initialInterval,
              'initialIntervalMs',
              retry.initialIntervalMs,
            ),
            maximumIntervalMs: pickMs(
              'maximumInterval',
              retry.maximumInterval,
              'maximumIntervalMs',
              retry.maximumIntervalMs,
            ),
          }),
    startToCloseTimeoutMs: pickMs(
      'startToCloseTimeout',
      input.startToCloseTimeout,
      'startToCloseTimeoutMs',
      input.startToCloseTimeoutMs,
    ),
    heartbeatTimeoutMs: pickMs(
      'heartbeatTimeout',
      input.heartbeatTimeout,
      'heartbeatTimeoutMs',
      input.heartbeatTimeoutMs,
    ),
    taskQueue: input.taskQueue,
  });
}

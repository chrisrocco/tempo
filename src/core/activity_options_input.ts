/**
 * @fileoverview
 * Activity options as an author writes them: `ActivityOptions` with a `Duration`
 * spelling of every timing field (`startToCloseTimeout: '5 minutes'`), and
 * `normalizeActivityOptions`, the one crossing to the wire's `…Ms` numbers.
 * `proxyActivities` calls it once, at declaration, so a typo in a duration fails
 * at module load — loudly, in the worker that would have run it — never
 * mid-replay, and nothing downstream of the author surface ever sees a string.
 *
 * ## Why this is not beside `ActivityOptions` in `protocol/`
 *
 * It was, briefly. But the `Duration` type is `timespec/`'s — an internally-owned
 * library the engine deliberately treats as a third-party dependency — and
 * `protocol/` imports nothing, which is worth more than the adjacency: protocol
 * is the vocabulary other repos read, and a library we might remove has no
 * business in its import graph. So the input shape lives here in `core/`, the
 * layer that already owns the author-facing primitives, and the price is
 * remembering that a timing field added to `ActivityOptions` must be added here
 * too — its fileoverview points back.
 */

import type {ActivityOptions} from '../protocol';
import {durationToMs, type Duration} from '../timespec';

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

/**
 * @fileoverview
 * What an activity can reach while it runs. Today that is one thing: `heartbeat`,
 * the way a long attempt tells the server it is still alive.
 *
 * Carried through `AsyncLocalStorage` rather than passed as an argument, for the
 * same reason the workflow context is (see `core/context`): an activity stays an
 * ordinary function of its own arguments. `greet(name)` does not become
 * `greet(ctx, name)` because the engine gained a feature, and an activity that
 * never heartbeats needs to know none of this exists.
 *
 * **Heartbeats are explicit, never automatic.** A timer in the worker that beat
 * on the activity's behalf would keep beating while the activity was wedged — it
 * would report that the *process* is alive, which the lease already implies. The
 * signal is only worth anything if it means the work itself is progressing, so it
 * has to come from the work.
 *
 * Calls are **throttled** here rather than at the server: an agent looping over
 * a hundred documents will call this a hundred times, and the server only needs
 * to hear often enough to keep the deadline from firing.
 */

import {AsyncLocalStorage} from 'node:async_hooks';

/** The ambient state of the activity attempt currently running on this stack. */
interface ActivityContext {
  /** Send a heartbeat now, subject to throttling. */
  beat(): void;
}

const als = new AsyncLocalStorage<ActivityContext>();

/**
 * Fraction of the heartbeat timeout to wait between sends. Two beats per timeout
 * window: frequent enough that one dropped call does not trip the deadline, rare
 * enough that a chatty activity is not a load source.
 */
const THROTTLE_FRACTION = 0.5;
/** Used when the activity heartbeats but declared no timeout to be judged against. */
const DEFAULT_THROTTLE_MS = 5_000;

/**
 * Report that this activity is still working.
 *
 * Safe to call as often as is convenient — sends are throttled, so a loop body
 * is a fine place for it. Outside an activity it does nothing rather than
 * throwing: an activity function should stay callable directly from a unit test
 * without a running engine.
 */
export function heartbeat(): void {
  als.getStore()?.beat();
}

/**
 * Run `fn` with `heartbeat()` wired to `send`, throttled against `timeoutMs`.
 * Used by the activity worker; activity authors only ever see `heartbeat`.
 */
export function withActivityContext<T>(
  send: () => void,
  timeoutMs: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const interval =
    timeoutMs !== undefined && timeoutMs > 0
      ? timeoutMs * THROTTLE_FRACTION
      : DEFAULT_THROTTLE_MS;
  let lastSentAt = 0;
  const beat = (): void => {
    const now = Date.now();
    if (now - lastSentAt < interval) return;
    lastSentAt = now;
    send();
  };
  return als.run({beat}, fn);
}

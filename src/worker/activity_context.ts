/**
 * @fileoverview
 * What an activity can reach while it runs. Today that is one thing: `heartbeat`,
 * the way a long attempt tells the server it is still alive and, optionally,
 * where it has got to.
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
 * to hear often enough to keep the deadline from firing. Beats inside the window
 * are dropped rather than buffered, which is safe only because of the contract on
 * `heartbeat` below: losing a subset of complete checkpoints costs precision,
 * never correctness.
 *
 * Three shapes were rejected once beats could carry a payload:
 *
 * - **Coalescing** — buffer the latest, flush on a trailing edge. Bounds
 *   staleness by the interval rather than by the caller's next call, which
 *   differs only after a burst then a long gap — where the value left behind is
 *   still a valid checkpoint, merely older. `PendingActivityView.checkpointAt`
 *   answers the same complaint with a field rather than a timer.
 * - **No throttle**, as a documented sharp edge. Adds a failure mode and removes
 *   none: beating too rarely still times out, while beating per row opens
 *   unbounded fire-and-forget requests (`worker/worker_loops` voids them and
 *   swallows their errors) and exhausts sockets before the server notices.
 * - **A debounce** — a different function, and a bug here. It fires after a quiet
 *   period, so an activity beating in a tight loop never sends and is abandoned
 *   for silence while working hardest.
 */

import {AsyncLocalStorage} from 'node:async_hooks';

/** The ambient state of the activity attempt currently running on this stack. */
interface ActivityContext {
  /** Send a heartbeat now, subject to throttling. */
  beat(checkpoint?: unknown): void;
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
 * Report that this activity is still working, optionally with a checkpoint.
 *
 * Safe to call as often as is convenient — sends are throttled, so a loop body
 * is a fine place for it. Outside an activity it does nothing rather than
 * throwing: an activity function should stay callable directly from a unit test
 * without a running engine.
 *
 * **`checkpoint` must be complete every time, never a delta.** It lands in one
 * slot that the next beat overwrites (`PendingActivityView.checkpoint`), and only
 * a sample of beats is sent, so whichever survives has to stand alone —
 * everything the next attempt would need to resume, in every call:
 *
 * ```ts
 * const jobId = await sql.submit(query);
 * while (true) {
 *   const s = await sql.status(jobId);
 *   heartbeat({jobId, pct: s.percentComplete}); // jobId every time, not once
 *   if (s.done) return s.resultRef;
 *   await sleep(30_000);
 * }
 * ```
 *
 * Reporting `{jobId}` once and `{pct}` thereafter loses the handle at the first
 * overwrite, and with it the retry's only way to re-attach to a query already
 * running.
 */
export function heartbeat(checkpoint?: unknown): void {
  als.getStore()?.beat(checkpoint);
}

/**
 * Run `fn` with `heartbeat()` wired to `send`, throttled against `timeoutMs`.
 * Used by the activity worker; activity authors only ever see `heartbeat`.
 */
export function withActivityContext<T>(
  send: (checkpoint?: unknown) => void,
  timeoutMs: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const interval =
    timeoutMs !== undefined && timeoutMs > 0
      ? timeoutMs * THROTTLE_FRACTION
      : DEFAULT_THROTTLE_MS;
  let lastSentAt = 0;
  const beat = (checkpoint?: unknown): void => {
    const now = Date.now();
    if (now - lastSentAt < interval) return;
    lastSentAt = now;
    send(checkpoint);
  };
  return als.run({beat}, fn);
}

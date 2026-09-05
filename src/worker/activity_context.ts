/**
 * @fileoverview
 * What an activity can reach while it runs: `heartbeat`, the way a long attempt
 * tells the server it is still alive and, optionally, where it has got to; and
 * `cancellationRequested` / `cancellationSignal`, the way it hears back that
 * nobody wants the result.
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
 *   reports their failures out of band) and exhausts sockets before the server
 *   notices.
 * - **A debounce** — a different function, and a bug here. It fires after a quiet
 *   period, so an activity beating in a tight loop never sends and is abandoned
 *   for silence while working hardest.
 *
 * ## Cancellation rides the heartbeat, and only the heartbeat
 *
 * The server cannot reach into a running attempt; it can only answer when the
 * attempt speaks, and the heartbeat is the attempt speaking. So the reply to a
 * beat carries `cancelRequested`, and this module turns it into two things an
 * activity can consult: a boolean, and an `AbortSignal` for anything that takes
 * one. The consequence is the honest one — **an activity that never heartbeats
 * never learns it was cancelled**, and one that heartbeats under a throttle learns
 * within one throttle window. An agent that sets `heartbeatTimeoutMs` gets both
 * liveness and cancellation at the same cadence, which is the point of pairing
 * them: an author already arranging to be heard is the author who wants to hear.
 *
 * Both reads are inert outside an activity, as `heartbeat` is: never cancelled,
 * never aborted, so an activity stays callable from a test with no engine.
 */

import {AsyncLocalStorage} from 'node:async_hooks';
import type {HeartbeatReply} from '../protocol';

/** The ambient state of the activity attempt currently running on this stack. */
interface ActivityContext {
  /** Send a heartbeat now, subject to throttling. */
  beat(checkpoint?: unknown): void;
  /** Set once a heartbeat reply said the execution was cancelled. Never unset. */
  cancelRequested: boolean;
  /** Aborted at the same moment `cancelRequested` is set. */
  controller: AbortController;
}

const als = new AsyncLocalStorage<ActivityContext>();

/**
 * Fraction of the heartbeat timeout to wait between sends. Five beats per
 * timeout window at a steady cadence: often enough that several consecutive
 * sends can be lost without the deadline firing, rare enough that a chatty
 * activity is not a load source.
 *
 * **The margin covers this throttle's own quantization, not only lost beats.**
 * A beat inside the window is dropped rather than deferred, so the spacing
 * between the sends that actually leave is the caller's cadence rounded up to a
 * multiple of this window — which reaches *twice* the interval for an activity
 * beating just faster than the window reopens. One beating every 0.49 of its
 * timeout sends, drops the next, and sends again 0.98 of the timeout later,
 * with nothing lost by the network at all. So the fraction has to leave the
 * deadline clear at twice its value: a fifth doubles to 0.4 of the timeout,
 * where a half doubles onto the deadline itself and reaps activities that are
 * heartbeating exactly as asked.
 *
 * The cost sits on the other side and is worth naming. The server's deadline
 * fires a full timeout after the last beat it accepted, so a tighter cadence
 * leaves a fresher clock behind when an activity really does die, and reaping
 * it takes nearer the whole timeout rather than whatever remained of it. That
 * number is the one the author asked for; paying it is the point of setting it.
 *
 * Deliberately measured against the *timeout* and nothing else. The worker does
 * not know the server's activity lease and must not have to: a timeout longer
 * than twice that lease would otherwise leave gaps between beats that no lease
 * survives, which is a coupling this side cannot see and could only guess at.
 * The server resolves it instead, by holding a heartbeating attempt's lease
 * past its deadline — `HEARTBEAT_LEASE_FACTOR` in `server/server_core`.
 */
const THROTTLE_FRACTION = 0.2;
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
 * Has the server stopped wanting this attempt's result?
 *
 * True once a heartbeat reply has said so, and only then — this reads what the
 * attempt has heard, it does not ask. It says so when the execution was
 * cancelled, and equally when the server gave up on this attempt for another
 * reason (a deadline, or the seq settling through a redelivered sibling); see
 * `HeartbeatReply` for why one flag covers both. Check it after a `heartbeat()`
 * in the loop that does the work, and stop when it answers: nothing reported
 * from here on is consumed, and the server will not retry. An `AbortError`
 * escaping from a `fetch` is a perfectly good way out.
 *
 * Outside an activity, always false.
 */
export function cancellationRequested(): boolean {
  return als.getStore()?.cancelRequested ?? false;
}

/**
 * An `AbortSignal` that fires when the execution is cancelled, for anything that
 * takes one — `fetch`, an SDK client, a child process. The same fact as
 * `cancellationRequested`, in the shape a library expects; it aborts at the
 * moment the boolean flips, and learns of the cancellation the same way, on a
 * heartbeat reply.
 *
 * Outside an activity, a signal that never aborts.
 */
export function cancellationSignal(): AbortSignal {
  return (als.getStore()?.controller ?? new AbortController()).signal;
}

/**
 * Run `fn` with `heartbeat()` wired to `send`, throttled against `timeoutMs`,
 * and with what `send` resolves to feeding `cancellationRequested()`. Used by the
 * activity worker; activity authors only ever see the exports above.
 *
 * `send` may return nothing (a test with nowhere to send) or a promise of a reply
 * that may be `undefined` (a beat that failed to reach the server, which says
 * nothing either way). Only a reply that says `cancelRequested` changes anything,
 * and it changes it once: cancellation does not un-happen. The activity is never
 * blocked on the reply — the beat returns at once and the answer lands whenever
 * it lands.
 */
export function withActivityContext<T>(
  send: (checkpoint?: unknown) => Promise<HeartbeatReply | undefined> | void,
  timeoutMs: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const interval =
    timeoutMs !== undefined && timeoutMs > 0
      ? timeoutMs * THROTTLE_FRACTION
      : DEFAULT_THROTTLE_MS;
  let lastSentAt = 0;
  const ctx: ActivityContext = {
    beat,
    cancelRequested: false,
    controller: new AbortController(),
  };
  function beat(checkpoint?: unknown): void {
    const now = Date.now();
    if (now - lastSentAt < interval) return;
    lastSentAt = now;
    const reply = send(checkpoint);
    if (!reply) return;
    void reply.then(
      (r) => {
        if (!r?.cancelRequested || ctx.cancelRequested) return;
        ctx.cancelRequested = true;
        ctx.controller.abort();
      },
      // A reply that never came is a beat that never landed; the next one asks
      // again. Nothing to do here, and nothing that should surface as a rejection.
      () => {},
    );
  }
  return als.run(ctx, fn);
}

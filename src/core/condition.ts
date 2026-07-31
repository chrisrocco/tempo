/**
 * @fileoverview
 * `condition(fn)` parks the caller until `fn()` becomes true. It is checked
 * eagerly on the way in, then re-evaluated by `tryUnblockConditions` after every
 * microtask drain until it holds. `condSeq` ids these blocks WITHOUT touching the
 * command `seq` counter, so a condition never perturbs command numbering.
 *
 * It is event-driven, not polling: there is no timer and no busy-wait. `condition`
 * never re-checks `fn` itself — the unblock pass does, after an activation's
 * events are applied. The essential line is the registration into
 * `blockedConditions`; the eager check is only a fast path. A false predicate
 * therefore stays parked until *something wakes the workflow*: a condition cannot
 * spontaneously become true, it can only flip as a side effect of an activation
 * (a signal, a completion) that runs the unblock pass. If nothing ever arrives it
 * waits forever — harmlessly, since a parked workflow accrues no history and
 * consumes no resources.
 *
 * ## Why not just await a never-resolving promise?
 *
 * Because a signal does not *wake* an await — it only runs a handler. Something
 * has to bridge "the handler mutated state" to "the parked promise resolves", and
 * that bridge is the `blockedConditions` registry plus the unblock pass.
 * `condition` is the general, replay-safe form of that wiring. You can hand-roll
 * it for a single signal by capturing a `resolve` inside the handler, but that is
 * just a single-use `condition`.
 *
 * A parked condition also rejects with CancelledFailure if the run is cancelled
 * (see apply_event); and calling `condition` after cancellation rejects at once.
 */

import { getContext, type WorkflowContext } from './context';
import { CancelledFailure } from './errors';

export function condition(fn: () => boolean): Promise<void> {
  const ctx = getContext();
  return new Promise<void>((resolve, reject) => {
    if (ctx.cancelled) {
      reject(new CancelledFailure());
      return;
    }
    if (fn()) {
      resolve();
      return;
    } // eager fast-path
    const seq = ctx.condSeq++;
    ctx.blockedConditions.set(seq, { fn, resolve, reject });
  });
}

// One pass over the parked conditions: resolve every one whose predicate now
// holds. Returns whether any progress was made, so `settle` can loop to a fixpoint.
export function tryUnblockConditions(ctx: WorkflowContext): boolean {
  let progressed = false;
  for (const [seq, cond] of [...ctx.blockedConditions]) {
    if (cond.fn()) {
      ctx.blockedConditions.delete(seq);
      cond.resolve();
      progressed = true;
    }
  }
  return progressed;
}

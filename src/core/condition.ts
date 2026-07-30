/**
 * @fileoverview
 * `condition(fn)` parks the caller until `fn()` becomes true. It is checked
 * eagerly on the way in, then re-evaluated by `tryUnblockConditions` after every
 * microtask drain until it holds. `condSeq` ids these blocks WITHOUT touching the
 * command `seq` counter, so a condition never perturbs command numbering. Doc 03.
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

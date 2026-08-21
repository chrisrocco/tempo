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

import {MAX_AWAITING_BYTES, type ParkedCondition} from '../protocol';
import {captureSite, siteFrames} from './call_site';
import {getContext, type WorkflowContext} from './context';
import {CancelledFailure} from './errors';

export interface ConditionOptions {
  /**
   * What this wait is for, as free-form JSON for whoever finds the execution
   * parked here. Surfaces on the live parked state (`Client.describe()`) and on
   * the `conditionParked` history event; the engine itself never reads it.
   *
   * Free-form is the design, not a gap: any convention a reader dispatches on —
   * `kind: 'approval'`, a signal name a dashboard offers to send — belongs to
   * the helper that declares it and the UI that honors it, so the engine stays
   * out of the vocabulary business. Must survive JSON, and must fit
   * `MAX_AWAITING_BYTES` — it is stored on every task the park survives.
   */
  awaiting?: unknown;
}

export function condition(
  fn: () => boolean,
  options?: ConditionOptions,
): Promise<void> {
  const ctx = getContext();
  return new Promise<void>((resolve, reject) => {
    if (ctx.cancelled) {
      reject(new CancelledFailure());
      return;
    }
    if (fn()) {
      resolve();
      return;
    } // eager fast-path — never captures, which is most calls on most replays
    const seq = ctx.condSeq++;
    // Captured cheaply, formatted only if still parked at task end — the cost
    // argument is `call_site.ts`'s.
    ctx.blockedConditions.set(seq, {
      fn,
      resolve,
      reject,
      site: captureSite(condition),
      awaiting: options?.awaiting,
    });
  });
}

/**
 * The conditions still parked, with their sites formatted.
 *
 * Called once, after a task's replay has settled, so the map holds exactly what
 * the workflow is waiting on right now — anything that unparked during the task
 * was deleted from it and is never formatted. That is what makes reading `.stack`
 * affordable: the price is paid per *outstanding* condition, not per call.
 *
 * The leading `Error` line is dropped; what is left is frames, innermost first.
 */
export function parkedConditions(ctx: WorkflowContext): ParkedCondition[] {
  const parked: ParkedCondition[] = [];
  for (const [seq, blocked] of ctx.blockedConditions) {
    const workflow = siteFrames(blocked.site);
    const site =
      workflow === undefined || workflow.length === 0
        ? undefined
        : workflow.join('\n');
    assertAwaitingFits(blocked.awaiting, site);
    parked.push({
      seq,
      ...(site === undefined ? {} : {site}),
      ...(blocked.awaiting === undefined ? {} : {awaiting: blocked.awaiting}),
    });
  }
  return parked;
}

/**
 * Refuse to report an `awaiting` that has outgrown the cap.
 *
 * Checked here rather than in `condition()` so the violation is a *task*
 * failure, like `assertCarryoverFits`: thrown after replay, it is retried and
 * surfaced rather than rejecting a promise workflow code might catch — so
 * shipping a fix and rolling the workers recovers the execution. The check also
 * inherits this function's cost profile for free: paid per condition still
 * parked at task end, never on the fast path and never for an `awaiting`-less
 * park.
 */
function assertAwaitingFits(awaiting: unknown, site: string | undefined): void {
  if (awaiting === undefined) return;
  const size = JSON.stringify(awaiting)?.length ?? 0;
  if (size <= MAX_AWAITING_BYTES) return;
  throw new Error(
    `awaiting on the condition at ${site?.split('\n')[0] ?? '<unknown site>'} ` +
      `is ${size} bytes, over the ${MAX_AWAITING_BYTES} limit. It is stored on ` +
      `every task the park survives and stamped into history, so it must stay ` +
      `a description — name what would release the wait, not the data it waits on.`,
  );
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

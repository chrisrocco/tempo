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

import type {ParkedCondition} from '../protocol';
import {getContext, type WorkflowContext} from './context';
import {CancelledFailure} from './errors';

/**
 * How many frames a park site keeps.
 *
 * The useful ones are the workflow's own, and they are at the top. Bounding the
 * capture is what keeps it cheap — the walk is proportional to this, and the
 * default of ten buys frames nobody reads.
 */
const SITE_FRAMES = 6;

/**
 * Where this `condition()` call is, captured as cheaply as it can be.
 *
 * An `Error` rather than a string, and this is the whole cost argument: V8
 * builds the formatted stack lazily, on first access to `.stack`. Capturing here
 * walks a bounded number of frames; the expensive serialization happens only for
 * conditions still parked when the task ends, which `parkedConditions` is the
 * only caller of.
 *
 * `captureStackTrace` with `condition` as the cutoff drops this function and
 * `condition` itself, so the top frame is the workflow's own call rather than
 * two frames of engine internals.
 */
function captureSite(): Error | undefined {
  const capture = Error.captureStackTrace;
  // V8 only. Everywhere else a parked condition is reported without a site,
  // which is the same shape as one captured before this existed.
  if (typeof capture !== 'function') return undefined;
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = SITE_FRAMES;
  const site = new Error();
  capture(site, condition);
  // Restored immediately, with no await in between, so nothing can observe the
  // narrowed limit.
  Error.stackTraceLimit = previousLimit;
  return site;
}

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
    } // eager fast-path — never captures, which is most calls on most replays
    const seq = ctx.condSeq++;
    ctx.blockedConditions.set(seq, {fn, resolve, reject, site: captureSite()});
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
    const frames = blocked.site?.stack
      ?.split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const workflow = frames === undefined ? undefined : workflowFrames(frames);
    parked.push({
      seq,
      ...(workflow === undefined || workflow.length === 0
        ? {}
        : {site: workflow.join('\n')}),
    });
  }
  return parked;
}

/**
 * Drop the engine frames below the workflow's own.
 *
 * `replay` is what invokes the workflow function, so everything from that frame
 * down is this engine's call stack rather than the reader's code. Six frames of
 * `AsyncLocalStorage.run` and `replayTask` around the one line that matters is
 * noise in a panel whose entire job is to point at that line.
 *
 * Matching on a file name is a heuristic, and it degrades the right way: if the
 * marker is ever missed, the reader gets more frames than they needed rather
 * than none. The first frame is never dropped — a site with nothing in it would
 * be worse than a site with engine frames in it.
 */
function workflowFrames(frames: string[]): string[] {
  const engine = frames.findIndex(
    (frame) => frame.includes('core/replay') || frame.includes('core\\replay'),
  );
  return engine > 0 ? frames.slice(0, engine) : frames;
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

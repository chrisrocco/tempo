/**
 * @fileoverview
 * `pollForever` — the monitor-workflow shape, as one call.
 *
 * A poller is the most common long-lived workflow and the easiest to get subtly
 * wrong, because three of its four requirements are invisible until production:
 *
 * 1. **Loop and wait.** The obvious part.
 * 2. **Do not act on the same item twice**, across restarts *and* across
 *    continue-as-new — which resets history, so any set the workflow was keeping
 *    is gone with it.
 * 3. **Bound history.** Every execution has a ceiling; a workflow that polls
 *    forever and never rolls over eventually cannot replay at all.
 * 4. **Carry your arguments across the rollover**, or the new run starts up
 *    monitoring nothing.
 *
 * The second one is where hand-written pollers usually end up with a `seen` set,
 * a cap on its size, and a bug about what happens when it overflows. None of
 * that is needed here: `startChild` with an explicit `workflowId` is a *claim* on
 * that id, and the server correlates a repeat claim to the existing execution
 * instead of starting a second (see `server_core`, `child.reused`). So dedupe is
 * the server's execution table — durable, and indifferent to rollovers and
 * restarts. The rule that falls out is the one thing a caller must get right:
 * **derive the child's id from the item**, not from a counter.
 *
 * What remains is 3 and 4, which this does on the caller's behalf: it rolls over
 * when the server suggests it, at the top of a cycle — a clean checkpoint, with
 * nothing dispatched and waiting — carrying `args` into the next run.
 */

import {sleep, startChild, continueAsNew, workflowInfo} from './workflow_api';

export interface PollForeverOptions<T> {
  /** How long to wait between cycles. */
  everyMs: number;
  /**
   * Find the current items. Normally an activity call — this runs inside
   * workflow code, so it must reach the outside world through one.
   */
  poll: () => Promise<readonly T[]>;
  /** The workflow to run per item. */
  child: string;
  /**
   * The child's execution id, derived from the item — a stable function of the
   * item's identity, like `bug-${bug.id}`.
   *
   * This *is* the deduplication: claiming an id that already exists correlates to
   * it rather than starting a second execution, so an item that shows up in ten
   * consecutive polls still gets exactly one child. Deriving it from anything
   * that varies per cycle (an index, a timestamp) silently turns every poll into
   * a fresh batch of children.
   */
  childId: (item: T) => string;
  /** The child's arguments. Defaults to the item itself. */
  childArgs?: (item: T) => unknown[];
  /**
   * The arguments to carry into the next run when history rolls over. Pass the
   * poller's own arguments; omitting them restarts it with none.
   */
  args?: unknown[];
}

/**
 * Poll for items and start one child per item, forever.
 *
 * Never returns. Cancelling the execution unwinds it through the `sleep` between
 * cycles, like any other workflow.
 */
export async function pollForever<T>(
  options: PollForeverOptions<T>,
): Promise<never> {
  while (true) {
    for (const item of await options.poll())
      startChild(options.child, {
        workflowId: options.childId(item),
        args: options.childArgs?.(item) ?? [item],
      });

    await sleep(options.everyMs);

    // Checked after the wait, not before it: at this point the cycle's children
    // are dispatched and nothing is parked, so the new run starts clean. The
    // server decides *when* — it is watching history length, which is the thing
    // the rollover exists to bound.
    if (workflowInfo().continueAsNewSuggested)
      await continueAsNew(...(options.args ?? []));
  }
}

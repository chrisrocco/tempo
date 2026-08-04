/**
 * @fileoverview
 * `pollForever` — poll a source on an interval and react to what changed.
 *
 * The loop owns the three things every poller needs and nothing else: waiting,
 * keeping history bounded, and making sure a change is reacted to **once**. What
 * counts as a change is a `Differ` (see `diff.ts`); what to do about it is a
 * callback. Neither is this file's business.
 *
 * ## Once, not once per cycle
 *
 * This is the whole difficulty, and it is worth being precise about.
 *
 * Differ state lives in carryover, and carryover reads are **per run**: every
 * task of a run sees what the run started with. That is a requirement, not a
 * limitation — a value that changed between tasks of one run would change the
 * commands the workflow issues on replay, and the execution would wedge on a
 * nondeterminism error (see `carryover.ts`).
 *
 * It does mean that a second cycle *within the same run* would diff against the
 * same state and report the same additions again. With `startChild` that was
 * harmless, because an explicit `workflowId` makes a repeat claim a no-op at the
 * server. An arbitrary callback has no such protection, so instead the loop
 * **continues as new as soon as the state changes**. A run therefore contains at
 * most one cycle that saw a change, and `onAdded` fires once per item.
 *
 * The rollover is not a cost. What history holds at that point is the record of
 * a batch already dispatched, and shedding it is the same act that adopts the
 * new state.
 */

import {getCarryover, setCarryover} from './carryover';
import type {Differ} from './diff';
import {sleep, continueAsNew, workflowInfo} from './workflow_api';

/**
 * Namespaced, because carryover is shared with whatever else the workflow keeps
 * there and a bare `state` is exactly the key someone else would pick.
 */
const STATE_KEY = 'pollForever.state';

export interface PollForeverOptions<T, S, Q> {
  /** How long to wait between cycles. */
  everyMs: number;
  /**
   * Find what is there now. Normally an activity call — this runs inside
   * workflow code, so it must reach the outside world through one.
   *
   * Receives whatever the differ's `query` produced, so a source that can filter
   * at the origin does not have to send everything it has.
   */
  poll: (query: Q) => Promise<readonly T[]>;
  /** What counts as new. See `byId` and `byCursor` in `diff.ts`. */
  differ: Differ<T, S, Q>;
  /**
   * React to an item the differ reports as new — by issuing a **command**:
   * `startChild`, `runActivity`, a signal.
   *
   * Read "once" precisely. This is ordinary workflow code, so it is *invoked* on
   * every replay pass, the same as every other line in the workflow; what
   * happens once is its **effect**, because a command already recorded in
   * history is suppressed on replay by its marker. That is the engine's rule,
   * not this helper's, and the consequence is the usual one: a plain side effect
   * here (appending to an array, writing a file) will repeat, and does not
   * belong in workflow code at all.
   *
   * What the loop guarantees on top of that is that an item is reported as added
   * exactly once across the poller's life, rather than on every cycle it remains
   * present.
   */
  onAdded: (item: T) => void;
  /**
   * React to something that has gone away, by key. Only `byId`-style differs
   * report removals; a stream has none.
   */
  onRemoved?: (key: string) => void;
  /**
   * The arguments to carry into the next run when history rolls over. Pass the
   * poller's own arguments; omitting them restarts it with none.
   */
  args?: unknown[];
}

/**
 * Compared by serialization: differ states are small, JSON-safe values, and this
 * avoids every differ having to supply an equality function for the loop's
 * benefit. `byId` sorts its ids so this comparison means what it looks like.
 */
function changed(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

/**
 * Poll forever, reacting to what changed.
 *
 * Never returns. Cancelling the execution unwinds it through the `sleep` between
 * cycles, like any other workflow.
 */
export async function pollForever<T, S, Q>(
  options: PollForeverOptions<T, S, Q>,
): Promise<never> {
  const {differ} = options;
  while (true) {
    const state = getCarryover<S>(STATE_KEY) ?? differ.initial;

    const {
      added,
      removed,
      state: next,
    } = differ.diff(state, await options.poll(differ.query(state)));
    for (const item of added) options.onAdded(item);
    if (options.onRemoved) for (const key of removed) options.onRemoved(key);

    // The wait comes before the rollover, not after it: it is what paces the
    // loop, and rolling over first would return here immediately and poll again.
    await sleep(options.everyMs);

    // Rolling over on a change is what makes `onAdded` fire once — the next
    // cycle has to start from the new state, and only a new run can see it.
    // The server's hint covers the other case: nothing is changing, but history
    // has grown enough from the polling itself to be worth shedding.
    if (changed(state, next)) {
      setCarryover(STATE_KEY, next);
      await continueAsNew(...(options.args ?? []));
    }
    if (workflowInfo().continueAsNewSuggested)
      await continueAsNew(...(options.args ?? []));
  }
}

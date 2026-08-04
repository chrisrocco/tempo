/**
 * @fileoverview
 * `pollForever` — the monitor-workflow shape, as one call.
 *
 * A poller is the most common long-lived workflow and the easiest to get subtly
 * wrong, because most of its requirements are invisible until it has been
 * running a while:
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
 * (2) is not this helper's doing: `startChild` with an explicit `workflowId` is a
 * *claim* on that id, and the server correlates a repeat claim to the existing
 * execution instead of starting a second (see `server_core`, `child.reused`). So
 * deduplication is the server's execution table — durable, and indifferent to
 * rollovers and restarts. The rule that falls out is the one thing a caller must
 * get right: **derive the child's id from the item**, not from a counter.
 *
 * ## Why a cursor is not just an optimization
 *
 * A repeat claim starts no child, but it still *costs a history event*: the
 * `childStarted` marker is written either way, because that marker is what stops
 * replay re-dispatching the claim. So a feed that keeps returning the same
 * hundred open items writes a hundred events every cycle, forever. History is
 * then bounded only by rolling over constantly, and each rollover rewrites the
 * record.
 *
 * `cursor` is what makes the steady state free. With one, the poller remembers
 * the highest key it has claimed and skips anything at or below it, so a cycle
 * that finds nothing new writes only the activity and timer events — a constant,
 * independent of how large the feed is.
 *
 * ## What this does not fix
 *
 * A child that **fails** keeps its id. Claiming it again correlates to the failed
 * execution, so the item is never retried and the poller goes on looking
 * healthy — see `childId` below for the ways out. This is the sharp edge of
 * id-based dedupe and it is worth knowing before it costs a day.
 */

import {getCarryover, setCarryover} from './carryover';
import {sleep, startChild, continueAsNew, workflowInfo} from './workflow_api';

/**
 * Namespaced, because carryover is shared with whatever else the workflow keeps
 * there and a bare `cursor` is exactly the key someone else would pick.
 */
const CURSOR_KEY = 'pollForever.cursor';

/** Orderable with `>`; a timestamp, a sortable id, an ISO string. */
export type CursorKey = number | string;

export interface PollForeverOptions<T, C extends CursorKey = CursorKey> {
  /** How long to wait between cycles. */
  everyMs: number;
  /**
   * Find the current items. Normally an activity call — this runs inside
   * workflow code, so it must reach the outside world through one.
   *
   * Receives the stored cursor when `cursor` is configured, so a source that can
   * filter at the origin (`modifiedSince`, a page token) does not have to send
   * everything it has. `undefined` on the first cycle, and always when `cursor`
   * is not configured.
   */
  poll: (since: C | undefined) => Promise<readonly T[]>;
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
   *
   * The corollary is that a **failed** child's id is spent: the item is never
   * processed again, and nothing surfaces that. If items must survive a failed
   * attempt, either put an attempt counter in the id, or — usually better — have
   * the child catch its own failure and settle as completed with the error as
   * data, so a human can see it.
   */
  childId: (item: T) => string;
  /** The child's arguments. Defaults to the item itself. */
  childArgs?: (item: T) => unknown[];
  /**
   * An ordered key per item — a modification time, a sequence number.
   *
   * Configuring this makes the steady state cost nothing: the poller stores the
   * highest key it has claimed and skips items at or below it, so a feed that
   * keeps returning the same items stops writing a history event per item per
   * cycle. The cursor lives in carryover, so it survives both rollovers and
   * restarts.
   *
   * It assumes the source never yields an item with a key *below* one it has
   * already yielded. If it can — an item edited with an old timestamp, a feed
   * without a total order — that item is skipped for good. Leave `cursor` unset
   * in that case and pay the per-item history; correctness first.
   */
  cursor?: (item: T) => C;
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
export async function pollForever<T, C extends CursorKey = CursorKey>(
  options: PollForeverOptions<T, C>,
): Promise<never> {
  while (true) {
    const since = options.cursor ? getCarryover<C>(CURSOR_KEY) : undefined;
    let highest = since;

    for (const item of await options.poll(since)) {
      if (options.cursor) {
        const key = options.cursor(item);
        // Already claimed on an earlier cycle: skipping it here is what keeps a
        // steady-state poll from writing a marker per item.
        if (since !== undefined && key <= since) continue;
        if (highest === undefined || key > highest) highest = key;
      }
      startChild(options.child, {
        workflowId: options.childId(item),
        args: options.childArgs?.(item) ?? [item],
      });
    }

    // After the claims, so a crash between the two re-polls the same items and
    // re-claims ids that already exist — which is a no-op — rather than
    // advancing past items whose children were never started.
    const advanced = highest !== undefined && highest !== since;
    if (advanced) setCarryover(CURSOR_KEY, highest!);

    await sleep(options.everyMs);

    // Two reasons to start a fresh run, checked after the wait — at that point
    // the cycle's children are dispatched and nothing is parked, so the new run
    // starts clean.
    //
    // The server's hint is the usual one: history has grown enough to be worth
    // shedding. `advanced` is the cursor's own, and it is not an optimization —
    // a carryover write only takes effect in the *next* run, so until this
    // rolls over, every cycle re-polls from the old cursor and re-claims the
    // same items, writing a marker each time. Rolling over is how the new cursor
    // is adopted, and it is free: what history holds at that point is a batch of
    // claims that are already durable as executions.
    if (advanced || workflowInfo().continueAsNewSuggested)
      await continueAsNew(...(options.args ?? []));
  }
}

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
 *
 * ## Where it starts
 *
 * By default the first cycle treats everything the source returns as new, which
 * is right for a feed that starts empty and wrong for one with a backlog. See
 * `PollStart` for the two alternatives — seeding from the first poll, and
 * resuming from a state you already hold.
 */

import {getCarryover, setCarryover} from '../core/carryover';
import type {Differ} from './diff';
import {sleep, continueAsNew, workflowInfo} from '../core/workflow_api';

/**
 * Namespaced, because carryover is shared with whatever else the workflow keeps
 * there and a bare `state` is exactly the key someone else would pick.
 */
const STATE_KEY = 'pollForever.state';

/**
 * Whether the baseline cycle has happened, for `startFrom: 'new'`.
 *
 * Its own key rather than inferring "first cycle" from an absent `STATE_KEY`.
 * The two are not the same question: a differ's state can legitimately be
 * absent-looking — `byCursor` starts at `undefined`, and `byId` cannot tell a
 * feed it has never polled from one it polled and found empty, since both are
 * `[]`. Deriving "have we seeded" from that would make the poller's behaviour
 * depend on an ambiguity in the differ's state.
 */
const SEEDED_KEY = 'pollForever.seeded';

/**
 * Where a poller starts, on the very first cycle of its very first run.
 *
 * - `'all'` — everything the source returns now is new. The default, and what
 *   the loop has always done.
 * - `'new'` — the first poll establishes the baseline and reports nothing;
 *   only what appears *after* that is new.
 * - `{state}` — resume from a differ state you already have: a saved cursor, a
 *   known id set, the state a previous poller left behind.
 *
 * One option rather than two, because the alternatives contradict. "Start from
 * cursor 1000" and "ignore the first batch" combined would silently drop the
 * items above 1000 — which are genuinely new — and there is no reading of the
 * two together that is obviously right. A union makes the contradiction
 * unexpressible instead of documented.
 */
export type PollStart<S> = 'all' | 'new' | {state: S};

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
   * `startChild`, `runActivity`, `signalWorkflow`.
   *
   * `signalWorkflow` is what makes the poller-in-a-child shape work: the cycles
   * land in this workflow's history, which it sheds by rolling over, and the
   * consumer pays one event per *item* rather than four per cycle. Reach the
   * consumer with `workflowInfo().parent`.
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
   * Where to start. Defaults to `'all'` — see `PollStart`.
   *
   * `'new'` is the one to reach for when the source already has a backlog. A
   * poller pointed at a hotlist with five hundred open bugs reports all five
   * hundred as added on its first cycle, and `onAdded` issues a *command* — so
   * that is five hundred children started for work nobody asked to have done.
   * Worse than noisy: a child that fails permanently burns its workflow id
   * (`startChild` dedupes against any existing record, including a failed one),
   * so the burst is not something a retry can undo.
   */
  startFrom?: PollStart<S>;
  /**
   * What the next run should be started with when history rolls over.
   *
   * Defaults to **this run's own arguments**, which is almost always right: a
   * poller rolls over to keep polling the same thing, so the next run wants the
   * parameters this one had. Set it only to deliberately change them.
   *
   * The default matters more than it looks. Rolling over with no arguments
   * restarts `monitorHotlist(hotlist)` as `monitorHotlist(undefined)` — the
   * workflow keeps running, the poll returns nothing or throws, and the failure
   * appears one rollover after the code that caused it.
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
 * The arguments the next run should get: the caller's override, else the ones
 * this run was given. Read through `workflowInfo` at the moment of the rollover
 * rather than captured once, so a run that was itself started by a rollover
 * passes on what it actually received.
 */
function carryArgs(options: {args?: unknown[]}): unknown[] {
  return options.args ?? workflowInfo().args;
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
  const startFrom: PollStart<S> = options.startFrom ?? 'all';
  const initial =
    typeof startFrom === 'object' ? startFrom.state : differ.initial;

  /**
   * Is *this* cycle the one that establishes the baseline?
   *
   * Run-local as well as carried, and both halves are load-bearing. The carried
   * flag is what stops a later run from seeding again. The local one is what
   * stops a later *cycle of this run* from doing it: a seeding cycle that finds
   * an empty feed changes no state, so there is no rollover, so nothing is
   * persisted — and without this the next cycle would read the same carryover,
   * conclude it is still seeding, and swallow the first items that ever appear.
   *
   * Deterministic under replay: it is derived from carryover, which is fixed for
   * the run, and from the loop's own iteration count.
   */
  let seeding =
    startFrom === 'new' && getCarryover<boolean>(SEEDED_KEY) !== true;

  while (true) {
    const state = getCarryover<S>(STATE_KEY) ?? initial;

    const {
      added,
      removed,
      state: next,
    } = differ.diff(state, await options.poll(differ.query(state)));

    // The differ still reports what it found — `added` means "not accounted for
    // by state", and that stays true. What `'new'` suppresses is the
    // *reaction*, which is the loop's business rather than the differ's.
    if (seeding) {
      setCarryover(SEEDED_KEY, true);
    } else {
      for (const item of added) options.onAdded(item);
      if (options.onRemoved) for (const key of removed) options.onRemoved(key);
    }
    seeding = false;

    // The wait comes before the rollover, not after it: it is what paces the
    // loop, and rolling over first would return here immediately and poll again.
    await sleep(options.everyMs);

    // Rolling over on a change is what makes `onAdded` fire once — the next
    // cycle has to start from the new state, and only a new run can see it.
    // The server's hint covers the other case: nothing is changing, but history
    // has grown enough from the polling itself to be worth shedding.
    if (changed(state, next)) {
      setCarryover(STATE_KEY, next);
      await continueAsNew(...carryArgs(options));
    }
    if (workflowInfo().continueAsNewSuggested)
      await continueAsNew(...carryArgs(options));
  }
}

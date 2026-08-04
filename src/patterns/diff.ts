/**
 * @fileoverview
 * "What changed since last time?" — the primitive a poller is built on.
 *
 * A polling workflow does two separable things: it asks a source what is there,
 * and it works out which of that is new. Only the second needs to remember
 * anything, and it is the part that is easy to get wrong. Splitting it out means
 * the loop can stay one shape while the remembering varies, and it means the two
 * strategies that actually come up can be named and tested on their own.
 *
 * A `Differ` is a fold: state in, items in, changes and new state out. It holds
 * no state itself — the poller keeps it in carryover — so it is a plain value,
 * usable outside a workflow and testable without one.
 *
 * ## The two that come up
 *
 * `byId` for **entities**: things with an identity that appear, persist, and go
 * away. A bug in a hotlist, a row matching a query. State is the set of ids
 * currently present, which is what makes removals expressible — you cannot know
 * something left without knowing it was there.
 *
 * `byCursor` for **streams**: an append-only sequence with an increasing key.
 * Events, log lines, anything `since`-able. State is one key, and removals are
 * not a thing a stream has.
 *
 * ## Why state must stay small
 *
 * It lives in carryover, which is copied into every run and capped
 * (`MAX_CARRYOVER_BYTES`). `byCursor` is O(1). `byId` is **O(items currently
 * present)** — not O(items ever seen), because an id drops out of the state when
 * its item leaves the feed. That bound is the difference between a poller that
 * runs for years and one that quietly fattens until it hits the cap; it is why
 * the state is the *current* id set rather than a log of everything processed.
 */

/** What one comparison found, plus the state to carry into the next one. */
export interface DiffResult<T, S> {
  /** Items present now that were not accounted for by `state`. */
  added: readonly T[];
  /**
   * Keys that `state` accounted for and are now gone. Keys rather than items,
   * because a differ cannot produce something the source no longer returns.
   */
  removed: readonly string[];
  /** What to compare against next time. */
  state: S;
}

/**
 * A fold over successive poll results.
 *
 * @typeParam T - the item type
 * @typeParam S - carried state; must survive JSON and stay small
 * @typeParam Q - what the source needs in order to filter at the origin
 */
export interface Differ<T, S, Q = undefined> {
  /** State for an execution that has never polled. */
  readonly initial: S;
  /**
   * What to hand the poll function, so a source that can filter does not have
   * to send everything it has. `undefined` when the source cannot help.
   */
  query(state: S): Q;
  /** Compare a poll result against the carried state. */
  diff(state: S, items: readonly T[]): DiffResult<T, S>;
}

/**
 * Track entities by identity: what appeared, what went away.
 *
 * State is the ids currently present, so it is bounded by how many things exist
 * at once rather than by how many have ever existed. The source is asked for
 * everything each time — an entity feed generally cannot answer "what changed" —
 * so this trades bandwidth for the ability to see removals.
 *
 * Ids must be stable for the life of the entity. An id derived from mutable
 * fields makes an edit look like a removal followed by an addition.
 */
export function byId<T>(idOf: (item: T) => string): Differ<T, string[]> {
  return {
    initial: [],
    query: () => undefined,
    diff(state, items) {
      const before = new Set(state);
      const now = items.map(idOf);
      const present = new Set(now);
      return {
        added: items.filter((item) => !before.has(idOf(item))),
        removed: state.filter((id) => !present.has(id)),
        // Sorted so the state has one representation: the poller decides whether
        // to roll over by comparing states, and an ordering that followed the
        // source's whim would look like a change on every cycle.
        state: [...present].sort(),
      };
    },
  };
}

/**
 * Follow a stream by an increasing key: everything above the high-water mark.
 *
 * State is one key, so this is O(1) forever, and the key can be handed to the
 * source as a `since` — the reason a stream poller can stay cheap no matter how
 * much has gone past.
 *
 * It assumes the source never yields a key below one it has already yielded. If
 * it can — an item back-dated by an edit, a feed with no total order — that item
 * is skipped permanently. Use `byId` where that is possible; correctness first.
 */
export function byCursor<T, C extends number | string>(
  keyOf: (item: T) => C,
): Differ<T, C | undefined, C | undefined> {
  return {
    initial: undefined,
    query: (state) => state,
    diff(state, items) {
      const added = items.filter(
        (item) => state === undefined || keyOf(item) > state,
      );
      let highest = state;
      for (const item of added) {
        const key = keyOf(item);
        if (highest === undefined || key > highest) highest = key;
      }
      return {added, removed: [], state: highest};
    },
  };
}

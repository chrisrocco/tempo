/**
 * @fileoverview
 * Collecting an execution's whole history, across the pages it arrives in.
 *
 * `describeExecution` returns at most `MAX_HISTORY_PAGE` events (500), so the
 * 600-event history that motivated the paging controls is also the one an export
 * would silently truncate. Downloading "the history" and getting the last 500
 * events under that name is worse than not offering the button: the file looks
 * complete, and the events that explain the beginning are the ones missing.
 *
 * DOM-free, and takes a reader rather than the client, so the suite covers the
 * loop without a browser (`spec/dashboard/history_export.spec.ts`) — the same
 * split as `routes.ts` / `router.ts`. Every case worth pinning down is a paging
 * case, and all of them are awkward to produce against a live server.
 *
 * ## Stopping
 *
 * The history of a *running* execution grows while it is being read, so
 * `historyLength` is a moving target and "read until you have that many" would
 * not reliably terminate. The loop advances by what each page actually returned
 * and stops when a page adds nothing, which terminates whether the history grew,
 * shrank, or stayed put.
 *
 * `MAX_PAGES` is the backstop against a server that answers with a full page
 * forever. Reaching it sets `truncated`, because a partial export that does not
 * announce itself is the exact failure this module exists to prevent.
 */

import type {HistoryEvent} from 'workflow-engine/protocol';

/**
 * One page of history, starting at `fromEvent`. `undefined` means the execution
 * is gone — deleted, or an id that never existed.
 */
export type HistoryPageReader = (fromEvent: number) => Promise<
  | {
      history: HistoryEvent[];
      historyLength: number;
    }
  | undefined
>;

/** The most pages one export reads before it gives up and returns what it has. */
export const MAX_PAGES = 200;

/** A whole history, and whether it is in fact whole. */
export interface CollectedHistory {
  events: HistoryEvent[];
  /** True when the read stopped at `MAX_PAGES` rather than at the end. */
  truncated: boolean;
}

/**
 * Read every page from the beginning and concatenate them.
 *
 * Starts at event 0 rather than at whatever page is on screen: the reason to
 * export is to have the whole thing, and the view's default page is the *last*
 * one.
 */
export async function collectHistory(
  read: HistoryPageReader,
): Promise<CollectedHistory> {
  const events: HistoryEvent[] = [];
  let next = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const detail = await read(next);
    if (detail === undefined) return {events, truncated: false};
    // An empty page is the end. It is also what a `fromEvent` past the end
    // returns, which is why this is the stopping condition rather than a
    // comparison against `historyLength` that a growing history invalidates.
    if (detail.history.length === 0) return {events, truncated: false};

    events.push(...detail.history);
    next += detail.history.length;
    if (next >= detail.historyLength) return {events, truncated: false};
  }

  return {events, truncated: true};
}

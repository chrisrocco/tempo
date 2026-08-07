/**
 * @fileoverview
 * That an exported history is the whole history, or says it is not.
 *
 * The cases are all paging cases: a history longer than one page, one that grew
 * while it was being read, and a server that never stops answering. Each of them
 * produces a plausible-looking file, so none of them would be noticed by opening
 * the download.
 */

import 'jasmine';
import type {HistoryEvent} from '../../src/protocol/history_events';
import {
  MAX_PAGES,
  collectHistory,
  type HistoryPageReader,
} from '../../dashboard/app/history_export';

/** A signal event, which is the cheapest history event to make in bulk. */
function event(n: number): HistoryEvent {
  return {type: 'signal', name: `s${n}`, payload: undefined, ts: 1_000 + n};
}

/** A reader over a fixed history, paging at `pageSize`. */
function reader(total: number, pageSize: number): HistoryPageReader {
  const all = Array.from({length: total}, (_, i) => event(i));
  return async (fromEvent) => ({
    history: all.slice(fromEvent, fromEvent + pageSize),
    historyLength: all.length,
  });
}

describe('dashboard history export — collecting every page', () => {
  it('returns a short history in one read', async () => {
    const collected = await collectHistory(reader(3, 500));
    expect(collected.events.length).toBe(3);
    expect(collected.truncated).toBeFalse();
  });

  it('concatenates a history longer than one page, in order', async () => {
    // The case the export exists for: 600 events at the server's 500-event cap.
    const collected = await collectHistory(reader(600, 500));
    expect(collected.events.length).toBe(600);
    expect(collected.truncated).toBeFalse();
    expect((collected.events[0] as {name: string}).name).toBe('s0');
    expect((collected.events[599] as {name: string}).name).toBe('s599');
  });

  it('starts at the beginning, not at the page the view happens to show', async () => {
    const seen: number[] = [];
    const pages = reader(600, 500);
    await collectHistory(async (fromEvent) => {
      seen.push(fromEvent);
      return pages(fromEvent);
    });
    expect(seen[0]).toBe(0);
  });

  it('reports an execution that is gone as an empty history, not an error', async () => {
    const collected = await collectHistory(async () => undefined);
    expect(collected.events).toEqual([]);
    expect(collected.truncated).toBeFalse();
  });

  it('terminates on a history that grew while it was being read', async () => {
    // `historyLength` keeps climbing, so a loop that read until it was reached
    // would never stop. Pages still run out, and that is what ends it.
    const all = Array.from({length: 30}, (_, i) => event(i));
    let claimed = 1_000;
    const collected = await collectHistory(async (fromEvent) => ({
      history: all.slice(fromEvent, fromEvent + 10),
      historyLength: (claimed += 500),
    }));
    expect(collected.events.length).toBe(30);
    expect(collected.truncated).toBeFalse();
  });

  it('stops and admits truncation when the pages never run out', async () => {
    // A server that answers every offset with a full page. Without the cap this
    // is an infinite loop; with it, the caller is told the file is partial.
    const collected = await collectHistory(async () => ({
      history: [event(0)],
      historyLength: Number.MAX_SAFE_INTEGER,
    }));
    expect(collected.truncated).toBeTrue();
    expect(collected.events.length).toBe(MAX_PAGES);
  });
});

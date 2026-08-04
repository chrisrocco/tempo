/**
 * @fileoverview
 * The two differs, as plain values — no workflow, no runtime.
 *
 * That they are testable this way is the point of splitting them out of the
 * poll loop: "what counts as new" is a fold over (state, items), and the awkward
 * parts of it — an item that persists, one that leaves and returns, a stream key
 * that goes backwards — are ordinary function calls to check rather than
 * scenarios to orchestrate.
 */

import {byCursor, byId} from '../../src/workflow';

interface Bug {
  id: string;
  updated: number;
}

const a: Bug = {id: 'a', updated: 1};
const b: Bug = {id: 'b', updated: 2};
const c: Bug = {id: 'c', updated: 3};

describe('byId', () => {
  const differ = byId<Bug>((bug) => bug.id);

  it('reports everything as added on the first poll', () => {
    const result = differ.diff(differ.initial, [a, b]);

    expect(result.added).toEqual([a, b]);
    expect(result.removed).toEqual([]);
    expect(result.state).toEqual(['a', 'b']);
  });

  // The property the whole poller depends on: a bug that stays open must not be
  // reported again on every cycle.
  it('reports nothing for items that are still present', () => {
    const result = differ.diff(['a', 'b'], [a, b]);

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('reports only what is genuinely new', () => {
    const result = differ.diff(['a'], [a, b]);

    expect(result.added).toEqual([b]);
  });

  /**
   * What `byCursor` cannot do, and the reason `byId` keeps a set rather than a
   * high-water mark: knowing something is gone requires having known it was
   * there.
   */
  it('reports an item that has gone away', () => {
    const result = differ.diff(['a', 'b'], [a]);

    expect(result.removed).toEqual(['b']);
    expect(result.state).toEqual(['a']);
  });

  // State is the current set, not a log — otherwise it would grow forever and
  // eventually hit the carryover cap.
  it('forgets an id once its item is gone', () => {
    const after = differ.diff(['a', 'b'], [a]).state;

    expect(after).toEqual(['a']);
    // And so a returning item is new again, which is the honest reading of a
    // set that only knows what is present.
    expect(differ.diff(after, [a, b]).added).toEqual([b]);
  });

  /**
   * The poller decides whether to roll over by comparing serialized states, so
   * the same set must serialize the same way however the source happened to
   * order it. Without this, every cycle would look like a change.
   */
  it('produces an order-independent state', () => {
    const one = differ.diff(differ.initial, [a, b, c]).state;
    const other = differ.diff(differ.initial, [c, a, b]).state;

    expect(one).toEqual(other);
  });

  it('asks the source for everything, having no way to narrow it', () => {
    expect(differ.query(['a'])).toBeUndefined();
  });
});

describe('byCursor', () => {
  const differ = byCursor<Bug, number>((bug) => bug.updated);

  it('takes everything when it has no mark yet', () => {
    const result = differ.diff(differ.initial, [a, b]);

    expect(result.added).toEqual([a, b]);
    expect(result.state).toBe(2);
  });

  it('takes only what is above the mark', () => {
    const result = differ.diff(1, [a, b, c]);

    expect(result.added).toEqual([b, c]);
    expect(result.state).toBe(3);
  });

  it('advances to the highest key it saw, not the last one', () => {
    // Sources do not promise order within a batch.
    expect(differ.diff(undefined, [c, a, b]).state).toBe(3);
  });

  it('reports nothing, and does not move, when there is nothing new', () => {
    const result = differ.diff(3, [a, b, c]);

    expect(result.added).toEqual([]);
    expect(result.state).toBe(3);
  });

  // A stream is append-only by assumption; it has no way to express removal.
  it('never reports a removal', () => {
    expect(differ.diff(1, []).removed).toEqual([]);
  });

  /**
   * The documented limitation, pinned so it is a known trade rather than a
   * surprise: an item that arrives below the mark is skipped for good. Use
   * `byId` where the source can back-date.
   */
  it('skips an item back-dated below the mark', () => {
    expect(differ.diff(2, [{id: 'old', updated: 1}]).added).toEqual([]);
  });

  it('hands the mark to the source so it can filter at the origin', () => {
    expect(differ.query(7)).toBe(7);
    expect(differ.query(undefined)).toBeUndefined();
  });
});

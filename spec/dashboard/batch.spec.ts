/**
 * @fileoverview
 * Applying one control action across a selection.
 *
 * The whole point is the partial failure. A selection is built from a listing
 * that was polled seconds ago, so some of it will routinely be un-actionable by
 * the time the batch runs — and an operator who terminated forty things needs to
 * know which three did not take.
 */

import {
  failuresOf,
  runBatch,
  type BatchProgress,
} from '../../dashboard/app/batch';

describe('dashboard batch — running an action over a selection', () => {
  it('applies the action to every id, in the order given', async () => {
    const seen: string[] = [];
    await runBatch(['a', 'b', 'c'], async (id) => {
      seen.push(id);
    });

    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('reports every id as having worked when they all do', async () => {
    const outcomes = await runBatch(['a', 'b'], async () => undefined);

    expect(outcomes).toEqual([
      {workflowId: 'a', ok: true},
      {workflowId: 'b', ok: true},
    ]);
    expect(failuresOf(outcomes)).toEqual([]);
  });

  it('keeps going after one fails, and names the one that did', async () => {
    // Aborting here would leave a half-applied action with no record of where
    // it stopped — the operator would have to diff the listing to find out.
    const outcomes = await runBatch(['a', 'b', 'c'], async (id) => {
      if (id === 'b') throw new Error('already settled');
    });

    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    expect(failuresOf(outcomes)).toEqual([
      {workflowId: 'b', ok: false, error: 'already settled'},
    ]);
  });

  it('carries a non-Error rejection through as text rather than dropping it', async () => {
    const outcomes = await runBatch(['a'], async () => {
      throw 'the server said no';
    });

    expect(outcomes[0]?.error).toBe('the server said no');
  });

  it('reports progress after each one, so a count can be rendered', async () => {
    const seen: BatchProgress[] = [];
    await runBatch(
      ['a', 'b', 'c'],
      async () => undefined,
      (progress) => seen.push({...progress, outcomes: [...progress.outcomes]}),
    );

    expect(seen.map((p) => p.done)).toEqual([1, 2, 3]);
    expect(seen.every((p) => p.total === 3)).toBeTrue();
    // The outcomes accumulate rather than arriving all at the end.
    expect(seen[0]?.outcomes.length).toBe(1);
    expect(seen[2]?.outcomes.length).toBe(3);
  });

  it('does nothing for an empty selection', async () => {
    let called = false;
    const outcomes = await runBatch([], async () => {
      called = true;
    });

    expect(outcomes).toEqual([]);
    expect(called).toBeFalse();
  });
});

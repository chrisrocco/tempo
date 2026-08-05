/**
 * @fileoverview
 * How a page of history becomes bars on a time axis.
 *
 * The cases that matter are the ones with a plausible wrong answer: a completion
 * whose dispatch is on another page (a bar starting at the left edge would be a
 * fabricated measurement), an event with no timestamp (a bar at the epoch), and
 * a run fast enough that everything shares one millisecond (a division by zero).
 */

import type {HistoryEvent} from '../../src/protocol/history_events';
import {buildTimeline, fractionOf} from '../../dashboard/app/history_spans';

const OPTIONS = {};

function scheduled(seq: number, name: string, ts: number): HistoryEvent {
  return {type: 'activityScheduled', seq, name, args: [], options: OPTIONS, ts};
}

describe('dashboard timeline — pairing events into spans', () => {
  it('turns a dispatch and its completion into one span with a length', () => {
    const timeline = buildTimeline(
      [
        scheduled(1, 'charge', 1_000),
        {type: 'activityCompleted', seq: 1, result: 'ok', ts: 3_500},
      ],
      9_999,
    );
    expect(timeline.spans.length).toBe(1);
    expect(timeline.spans[0]).toEqual(
      jasmine.objectContaining({
        seq: 1,
        kind: 'activity',
        label: 'charge',
        start: 1_000,
        end: 3_500,
        outcome: 'ok',
      }),
    );
    expect(timeline.marks).toEqual([]);
  });

  it('marks a failed activity as failed rather than merely finished', () => {
    const timeline = buildTimeline(
      [
        scheduled(1, 'charge', 1_000),
        {type: 'activityFailed', seq: 1, error: 'declined', ts: 1_200},
      ],
      9_999,
    );
    expect(timeline.spans[0]!.outcome).toBe('failed');
  });

  it('pairs interleaved work by seq, not by adjacency', () => {
    // Two activities running at once is the case the bars exist to show; a
    // parser that closed the most recent dispatch would swap their lengths.
    const timeline = buildTimeline(
      [
        scheduled(1, 'slow', 1_000),
        scheduled(2, 'quick', 1_100),
        {type: 'activityCompleted', seq: 2, result: 'ok', ts: 1_200},
        {type: 'activityCompleted', seq: 1, result: 'ok', ts: 5_000},
      ],
      9_999,
    );
    const bySeq = new Map(timeline.spans.map((s) => [s.seq, s]));
    expect(bySeq.get(1)!.end).toBe(5_000);
    expect(bySeq.get(2)!.end).toBe(1_200);
  });

  it('keeps a dispatch with no completion open rather than inventing an end', () => {
    const timeline = buildTimeline([scheduled(1, 'charge', 1_000)], 9_999);
    expect(timeline.spans[0]!.end).toBeUndefined();
    expect(timeline.spans[0]!.outcome).toBe('open');
  });

  it('stretches the axis to the present for work still outstanding', () => {
    // Otherwise a span running for an hour draws as a sliver at the right edge.
    const timeline = buildTimeline([scheduled(1, 'charge', 1_000)], 60_000);
    expect(timeline.end).toBe(60_000);
  });

  it('records a completion whose dispatch is off the page as a mark, not a span', () => {
    // A bar would need a start, and the only one available is the page boundary
    // — which is not when the activity began.
    const timeline = buildTimeline(
      [{type: 'activityCompleted', seq: 7, result: 'ok', ts: 4_000}],
      9_999,
    );
    expect(timeline.spans).toEqual([]);
    expect(timeline.marks.length).toBe(1);
    expect(timeline.marks[0]!.at).toBe(4_000);
  });

  it('carries a child id onto its span, so the bar can link to the child', () => {
    const timeline = buildTimeline(
      [
        {
          type: 'childStarted',
          seq: 1,
          childId: 'item-9',
          detached: false,
          ts: 1,
        },
        {type: 'childFailed', seq: 1, error: 'nope', childId: 'item-9', ts: 5},
      ],
      9_999,
    );
    expect(timeline.spans[0]!.childId).toBe('item-9');
    expect(timeline.spans[0]!.kind).toBe('child');
  });
});

describe('dashboard timeline — events that are points, not intervals', () => {
  it('places a signal as a mark at the moment it arrived', () => {
    const timeline = buildTimeline(
      [{type: 'signal', name: 'approve', payload: undefined, ts: 2_000}],
      9_999,
    );
    expect(timeline.marks[0]).toEqual({
      at: 2_000,
      label: 'signal approve',
      tone: 'accent',
    });
  });

  it('places a cancellation as a mark', () => {
    const timeline = buildTimeline([{type: 'cancelRequested', ts: 7}], 9_999);
    expect(timeline.marks[0]!.tone).toBe('danger');
  });
});

describe('dashboard timeline — what cannot be placed', () => {
  it('counts events written before timestamps existed instead of drawing them', () => {
    const timeline = buildTimeline(
      [
        {
          type: 'activityScheduled',
          seq: 1,
          name: 'a',
          args: [],
          options: OPTIONS,
        },
        {type: 'signal', name: 'go', payload: undefined},
        scheduled(2, 'b', 1_000),
      ],
      9_999,
    );
    expect(timeline.unplaceable).toBe(2);
    expect(timeline.spans.length).toBe(1);
  });

  it('reports a page with nothing placeable as empty rather than as an axis at zero', () => {
    const timeline = buildTimeline(
      [{type: 'signal', name: 'go', payload: undefined}],
      9_999,
    );
    expect(timeline.empty).toBeTrue();
    expect(timeline.unplaceable).toBe(1);
  });
});

describe('dashboard timeline — positioning on the axis', () => {
  it('places a time by its fraction of the span covered', () => {
    expect(fractionOf(1_500, {start: 1_000, end: 2_000})).toBe(0.5);
    expect(fractionOf(1_000, {start: 1_000, end: 2_000})).toBe(0);
    expect(fractionOf(2_000, {start: 1_000, end: 2_000})).toBe(1);
  });

  it('collapses a zero-width axis instead of dividing by zero', () => {
    // Ordinary for a local run: everything lands in the same millisecond.
    expect(fractionOf(1_000, {start: 1_000, end: 1_000})).toBe(0);
  });
});

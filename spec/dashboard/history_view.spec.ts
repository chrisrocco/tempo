/**
 * @fileoverview
 * How a history event reads, and when a duration is knowable.
 *
 * The cases worth pinning down are the ones where the honest answer is "I don't
 * know": an event written before `ts` existed, and a completion whose dispatch
 * is on a page that is not loaded. Both are easy to render as a confident wrong
 * number, and neither would be noticed by looking at the page.
 */

import 'jasmine';
import type {HistoryEvent} from '../../src/protocol/history_events';
import {
  EVENT_CATEGORIES,
  describeEvent,
  durationOf,
  eventCategory,
  formatDuration,
  markerTimes,
} from '../../dashboard/app/history_view';

/** The default activity options, which none of these cases depends on. */
const OPTIONS = {};

describe('dashboard history — reading an event', () => {
  it('names the activity on the event that schedules it', () => {
    const view = describeEvent({
      type: 'activityScheduled',
      seq: 1,
      name: 'chargeCard',
      args: [42],
      options: OPTIONS,
    });
    expect(view.label).toContain('chargeCard');
    expect(view.payload).toEqual([42]);
  });

  it('carries the error message on a failed activity, and its stack', () => {
    const view = describeEvent({
      type: 'activityFailed',
      seq: 1,
      error: 'card declined',
      stack: 'Error: card declined\n    at charge',
    });
    expect(view.label).toContain('card declined');
    expect(view.tone).toBe('danger');
    expect(view.stack).toContain('at charge');
  });

  it('distinguishes a detached child from a blocking one', () => {
    const detached = describeEvent({
      type: 'childStarted',
      seq: 2,
      childId: 'item-9',
      detached: true,
    });
    const blocking = describeEvent({
      type: 'childStarted',
      seq: 3,
      childId: 'item-9',
      detached: false,
    });
    expect(detached.label).toContain('detached');
    expect(blocking.label).not.toContain('detached');
  });

  it('carries the child id on an outcome, so the row can link to the child', () => {
    // The reason `childId` is denormalized onto the outcome: a long history
    // pages, and the `childStarted` that named this child may not be loaded.
    const failed = describeEvent({
      type: 'childFailed',
      seq: 4,
      error: 'child blew up',
      childId: 'item-7',
    });
    expect(failed.childId).toBe('item-7');
    expect(failed.tone).toBe('danger');
  });

  it('leaves the child id unset on history written before it was recorded', () => {
    const old = describeEvent({
      type: 'childFailed',
      seq: 4,
      error: 'child blew up',
    });
    expect(old.childId).toBeUndefined();
  });

  it('shows a signal payload, which is the reason to look at a signal', () => {
    const view = describeEvent({
      type: 'signal',
      name: 'approve',
      payload: {by: 'ops'},
    });
    expect(view.label).toContain('approve');
    expect(view.payload).toEqual({by: 'ops'});
  });
});

describe('dashboard history — grouping events into families', () => {
  it('puts an activity and its outcome in the same family', () => {
    // The property the whole grouping rests on: filtering to activities keeps
    // the dispatch that names them, so the duration pairing still resolves.
    const scheduled: HistoryEvent = {
      type: 'activityScheduled',
      seq: 1,
      name: 'charge',
      args: [],
      options: OPTIONS,
    };
    const failed: HistoryEvent = {
      type: 'activityFailed',
      seq: 1,
      error: 'declined',
    };
    expect(eventCategory(scheduled)).toBe('activity');
    expect(eventCategory(failed)).toBe('activity');
  });

  it('puts a timer and its firing in the same family', () => {
    expect(eventCategory({type: 'timerStarted', seq: 1, fireAt: 9})).toBe(
      'timer',
    );
    expect(eventCategory({type: 'timerFired', seq: 1})).toBe('timer');
  });

  it('puts a child and its outcome in the same family', () => {
    expect(
      eventCategory({
        type: 'childStarted',
        seq: 1,
        childId: 'c',
        detached: false,
      }),
    ).toBe('child');
    expect(eventCategory({type: 'childCompleted', seq: 1, result: 1})).toBe(
      'child',
    );
  });

  it('separates a signal from a cancellation, which arrive the same way', () => {
    expect(
      eventCategory({type: 'signal', name: 'approve', payload: undefined}),
    ).toBe('signal');
    expect(eventCategory({type: 'cancelRequested'})).toBe('cancellation');
  });

  /**
   * Both are cancellation and they belong to different families, which reads as
   * a contradiction until you ask whose. `cancelRequested` is this execution
   * being cancelled; `childCancelRequested` is this execution cancelling someone
   * else, and it names only a `targetSeq` — unreadable away from the
   * `childStarted` it points at.
   */
  it('files a cancel aimed at a child with the children, not with cancellation', () => {
    expect(
      eventCategory({type: 'childCancelRequested', seq: 1, targetSeq: 0}),
    ).toBe('child');
  });

  it('offers every family it can return, so none is unreachable', () => {
    const every: HistoryEvent[] = [
      {type: 'activityCompleted', seq: 1, result: 1},
      {type: 'timerFired', seq: 1},
      {type: 'childCompleted', seq: 1, result: 1},
      {type: 'signal', name: 'go', payload: undefined},
      {type: 'cancelRequested'},
    ];
    const reachable = new Set(every.map(eventCategory));
    expect([...reachable].sort()).toEqual([...EVENT_CATEGORIES].sort());
  });
});

describe('dashboard history — durations', () => {
  const scheduled: HistoryEvent = {
    type: 'activityScheduled',
    seq: 1,
    name: 'charge',
    args: [],
    options: OPTIONS,
    ts: 1_000,
  };

  it('measures a completion from its own dispatch, not the previous row', () => {
    const unrelated: HistoryEvent = {
      type: 'timerStarted',
      seq: 2,
      fireAt: 9_999,
      ts: 2_500,
    };
    const completed: HistoryEvent = {
      type: 'activityCompleted',
      seq: 1,
      result: 'ok',
      ts: 3_000,
    };
    const markers = markerTimes([scheduled, unrelated, completed]);
    expect(durationOf(completed, markers)).toBe(2_000);
  });

  it('reports no duration when the dispatch is on a page that is not loaded', () => {
    const completed: HistoryEvent = {
      type: 'activityCompleted',
      seq: 1,
      result: 'ok',
      ts: 3_000,
    };
    expect(durationOf(completed, markerTimes([completed]))).toBeUndefined();
  });

  it('reports no duration for history written before timestamps existed', () => {
    const noTs: HistoryEvent = {
      type: 'activityScheduled',
      seq: 1,
      name: 'charge',
      args: [],
      options: OPTIONS,
    };
    const completed: HistoryEvent = {
      type: 'activityCompleted',
      seq: 1,
      result: 'ok',
    };
    expect(
      durationOf(completed, markerTimes([noTs, completed])),
    ).toBeUndefined();
  });

  it('reports no duration for a dispatch, which has not finished anything', () => {
    expect(durationOf(scheduled, markerTimes([scheduled]))).toBeUndefined();
  });

  it('reports no duration for a signal, which completes no command', () => {
    const signal: HistoryEvent = {
      type: 'signal',
      name: 'approve',
      payload: undefined,
      ts: 5_000,
    };
    expect(durationOf(signal, markerTimes([scheduled]))).toBeUndefined();
  });
});

describe('dashboard history — formatting a duration', () => {
  it('uses milliseconds below a second', () => {
    expect(formatDuration(450)).toBe('450ms');
  });

  it('uses seconds with one decimal below a minute', () => {
    expect(formatDuration(2_400)).toBe('2.4s');
  });

  it('uses minutes and seconds below an hour', () => {
    expect(formatDuration(90_000)).toBe('1m 30s');
  });

  it('uses hours and minutes above an hour', () => {
    expect(formatDuration(3 * 3_600_000 + 25 * 60_000)).toBe('3h 25m');
  });
});

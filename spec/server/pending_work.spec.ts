/**
 * @fileoverview
 * The derivation behind both crash recovery and `Client.describe()`: given a
 * history, which dispatched operations are still outstanding. These are unit
 * specs because the two consumers must agree, and an integration test would only
 * catch a disagreement in whichever path it happened to exercise.
 */

import type {HistoryEvent} from '../../src';
import {pendingWork} from '../../src/server';

describe('pendingWork', () => {
  it('reports a dispatched activity whose completion has not arrived', () => {
    const history: HistoryEvent[] = [
      {
        type: 'activityScheduled',
        seq: 0,
        name: 'greet',
        args: [],
        options: {},
      },
    ];
    expect(pendingWork(history).activities.map((e) => e.name)).toEqual([
      'greet',
    ]);
  });

  it('drops an activity once its completion is recorded', () => {
    const history: HistoryEvent[] = [
      {
        type: 'activityScheduled',
        seq: 0,
        name: 'greet',
        args: [],
        options: {},
      },
      {type: 'activityCompleted', seq: 0, result: 'hi'},
    ];
    expect(pendingWork(history).activities).toEqual([]);
  });

  it('treats a failed activity as finished, not outstanding', () => {
    const history: HistoryEvent[] = [
      {
        type: 'activityScheduled',
        seq: 0,
        name: 'greet',
        args: [],
        options: {},
      },
      {type: 'activityFailed', seq: 0, error: 'boom'},
    ];
    expect(pendingWork(history).activities).toEqual([]);
  });

  it('treats a cancelled activity as finished, not outstanding', () => {
    const history: HistoryEvent[] = [
      {
        type: 'activityScheduled',
        seq: 0,
        name: 'agent',
        args: [],
        options: {},
      },
      {type: 'cancelRequested'},
      {type: 'activityCancelled', seq: 0, error: 'aborted'},
    ];
    expect(pendingWork(history).activities).toEqual([]);
  });

  it('reports an unfired timer with the absolute time it fires at', () => {
    const history: HistoryEvent[] = [
      {type: 'timerStarted', seq: 1, fireAt: 1234},
    ];
    expect(pendingWork(history).timers).toEqual([
      {type: 'timerStarted', seq: 1, fireAt: 1234},
    ]);
  });

  // Detached children are dispatched work an operator wants to see, so they are
  // reported like any other; only recovery cares about the distinction, and it
  // filters on the flag itself.
  it('reports both blocking and detached children, flagged', () => {
    const history: HistoryEvent[] = [
      {type: 'childStarted', seq: 0, childId: 'c1', detached: false},
      {type: 'childStarted', seq: 1, childId: 'c2', detached: true},
    ];
    expect(
      pendingWork(history).children.map((e) => [e.childId, e.detached]),
    ).toEqual([
      ['c1', false],
      ['c2', true],
    ]);
  });

  it('keeps outstanding work in the order it was dispatched', () => {
    const history: HistoryEvent[] = [
      {type: 'activityScheduled', seq: 0, name: 'a', args: [], options: {}},
      {type: 'activityScheduled', seq: 1, name: 'b', args: [], options: {}},
      {type: 'activityCompleted', seq: 0, result: null},
      {type: 'activityScheduled', seq: 2, name: 'c', args: [], options: {}},
    ];
    expect(pendingWork(history).activities.map((e) => e.name)).toEqual([
      'b',
      'c',
    ]);
  });

  it('surfaces a cancellation request, which no completion event clears', () => {
    const history: HistoryEvent[] = [
      {type: 'activityScheduled', seq: 0, name: 'a', args: [], options: {}},
      {type: 'cancelRequested'},
    ];
    expect(pendingWork(history).cancelRequested).toBe(true);
  });

  it('reports nothing outstanding for an empty history', () => {
    expect(pendingWork([])).toEqual({
      activities: [],
      timers: [],
      children: [],
      cancelRequested: false,
    });
  });
});

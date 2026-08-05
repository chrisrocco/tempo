/**
 * @fileoverview
 * The read model behind `tempo list` and `tempo describe`, and the one question
 * an operator asks of a listing: which of these is broken?
 *
 * The guarantee under test is that the *summary* can answer it. A wedged
 * execution and a healthy one both read `running`, so a listing without the
 * failure count cannot tell them apart — finding a stuck execution then meant
 * describing every running one in turn. These tests pin the fields onto the
 * summary so that regression is a failure rather than a discovery.
 */

import {isStuck, MAX_HISTORY_PAGE} from '../../src/protocol';
import type {HistoryEvent} from '../../src/protocol';
import {describeExecution, summarizeExecution} from '../../src/server';
import type {ExecutionRecord} from '../../src/server';

/** A minimal record; each test overrides only the fields it is about. */
function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    workflowId: 'wf-1',
    runId: 0,
    name: 'greeter',
    status: 'running',
    args: [],
    history: [],
    version: 0,
    taskFailures: 0,
    // Required on the record and always set by both adapters. Spelled out here
    // because the cast below would otherwise let a fixture omit it, which is
    // a shape no store ever produces.
    activityAttempts: {},
    ...overrides,
  } as ExecutionRecord;
}

describe('summarizeExecution', () => {
  it('carries the task-failure count, so a listing can flag a wedged run', () => {
    const summary = summarizeExecution(
      record({taskFailures: 3, lastTaskFailure: 'no workflow registered as x'}),
    );

    expect(summary.taskFailures).toBe(3);
    expect(summary.lastTaskFailure).toBe('no workflow registered as x');
  });

  it('reports zero failures for a healthy execution', () => {
    const summary = summarizeExecution(record());

    expect(summary.taskFailures).toBe(0);
    expect(summary.lastTaskFailure).toBeUndefined();
  });
});

describe('isStuck', () => {
  it('is true for a running execution the engine cannot replay', () => {
    expect(isStuck(summarizeExecution(record({taskFailures: 1})))).toBeTrue();
  });

  /**
   * The case a naive `status === 'running'` filter gets wrong. A workflow parked
   * on a long timer is the normal state of a healthy system, and flagging it
   * would make the whole signal useless.
   */
  it('is false for a running execution that is merely waiting', () => {
    expect(isStuck(summarizeExecution(record({taskFailures: 0})))).toBeFalse();
  });

  /**
   * And the case a naive `taskFailures > 0` filter gets wrong. The count outlives
   * the execution — it is not cleared on terminate — so a settled execution that
   * had a rough patch would be reported as a live problem forever.
   */
  it('is false once a failing execution has been terminated', () => {
    const settled = record({status: 'terminated', taskFailures: 9});

    expect(isStuck(summarizeExecution(settled))).toBeFalse();
  });

  it('is false for an execution that failed on its own terms', () => {
    const failed = record({status: 'failed', taskFailures: 2});

    expect(isStuck(summarizeExecution(failed))).toBeFalse();
  });
});

/**
 * Paging an execution's history.
 *
 * The default is the counter-intuitive part and the deliberate one: no options
 * means the *last* page, not the first. A history long enough to need paging is
 * long enough that its opening events are rarely what anyone is looking for —
 * the reason someone runs `describe` is usually to find out what it is doing
 * now, or what it did just before it stopped.
 */
describe('describeExecution — history paging', () => {
  /** `n` distinguishable events, so a page can be identified by its contents. */
  function withHistory(n: number): ExecutionRecord {
    return record({
      history: Array.from({length: n}, (_, i) => ({
        type: 'timerStarted' as const,
        seq: i,
        fireAt: i,
      })),
    });
  }

  it('returns the whole history when it fits in a page', () => {
    const detail = describeExecution(withHistory(10));

    expect(detail.history.length).toBe(10);
    expect(detail.historyOffset).toBe(0);
    expect(detail.historyLength).toBe(10);
  });

  it('returns the most recent page by default, not the first', () => {
    const detail = describeExecution(withHistory(1200));

    expect(detail.history.length).toBe(MAX_HISTORY_PAGE);
    expect(detail.historyOffset).toBe(1200 - MAX_HISTORY_PAGE);
    // The last event of the history is the last event of the page.
    expect((detail.history.at(-1) as {seq: number}).seq).toBe(1199);
  });

  it('starts where it is asked to', () => {
    const detail = describeExecution(withHistory(1200), {
      fromEvent: 100,
      limit: 10,
    });

    expect(detail.historyOffset).toBe(100);
    expect((detail.history[0] as {seq: number}).seq).toBe(100);
    expect(detail.history.length).toBe(10);
  });

  it('caps an over-large limit rather than honouring it', () => {
    const detail = describeExecution(withHistory(2000), {
      fromEvent: 0,
      limit: 99_999,
    });

    expect(detail.history.length).toBe(MAX_HISTORY_PAGE);
  });

  /**
   * An offset past the end is a caller paging off a history that has since
   * rolled over — continue-as-new resets it to empty. An empty page is the
   * useful answer; an error would make a poller's dashboard throw for a reason
   * the operator cannot act on.
   */
  it('gives an empty page past the end rather than failing', () => {
    const detail = describeExecution(withHistory(5), {fromEvent: 500});

    expect(detail.history).toEqual([]);
    expect(detail.historyOffset).toBe(5);
    expect(detail.historyLength).toBe(5);
  });

  it('clamps a negative offset to the start', () => {
    expect(describeExecution(withHistory(5), {fromEvent: -10}).historyOffset) //
      .toBe(0);
  });

  /**
   * Pending work is derived from the *whole* history, never the page. An
   * activity scheduled at event 3 and still unanswered at event 4000 is exactly
   * what an operator is hunting for, and a page-scoped derivation would report
   * nothing pending.
   */
  it('reports pending work from the whole history, not the page', () => {
    const scheduled: HistoryEvent = {
      type: 'activityScheduled',
      seq: 0,
      name: 'slow',
      args: [],
      options: {},
    };
    const filler = Array.from({length: 900}, (_, i) => ({
      type: 'timerStarted' as const,
      seq: i + 1,
      fireAt: i,
    }));

    const detail = describeExecution(record({history: [scheduled, ...filler]}));

    // The scheduling event is far outside the returned page…
    expect(detail.historyOffset).toBeGreaterThan(0);
    expect(
      detail.history.some((e) => e.type === 'activityScheduled'),
    ).toBeFalse();
    // …and it is still reported as pending.
    expect(detail.pending.activities).toEqual([
      {seq: 0, name: 'slow', attempt: 1, maxAttempts: 1},
    ]);
  });
});

describe('describeExecution — lineage', () => {
  it('carries the parent, so a child is not a dead end', () => {
    const detail = describeExecution(
      record({parent: {workflowId: 'order-42', seq: 3}}),
    );

    expect(detail.parent).toEqual({workflowId: 'order-42', seq: 3});
  });

  it('omits it for an execution a client started directly', () => {
    expect(describeExecution(record()).parent).toBeUndefined();
  });
});

/**
 * A retrying activity and a first-try one are both "waiting on: charge" without
 * these fields, which is the case an operator most often has open. The count
 * comes from the durable record rather than from history, because a failed
 * attempt is deliberately not a history event.
 */
describe('describeExecution — an activity that is retrying', () => {
  const scheduled: HistoryEvent = {
    type: 'activityScheduled',
    seq: 0,
    name: 'charge',
    args: [],
    options: {retry: {maximumAttempts: 5}},
  };

  it('reports the first attempt for an activity that has not failed', () => {
    // The common case: no entry is written until something fails.
    const detail = describeExecution(record({history: [scheduled]}));

    expect(detail.pending.activities[0]).toEqual({
      seq: 0,
      name: 'charge',
      attempt: 1,
      maxAttempts: 5,
    });
  });

  it('counts the attempt now running, not the attempts already spent', () => {
    // Two failures means the third attempt is the live one. Off by one here is
    // the whole reason the wire carries `attempt` rather than the stored count.
    const detail = describeExecution(
      record({
        history: [scheduled],
        activityAttempts: {0: {attempts: 2}},
      }),
    );

    expect(detail.pending.activities[0]?.attempt).toBe(3);
  });

  it('carries why the last attempt failed and when the next is due', () => {
    const detail = describeExecution(
      record({
        history: [scheduled],
        activityAttempts: {
          0: {attempts: 2, lastError: 'connection refused', nextAttemptAt: 900},
        },
      }),
    );

    expect(detail.pending.activities[0]).toEqual({
      seq: 0,
      name: 'charge',
      attempt: 3,
      maxAttempts: 5,
      lastError: 'connection refused',
      nextAttemptAt: 900,
    });
  });

  it('reports one permitted attempt for an activity with no retry policy', () => {
    const noRetry: HistoryEvent = {
      type: 'activityScheduled',
      seq: 1,
      name: 'once',
      args: [],
      options: {},
    };
    const detail = describeExecution(record({history: [noRetry]}));

    expect(detail.pending.activities[0]?.maxAttempts).toBe(1);
  });

  it('says nothing about an activity that has already settled', () => {
    // The record is cleared on a terminal event, and the activity stops being
    // pending — a stale count outliving either would be worse than none.
    const detail = describeExecution(
      record({
        history: [
          scheduled,
          {type: 'activityFailed', seq: 0, error: 'gave up'},
        ],
      }),
    );

    expect(detail.pending.activities).toEqual([]);
  });
});

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

import {isStuck} from '../../src/protocol';
import {summarizeExecution} from '../../src/server';
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

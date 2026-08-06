/**
 * @fileoverview
 * The numbers on the triage strip.
 *
 * Two things here have a plausible wrong answer that looks fine on screen: a
 * fleet that has not been read yet, which is not the same as a healthy one, and
 * an idle queue nobody polls, which is not a problem. Both would render as a
 * confident zero under a naive count.
 */

import {ANY_TASK_QUEUE} from '../../src/protocol';
import type {ExecutionGroup, ExecutionGroups} from '../../src/protocol';
import {triageCounts} from '../../dashboard/app/triage_counts';

const NOW = 1_000_000;

/** A group with everything zeroed but what the case is about. */
function group(
  key: string,
  over: Partial<ExecutionGroup> = {},
): ExecutionGroup {
  return {
    key,
    total: 0,
    running: 0,
    completed: 0,
    failed: 0,
    terminated: 0,
    stuck: 0,
    ...over,
  };
}

function groups(byTaskQueue: ExecutionGroup[]): ExecutionGroups {
  return {byTaskQueue, byName: [], retryingActivities: []};
}

describe('dashboard triage counts — totals', () => {
  it('sums each status across every queue', () => {
    const counts = triageCounts(
      groups([
        group('default', {running: 3, stuck: 1, failed: 2}),
        group('email', {running: 4, stuck: 2, failed: 5}),
      ]),
      [],
      NOW,
    );

    expect(counts).toEqual(
      jasmine.objectContaining({running: 7, stuck: 3, failed: 7}),
    );
  });

  it('keeps stuck separate rather than adding it to running', () => {
    // A wedged execution *is* running, so these overlap. Adding them would
    // report more executions than exist.
    const counts = triageCounts(
      groups([group('default', {running: 2, stuck: 2})]),
      [],
      NOW,
    );

    expect(counts?.running).toBe(2);
    expect(counts?.stuck).toBe(2);
  });

  it('reports nothing at all before the groups have arrived', () => {
    expect(triageCounts(undefined, [], NOW)).toBeUndefined();
  });
});

describe('dashboard triage counts — queues nothing is serving', () => {
  it('counts a queue with running work and no workflow poller', () => {
    const counts = triageCounts(
      groups([group('email', {running: 2})]),
      [],
      NOW,
    );

    expect(counts?.unservedQueues).toBe(1);
  });

  it('ignores an idle queue nobody polls, which is a pool at rest', () => {
    // The case that would make the strip cry wolf on any dev machine with a
    // stopped worker and no live executions.
    const counts = triageCounts(
      groups([group('email', {completed: 9})]),
      [],
      NOW,
    );

    expect(counts?.unservedQueues).toBe(0);
  });

  it('does not count a queue that is being polled', () => {
    const counts = triageCounts(
      groups([group('email', {running: 2})]),
      [{taskQueue: 'email', workflowPolledAt: NOW - 100, workers: []}],
      NOW,
    );

    expect(counts?.unservedQueues).toBe(0);
  });

  it('treats a worker polling every queue as serving this one', () => {
    const counts = triageCounts(
      groups([group('email', {running: 2})]),
      [{taskQueue: ANY_TASK_QUEUE, workflowPolledAt: NOW - 100, workers: []}],
      NOW,
    );

    expect(counts?.unservedQueues).toBe(0);
  });

  it('counts a queue served only for activity work', () => {
    // Nothing polling for workflow tasks means the execution cannot be replayed
    // at all, so it cannot progress by any route — unlike a missing activity
    // worker, which still leaves it able to reach its next dispatch.
    const counts = triageCounts(
      groups([group('email', {running: 2})]),
      [{taskQueue: 'email', activityPolledAt: NOW - 100, workers: []}],
      NOW,
    );

    expect(counts?.unservedQueues).toBe(1);
  });

  it('reports the queue count as unknown until the fleet has been read', () => {
    // Zero would say "nothing is wrong with the workers" on every first paint.
    const counts = triageCounts(
      groups([group('email', {running: 2})]),
      undefined,
      NOW,
    );

    expect(counts?.unservedQueues).toBeUndefined();
    // The rest is still worth showing without it.
    expect(counts?.running).toBe(2);
  });
});

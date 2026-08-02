/**
 * @fileoverview
 * The worker poll loops' failure handling: a worker that cannot reach its server
 * must say so and back off, rather than retry silently at the idle interval. This
 * is the fault that used to be invisible — the process stayed "active" under its
 * supervisor while doing no work at all (planning/tickets/02).
 */

import type { WorkflowService } from '../../src/protocol';
import {
  createErrorReporter,
  errorBackoffMs,
  runWorkflowWorker,
} from '../../src/worker';
import { createWorkflowRegistry, createWorkflowWorker } from '../../src/worker';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A service that satisfies the seam; tests override only what they exercise. */
function fakeService(overrides: Partial<WorkflowService>): WorkflowService {
  return {
    start: () => ({ workflowId: 'wf' }),
    signal: () => {},
    cancel: () => {},
    terminate: () => {},
    getResult: async () => undefined,
    getStatus: () => 'running',
    describeExecution: async () => undefined,
    listExecutions: async () => [],
    pollWorkflowTask: async () => undefined,
    completeWorkflowTask: async () => {},
    failWorkflowTask: async () => {},
    pollActivityTask: async () => undefined,
    completeActivityTask: async () => {},
    heartbeatActivityTask: async () => {},
    ...overrides,
  };
}

async function until(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await wait(2);
  }
}

describe('worker loops — error backoff', () => {
  it('doubles the delay per consecutive failure, up to a ceiling', () => {
    expect(errorBackoffMs(1, 50, 5000)).toBe(50);
    expect(errorBackoffMs(2, 50, 5000)).toBe(100);
    expect(errorBackoffMs(3, 50, 5000)).toBe(200);
    expect(errorBackoffMs(8, 50, 5000)).toBe(5000); // capped, not 6400
    expect(errorBackoffMs(40, 50, 5000)).toBe(5000); // no overflow to Infinity
  });
});

describe('worker loops — failure reporting', () => {
  it('reports each failure with a running count and keeps polling', async () => {
    const seen: { message: string; consecutive: number }[] = [];
    let polls = 0;
    const service = fakeService({
      pollWorkflowTask: async () => {
        polls += 1;
        if (polls <= 2) throw new Error('connection refused');
        return undefined;
      },
    });

    const loop = runWorkflowWorker(
      service,
      createWorkflowWorker(createWorkflowRegistry()),
      {
        pollIntervalMs: 1,
        errorBackoffMs: 1,
        maxErrorBackoffMs: 1,
        onError: (error, consecutive) =>
          seen.push({ message: (error as Error).message, consecutive }),
      },
    );

    try {
      await until(() => polls > 3); // it recovered and is polling again
    } finally {
      await loop.stop();
    }

    expect(seen.map((s) => s.consecutive)).toEqual([1, 2]);
    expect(seen[0].message).toBe('connection refused');
  });

  it('resets the failure count after a poll succeeds', async () => {
    const counts: number[] = [];
    let polls = 0;
    // fail, succeed, fail — the second failure is a fresh incident, not a 2nd.
    const service = fakeService({
      pollWorkflowTask: async () => {
        polls += 1;
        if (polls === 1 || polls === 3) throw new Error('flaky');
        return undefined;
      },
    });

    const loop = runWorkflowWorker(
      service,
      createWorkflowWorker(createWorkflowRegistry()),
      {
        pollIntervalMs: 1,
        errorBackoffMs: 1,
        maxErrorBackoffMs: 1,
        onError: (_error, consecutive) => counts.push(consecutive),
      },
    );

    try {
      await until(() => counts.length >= 2);
    } finally {
      await loop.stop();
    }

    expect(counts.slice(0, 2)).toEqual([1, 1]);
  });

  it('rate-limits a repeating failure but always reports a new one', () => {
    const lines: string[] = [];
    const report = createErrorReporter('workflow worker', (l) =>
      lines.push(l.trim()),
    );

    const same = new Error('connection refused');
    for (let i = 1; i <= 5; i++) report(same, i); // 1st, 2nd, 4th only
    report(new Error('socket hang up'), 6); // different message — always reported

    expect(lines).toEqual([
      'workflow worker: poll failed (1x): connection refused',
      'workflow worker: poll failed (2x): connection refused',
      'workflow worker: poll failed (4x): connection refused',
      'workflow worker: poll failed (6x): socket hang up',
    ]);
  });
});

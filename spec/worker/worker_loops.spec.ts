/**
 * @fileoverview
 * The worker poll loops: how they fail, and how many tasks they run at once.
 *
 * The failure half: a worker that cannot reach its server must say so and back
 * off, rather than retry silently at the idle interval. That is the fault a
 * silent retry makes invisible — the process stays "active" under its supervisor
 * while doing no work at all.
 *
 * The concurrency half pins the properties a wider loop must not lose. The one
 * that matters most is negative and easy to regress: **the loop never claims a
 * task it is not running.** A claimed activity is leased from that instant, so a
 * task waiting in a worker-side buffer is a lease counting down against work
 * that has not begun — the server redelivers it, and one dispatch runs twice.
 */

import type {
  ActivityTask,
  LeasedActivityTask,
  WorkflowService,
} from '../../src/protocol';
import {
  createErrorReporter,
  createWorkflowRegistry,
  createWorkflowWorker,
  errorBackoffMs,
  runActivityWorker,
  runWorkflowWorker,
  type ActivityWorker,
} from '../../src/worker';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** A service that satisfies the seam; tests override only what they exercise. */
function fakeService(overrides: Partial<WorkflowService>): WorkflowService {
  return {
    start: () => ({workflowId: 'wf'}),
    signal: () => {},
    cancel: () => {},
    terminate: () => {},
    reset: () => {},
    getResult: async () => undefined,
    getStatus: () => 'running',
    describeExecution: async () => undefined,
    listExecutions: async () => ({executions: []}),
    listQueues: async () => [],
    listWorkflows: async () => [],
    reportWorkflows: async () => {},
    groupExecutions: async () => ({
      byTaskQueue: [],
      byName: [],
      retryingActivities: [],
    }),
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
    const seen: {message: string; consecutive: number}[] = [];
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
          seen.push({message: (error as Error).message, consecutive}),
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

/**
 * A fake activity worker whose tasks block until the test releases them, plus
 * the service that feeds it an endless supply.
 *
 * Blocking rather than timing is what makes these cases deterministic: "four are
 * in flight" is asserted by holding four open, not by racing a sleep against
 * work that might finish early on a loaded machine.
 */
function activityHarness(
  options: {failOnComplete?: (seq: number) => boolean} = {},
) {
  const releases = new Map<number, () => void>();
  let nextSeq = 0;
  let draining = false;

  const state = {
    polls: 0,
    inFlight: 0,
    peakInFlight: 0,
    started: [] as number[],
    completed: [] as number[],
    /** Let one task finish; the rest stay held. */
    release(seq: number): void {
      releases.get(seq)?.();
      releases.delete(seq);
    },
    /**
     * Let everything finish, now and in future. Teardown uses this: without the
     * future half, a task claimed between the release and `stop()` would block
     * the drain forever and hang the case rather than fail it.
     */
    releaseAll(): void {
      draining = true;
      for (const resolve of releases.values()) resolve();
      releases.clear();
    },
  };

  const service = fakeService({
    pollActivityTask: async (): Promise<LeasedActivityTask> => {
      state.polls += 1;
      const seq = nextSeq++;
      return {
        token: `t${seq}`,
        workflowId: 'wf',
        seq,
        name: 'work',
        args: [],
        options: {},
      };
    },
    completeActivityTask: async (token) => {
      const seq = Number(token.slice(1));
      if (options.failOnComplete?.(seq))
        throw new Error(`complete failed for ${seq}`);
      state.completed.push(seq);
    },
  });

  const worker: ActivityWorker = {
    runTask: async (task: ActivityTask) => {
      state.started.push(task.seq);
      state.inFlight += 1;
      state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
      if (!draining)
        await new Promise<void>((resolve) => releases.set(task.seq, resolve));
      state.inFlight -= 1;
      return {ok: true, result: undefined};
    },
  };

  // `Object.assign` rather than a spread: a spread would copy `polls` and
  // `inFlight` by value, and the closures above would then be updating an object
  // the test no longer holds.
  return Object.assign(state, {service, worker});
}

describe('worker loops — activity concurrency', () => {
  /**
   * The default has to stay one. Every deployment that has not asked for
   * concurrency is relying on it, and an activity written to assume it is alone
   * in its process would stop being correct silently.
   */
  it('runs one activity at a time unless told otherwise', async () => {
    const h = activityHarness();
    const loop = runActivityWorker(h.service, h.worker, {pollIntervalMs: 1});

    await until(() => h.started.length >= 1);
    await wait(20);

    expect(h.inFlight).toBe(1);
    expect(h.started.length).toBe(1);

    h.releaseAll();
    await loop.stop();
  });

  it('runs several activities at once when given a wider limit', async () => {
    const h = activityHarness();
    const loop = runActivityWorker(h.service, h.worker, {
      pollIntervalMs: 1,
      maxConcurrentTasks: 4,
    });

    await until(() => h.inFlight >= 4);

    expect(h.peakInFlight).toBe(4);

    h.releaseAll();
    await loop.stop();
  });

  /**
   * The rule the design turns on: a claimed task is leased, so claiming more
   * than there are slots to run them in means leases counting down against work
   * that has not started. The wait for a slot must come *before* the poll.
   */
  it('claims no more tasks than it has slots to run them in', async () => {
    const h = activityHarness();
    const loop = runActivityWorker(h.service, h.worker, {
      pollIntervalMs: 1,
      maxConcurrentTasks: 2,
    });

    await until(() => h.inFlight >= 2);
    await wait(30); // ample time for a buffering loop to have pulled more

    expect(h.polls).toBe(2);
    expect(h.started.length).toBe(2);

    h.releaseAll();
    await loop.stop();
  });

  it('claims another task as soon as one finishes, without waiting for the rest', async () => {
    const h = activityHarness();
    const loop = runActivityWorker(h.service, h.worker, {
      pollIntervalMs: 1,
      maxConcurrentTasks: 2,
    });

    await until(() => h.inFlight >= 2);
    h.release(h.started[0]!);

    // A loop that drained the whole batch before polling again would sit at two.
    await until(() => h.started.length >= 3);

    h.releaseAll();
    await loop.stop();
  });

  /**
   * Stopping stops polling; it does not abandon work already claimed. A task
   * dropped here still holds its lease, so a clean shutdown would be
   * indistinguishable from a crash and the work would run twice.
   */
  it('waits for in-flight activities to finish before stop resolves', async () => {
    const h = activityHarness();
    const loop = runActivityWorker(h.service, h.worker, {
      pollIntervalMs: 1,
      maxConcurrentTasks: 3,
    });

    await until(() => h.inFlight >= 3);
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });

    await wait(20);
    expect(stopped).toBeFalse();
    expect(h.completed.length).toBe(0);

    h.releaseAll();
    await stopping;

    expect(stopped).toBeTrue();
    expect(h.completed.length).toBe(3);
  });

  /**
   * One task failing must not take down the loop or its siblings. The report is
   * what makes it visible — the loop that started it has already moved on and
   * has no frame left to catch it in.
   */
  it('reports a failed task without stopping the loop or its siblings', async () => {
    const errors: unknown[] = [];
    const h = activityHarness({failOnComplete: (seq) => seq === 1});
    const loop = runActivityWorker(h.service, h.worker, {
      pollIntervalMs: 1,
      maxConcurrentTasks: 2,
      onError: (e) => errors.push(e),
    });

    await until(() => h.inFlight >= 2);
    h.release(0);
    h.release(1);

    await until(() => errors.length >= 1);
    expect(h.completed).toEqual([0]); // the sibling still completed

    await until(() => h.started.length >= 3); // and the loop kept claiming

    h.releaseAll();
    await loop.stop();
  });
});

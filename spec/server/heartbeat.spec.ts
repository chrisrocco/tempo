/**
 * @fileoverview
 * Heartbeating: how an activity that legitimately runs for a long time keeps its
 * claim, and how one whose worker died is caught quickly.
 *
 * Both are the same underlying problem — elapsed time is not evidence a worker is
 * dead — and before heartbeats the engine had to guess. Without a timeout it
 * assumed the worker was gone and redelivered, duplicating live work; with a
 * start-to-close timeout it assumed the deadline was meaningful and cut off
 * healthy attempts. A heartbeat replaces the guess with a statement from the work
 * itself.
 */

import type {ActivityOptions} from '../../src';
import type {TaskToken} from '../../src/protocol';
import {
  heartbeat,
  withActivityContext,
} from '../../src/worker/activity_context';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  type ServerCore,
  createServerCore,
  describeExecution,
} from '../../src/server';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function coreWith(leaseMs: number, historyStore = new MemoryHistoryStore()) {
  const activityTaskQueue = new MemoryTaskQueue(leaseMs);
  const core = createServerCore({
    historyStore,
    workflowTaskQueue: new MemoryWorkflowTaskQueue(),
    activityTaskQueue,
    timerService: new MemoryTimerService(),
    launch: () => {},
    kickWorkflowWorker: () => {},
    kickActivityWorker: () => {},
  });
  return {core, activityTaskQueue, historyStore};
}

async function seed(
  historyStore: MemoryHistoryStore,
  options: ActivityOptions,
): Promise<void> {
  await historyStore.create('wf', 'w', []);
  await historyStore.append('wf', [
    {type: 'activityScheduled', seq: 0, name: 'agent', args: [], options},
  ]);
}

function enqueue(queue: MemoryTaskQueue, options: ActivityOptions): void {
  queue.enqueue(
    {workflowId: 'wf', seq: 0, name: 'agent', args: [], options},
    'default',
  );
}

function terminalEvents(historyStore: MemoryHistoryStore) {
  return historyStore
    .get('wf')
    .then((rec) =>
      rec!.history.filter(
        (e) => e.type === 'activityCompleted' || e.type === 'activityFailed',
      ),
    );
}

describe('an attempt that keeps heartbeating', () => {
  /**
   * The headline: a ten-minute agent under a thirty-second lease. Before this,
   * the only outcomes were a duplicate run or an early failure.
   */
  it('holds its claim past the lease, so no second worker gets the task', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 200};
    const {core, activityTaskQueue, historyStore} = coreWith(40);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    // Outlive the lease several times over, beating as a working activity would.
    for (let i = 0; i < 5; i++) {
      await wait(25);
      await core.heartbeatActivityTask(task!.token);
    }

    expect(await core.pollActivityTask()).toBeUndefined(); // never redelivered
    expect(await terminalEvents(historyStore)).toEqual([]); // and never failed
  });

  it('still completes normally when the work finally finishes', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 200};
    const {core, activityTaskQueue, historyStore} = coreWith(40);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    await wait(25);
    await core.heartbeatActivityTask(task!.token);
    await core.completeActivityTask(task!.token, {
      ok: true,
      result: 'thought about it',
    });

    const terminal = await terminalEvents(historyStore);
    expect(terminal.length).toBe(1);
    expect(terminal[0].type).toBe('activityCompleted');
  });
});

describe('an attempt that stops heartbeating', () => {
  it('is failed once the silence passes its heartbeat timeout', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 40};
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    await core.pollActivityTask();
    await wait(100); // worker died without a word

    const terminal = await terminalEvents(historyStore);
    expect(terminal.length).toBe(1);
    expect((terminal[0] as {error: string}).error).toContain(
      'stopped heartbeating',
    );
  });

  /**
   * The detection-speed argument. The lease is what the engine falls back on
   * without heartbeats, and it is deliberately long; a heartbeat timeout can be
   * short because a healthy attempt is expected to speak.
   */
  it('is caught long before its lease would have expired', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 40};
    const {core, activityTaskQueue, historyStore} = coreWith(10_000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    await core.pollActivityTask();
    await wait(100); // a fraction of the 10s lease

    expect((await terminalEvents(historyStore)).length).toBe(1);
  });

  it('does not redeliver the abandoned attempt to a second worker', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 30};
    const {core, activityTaskQueue, historyStore} = coreWith(60);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    await core.pollActivityTask();
    await wait(150); // past the heartbeat deadline and the lease

    expect(await core.pollActivityTask()).toBeUndefined();
  });

  it('leaves an activity alone when it declares no heartbeat timeout', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, {});
    enqueue(activityTaskQueue, {});

    await core.pollActivityTask();
    await wait(80);

    expect(await terminalEvents(historyStore)).toEqual([]); // silence is fine
  });
});

describe('heartbeats for an attempt the server gave up on', () => {
  /**
   * A worker that was declared dead may not know it. Its heartbeat must not
   * revive a claim on work that now belongs to someone else, or the duplicate
   * run the timeout prevented would reappear by the back door.
   */
  it('are ignored rather than reviving the claim', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 30};
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    await wait(80); // abandoned
    await core.heartbeatActivityTask(task!.token); // the worker, still going

    const terminal = await terminalEvents(historyStore);
    expect(terminal.length).toBe(1); // still exactly one outcome
    expect(await core.pollActivityTask()).toBeUndefined();
  });

  it('are a no-op for a token that was never leased', async () => {
    const {core} = coreWith(5000);
    await expectAsync(
      core.heartbeatActivityTask('act-never-issued'),
    ).toBeResolved();
  });
});

/**
 * A register, not a log: one slot per attempt, overwritten by the next beat and
 * thrown away with the attempt. Nothing here is a history event of its own; the
 * one thing that outlives the attempt is its last value, copied onto the
 * terminal event — the describe after this one.
 */
describe('a checkpoint reported with a heartbeat', () => {
  async function pending(core: ServerCore, historyStore: MemoryHistoryStore) {
    const rec = await historyStore.get('wf');
    return describeExecution(rec!, {}, core.activityCheckpoints('wf')).pending
      .activities[0];
  }

  it('surfaces on the pending activity, with the time it arrived', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 200};
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const before = Date.now();
    const task = await core.pollActivityTask();
    await core.heartbeatActivityTask(task!.token, {jobId: 'q-8823', pct: 40});

    const activity = await pending(core, historyStore);
    expect(activity.checkpoint).toEqual({jobId: 'q-8823', pct: 40});
    expect(activity.checkpointAt).toBeGreaterThanOrEqual(before);
  });

  it('reports nothing until the attempt has said something', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 200};
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    await core.pollActivityTask();

    const activity = await pending(core, historyStore);
    expect(activity.checkpoint).toBeUndefined();
    expect(activity.checkpointAt).toBeUndefined();
  });

  it('replaces the previous checkpoint rather than accumulating', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 200};
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    await core.heartbeatActivityTask(task!.token, {pct: 10});
    await core.heartbeatActivityTask(task!.token, {pct: 90});

    expect((await pending(core, historyStore)).checkpoint).toEqual({pct: 90});
  });

  it('is left standing by a later heartbeat that carries nothing', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 200};
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    await core.heartbeatActivityTask(task!.token, {jobId: 'q-8823'});
    await core.heartbeatActivityTask(task!.token);

    expect((await pending(core, historyStore)).checkpoint).toEqual({
      jobId: 'q-8823',
    });
  });

  it('is discarded when the attempt completes', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 200};
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    await core.heartbeatActivityTask(task!.token, {pct: 99});
    await core.completeActivityTask(task!.token, {ok: true, result: 'rows'});

    expect(core.activityCheckpoints('wf')).toEqual({});
  });

  // The case a parallel map would get wrong: an abandoned attempt's checkpoint
  // must go with it, or `describe` reports work nobody is doing.
  it('is discarded when the attempt is abandoned for going quiet', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 30};
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    await core.heartbeatActivityTask(task!.token, {pct: 40});
    await wait(100); // the worker dies mid-query

    expect(core.activityCheckpoints('wf')).toEqual({});
  });

  it('is ignored from an attempt the server already gave up on', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 30};
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    await wait(80); // abandoned
    await core.heartbeatActivityTask(task!.token, {pct: 40}); // still going

    expect(core.activityCheckpoints('wf')).toEqual({});
  });
});

/**
 * The fourth way an attempt can end: with neither timeout set, the queue lease
 * bounds it, and expiry redelivers without deleting the lease. The stale entry
 * stays on purpose (`completeActivityTask` says why); its checkpoint must not.
 */
describe('a checkpoint superseded by redelivery', () => {
  it('is not reported against the attempt that replaced it', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith(40);
    await seed(historyStore, {});
    enqueue(activityTaskQueue, {});

    const first = await core.pollActivityTask();
    await core.heartbeatActivityTask(first!.token, {pct: 40});
    await wait(80); // the worker dies; the lease expires

    const second = await core.pollActivityTask(); // redelivered, new token
    expect(second!.token).not.toBe(first!.token);
    expect(core.activityCheckpoints('wf')).toEqual({});
  });

  it('gives way to whatever the new attempt reports', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith(40);
    await seed(historyStore, {});
    enqueue(activityTaskQueue, {});

    const first = await core.pollActivityTask();
    await core.heartbeatActivityTask(first!.token, {pct: 40});
    await wait(80);

    const second = await core.pollActivityTask();
    await core.heartbeatActivityTask(second!.token, {pct: 5});

    expect(core.activityCheckpoints('wf')[0]!.checkpoint).toEqual({pct: 5});
  });

  // The stale lease itself must survive: that work really ran, so a late
  // completion from the abandoned worker is still accepted.
  it('leaves the abandoned attempt still able to report its result', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith(40);
    await seed(historyStore, {});
    enqueue(activityTaskQueue, {});

    const first = await core.pollActivityTask();
    await core.heartbeatActivityTask(first!.token, {pct: 40});
    await wait(80);
    await core.pollActivityTask(); // redelivered

    await core.completeActivityTask(first!.token, {ok: true, result: 'rows'});

    const terminal = await terminalEvents(historyStore);
    expect(terminal.length).toBe(1);
    expect(terminal[0].type).toBe('activityCompleted');
  });
});

/**
 * The composition, rather than either half of it.
 *
 * Every spec above calls `core.heartbeatActivityTask` directly, which is not how
 * a beat reaches the server: `heartbeat()` goes through `withActivityContext`,
 * which throttles sends to a fraction of the heartbeat timeout
 * (`THROTTLE_FRACTION`). A generous timeout therefore means a long *silence*
 * between the beats that actually arrive — and the first spec in this file,
 * "holds its claim past the lease", asserts exactly the case where that silence
 * outlasts the lease. It passes anyway, because calling the core directly skips
 * the throttle.
 *
 * So each half is proved by those and the seam between them is not: without the
 * stretched lease, an author whose heartbeat timeout was long enough against the
 * lease for one throttled gap to outlast it had their activity redelivered and
 * run a second time, concurrently, while the first was still working. These
 * drive the path a deployed activity actually takes.
 */
describe('an activity heartbeating through the worker', () => {
  /** One attempt, beating on every pass of its own loop the way busy work does. */
  async function beatWhileWorking(
    core: ServerCore,
    token: TaskToken,
    heartbeatTimeoutMs: number,
    forMs: number,
  ): Promise<void> {
    await withActivityContext(
      () => void core.heartbeatActivityTask(token),
      heartbeatTimeoutMs,
      async () => {
        const until = Date.now() + forMs;
        while (Date.now() < until) {
          heartbeat();
          await wait(5);
        }
      },
    );
  }

  it('holds its claim when its heartbeat timeout is many times the lease', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 200};
    const {core, activityTaskQueue, historyStore} = coreWith(40);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    await beatWhileWorking(core, task!.token, 200, 250);

    expect(await core.pollActivityTask()).toBeUndefined(); // never redelivered
    expect(await terminalEvents(historyStore)).toEqual([]); // and never failed
  });

  it('completes normally after outliving several lease periods', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 200};
    const {core, activityTaskQueue, historyStore} = coreWith(40);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    await beatWhileWorking(core, task!.token, 200, 250);
    await core.completeActivityTask(task!.token, {ok: true, result: 'rows'});

    const terminal = await terminalEvents(historyStore);
    expect(terminal.length).toBe(1);
    expect(terminal[0].type).toBe('activityCompleted');
  });

  /**
   * The stretched lease must not become what reaps a dead worker — that would
   * trade a duplicate run for a slower recovery, which is the trade heartbeating
   * exists to avoid.
   */
  it('is still abandoned for silence on its own deadline, not on the lease', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 60};
    const {core, activityTaskQueue, historyStore} = coreWith(40);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);

    const task = await core.pollActivityTask();
    await core.heartbeatActivityTask(task!.token); // one beat, then the worker dies
    await wait(120);

    const terminal = await terminalEvents(historyStore);
    expect(terminal.length).toBe(1);
    expect(terminal[0].type).toBe('activityFailed');
    expect(await core.pollActivityTask()).toBeUndefined(); // abandoned, not redelivered
  });
});

/**
 * The register is discarded with the attempt, but not before its last value is
 * copied onto the event that settles the seq. That is the one durable trace of
 * where an attempt got to, and it matters most for the outcomes nobody chose:
 * an agent cancelled at turn three, or abandoned for silence with a job id it
 * had already reported.
 */
describe('the last checkpoint, once the attempt settles', () => {
  async function terminal(historyStore: MemoryHistoryStore) {
    const rec = await historyStore.get('wf');
    return rec!.history.find(
      (e) =>
        e.type === 'activityCompleted' ||
        e.type === 'activityFailed' ||
        e.type === 'activityCancelled',
    ) as
      {type: string; checkpoint?: unknown; checkpointAt?: number} | undefined;
  }

  it('rides on the completion', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 200};
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);
    const task = await core.pollActivityTask();
    const before = Date.now();
    await core.heartbeatActivityTask(task!.token, {jobId: 'q-8823', pct: 90});

    await core.completeActivityTask(task!.token, {ok: true, result: 'ref-1'});

    const event = await terminal(historyStore);
    expect(event?.type).toBe('activityCompleted');
    expect(event?.checkpoint).toEqual({jobId: 'q-8823', pct: 90});
    expect(event?.checkpointAt).toBeGreaterThanOrEqual(before);
  });

  it('rides on the failure that ends the retries', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 200};
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);
    const task = await core.pollActivityTask();
    await core.heartbeatActivityTask(task!.token, {jobId: 'q-8823', pct: 55});

    await core.completeActivityTask(task!.token, {ok: false, error: 'boom'});

    const event = await terminal(historyStore);
    expect(event?.type).toBe('activityFailed');
    expect(event?.checkpoint).toEqual({jobId: 'q-8823', pct: 55});
  });

  it('rides on the cancellation the server writes for a running attempt', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 200};
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);
    const task = await core.pollActivityTask();
    await core.heartbeatActivityTask(task!.token, {turn: 3});

    await core.requestCancel('wf');

    const event = await terminal(historyStore);
    expect(event?.type).toBe('activityCancelled');
    expect(event?.checkpoint).toEqual({turn: 3});
  });

  /**
   * The attempt that went quiet is the one whose last word is worth keeping:
   * the job id it reported is how the next attempt re-attaches.
   */
  it('rides on the failure written when the attempt is abandoned for silence', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 40};
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, options);
    enqueue(activityTaskQueue, options);
    const task = await core.pollActivityTask();
    await core.heartbeatActivityTask(task!.token, {jobId: 'q-8823'});

    await wait(100); // silence past the deadline

    const event = await terminal(historyStore);
    expect(event?.type).toBe('activityFailed');
    expect(event?.checkpoint).toEqual({jobId: 'q-8823'});
  });

  it('is absent when the attempt never reported one', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith(5000);
    await seed(historyStore, {});
    enqueue(activityTaskQueue, {});
    const task = await core.pollActivityTask();

    await core.completeActivityTask(task!.token, {ok: true, result: 'ref-1'});

    const event = await terminal(historyStore);
    expect(event?.type).toBe('activityCompleted');
    expect('checkpoint' in event!).toBeFalse();
  });
});

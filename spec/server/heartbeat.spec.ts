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
 * A checkpoint is a **register, not a log**: one slot per attempt, overwritten by
 * the next beat and thrown away with the attempt. Nothing here is a history
 * event, so none of it survives the attempt that reported it — which is the point,
 * because it describes work a worker is holding rather than something that
 * happened to the execution.
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

  /**
   * An author who calls `heartbeat()` bare in one branch and with a checkpoint in
   * another is reporting liveness, not amnesia. Clearing here would let the bare
   * branch destroy what every other branch reported.
   */
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

  /**
   * The case a parallel map would get wrong. An abandoned attempt's checkpoint
   * must go with it, or `describe` reports the progress of work nobody is doing —
   * the wrong report about a dead thing this repo keeps finding.
   */
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
 * The fourth way an attempt can end. With neither timeout set, the queue lease is
 * all that bounds it, and expiry redelivers without passing any path that deletes
 * the lease — `completeActivityTask` explains why the stale entry stays. Its
 * checkpoint must not stay with it, or a dead attempt's progress is reported as
 * the live one's.
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

  /**
   * The stale lease itself must survive, because a late completion from the
   * abandoned worker is still accepted — at-least-once means that work really
   * ran, and the first outcome to arrive is the one recorded.
   */
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

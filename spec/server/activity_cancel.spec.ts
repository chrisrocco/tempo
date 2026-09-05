/**
 * @fileoverview
 * Cancellation reaching a running activity attempt, and what the server records
 * when an execution with open activities is cancelled.
 *
 * Before this, `cancel` reached the workflow and stopped there: the attempt already
 * running kept going until it finished or its lease lapsed, and — worse — a failure
 * it then reported was *retried*, against a policy written for an execution that
 * still wanted the result. For an agent turn that is another full run for nobody.
 *
 * Three mechanisms, tested here from the server's side. `requestCancel` settles
 * every open activity as `activityCancelled` the moment it records the cancel, so
 * no retry can follow and history does not read as work still in flight. The
 * heartbeat reply tells an attempt to stop — the only channel back into one, since
 * the server can only answer when the worker speaks — and says so for any attempt
 * the server no longer holds, not only a cancelled one. And a retry sitting in
 * backoff when the cancel lands is not redispatched. The worker's half — turning
 * the reply into `cancellationRequested()` and an `AbortSignal` — is
 * `spec/worker/activity_context.spec.ts`; the two joined up end to end is in
 * `spec/integration/local.spec.ts`.
 */

import type {ActivityOptions} from '../../src';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
} from '../../src/server';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function coreWith(leaseMs = 5000, historyStore = new MemoryHistoryStore()) {
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

/** An execution parked on one dispatched activity, as the server would have it. */
async function seed(
  historyStore: MemoryHistoryStore,
  activityTaskQueue: MemoryTaskQueue,
  options: ActivityOptions,
): Promise<void> {
  await historyStore.create('wf', 'w', []);
  await historyStore.append('wf', [
    {type: 'activityScheduled', seq: 0, name: 'agent', args: [], options},
  ]);
  activityTaskQueue.enqueue(
    {workflowId: 'wf', seq: 0, name: 'agent', args: [], options},
    'default',
  );
}

function terminalEvents(historyStore: MemoryHistoryStore) {
  return historyStore
    .get('wf')
    .then((rec) =>
      rec!.history.filter(
        (e) =>
          e.type === 'activityCompleted' ||
          e.type === 'activityFailed' ||
          e.type === 'activityCancelled',
      ),
    );
}

const retrying: ActivityOptions = {
  retry: {maximumAttempts: 3, initialIntervalMs: 1},
};

describe('the heartbeat reply', () => {
  it('says to keep going while the execution is running', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith();
    await seed(historyStore, activityTaskQueue, {});
    const task = await core.pollActivityTask();

    expect(await core.heartbeatActivityTask(task!.token)).toEqual({
      cancelRequested: false,
    });
  });

  /**
   * The headline: the attempt was mid-flight when the operator cancelled, and its
   * next beat is how it finds out. Nothing else in the system can tell it.
   */
  it('says to stop once the execution is cancelled', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith();
    await seed(historyStore, activityTaskQueue, {});
    const task = await core.pollActivityTask();

    await core.requestCancel('wf');

    expect(await core.heartbeatActivityTask(task!.token)).toEqual({
      cancelRequested: true,
    });
  });

  it('does not redeliver the attempt it told to stop', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith(40);
    await seed(historyStore, activityTaskQueue, {});
    const task = await core.pollActivityTask();
    await core.requestCancel('wf');

    await wait(60); // past the lease the attempt no longer holds
    await core.heartbeatActivityTask(task!.token);

    // A second worker running the same turn would be the duplicate the lease
    // exists to prevent, and there is no execution left to want it.
    expect(await core.pollActivityTask()).toBeUndefined();
  });

  /**
   * "Your execution is cancelled" and "the server gave up on you" are different
   * stories on the server and the same instruction to the attempt: nothing it
   * reports will be consumed, and one abandoned by a deadline that keeps going
   * is the duplicate the deadline existed to prevent. One flag, one decision.
   */
  it('also says to stop to an attempt the server gave up on', async () => {
    const options: ActivityOptions = {heartbeatTimeoutMs: 30};
    const {core, activityTaskQueue, historyStore} = coreWith();
    await seed(historyStore, activityTaskQueue, options);
    const task = await core.pollActivityTask();
    await wait(80); // abandoned for silence; nothing was cancelled

    expect(await core.heartbeatActivityTask(task!.token)).toEqual({
      cancelRequested: true,
    });
  });

  it('says to stop for a token the server never issued', async () => {
    const {core} = coreWith();

    expect(await core.heartbeatActivityTask('act-never-issued')).toEqual({
      cancelRequested: true,
    });
  });
});

describe('cancelling an execution with an activity open', () => {
  /**
   * Recorded at once, by the server, rather than when the attempt reports: from
   * the moment the cancel is applied nothing can consume the result, and an
   * `activityScheduled` with no terminal event would read as work still in
   * flight for an execution that is over.
   */
  it('settles the activity as cancelled the moment the cancel is recorded', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith();
    await seed(historyStore, activityTaskQueue, retrying);
    await core.pollActivityTask();

    await core.requestCancel('wf');

    const rec = await historyStore.get('wf');
    expect(rec!.history.map((e) => e.type)).toEqual([
      'activityScheduled',
      'activityStarted',
      'cancelRequested',
      'activityCancelled',
    ]);
    expect(await terminalEvents(historyStore)).toEqual([
      jasmine.objectContaining({
        type: 'activityCancelled',
        seq: 0,
        error: 'execution cancelled',
      }),
    ]);
  });

  /**
   * The bug this closes. Three attempts were allowed and the first failed, so the
   * server scheduled a second — for an execution whose workflow had already been
   * handed `CancelledFailure` and would never read the result.
   */
  it('never retries it, whatever the policy allows', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith();
    await seed(historyStore, activityTaskQueue, retrying);
    const task = await core.pollActivityTask();
    await core.requestCancel('wf');

    // The attempt heard, stopped, and reports so — a straggler now, turned away.
    await core.completeActivityTask(task!.token, {
      ok: false,
      error: 'The operation was aborted',
      cancelled: true,
    });
    await wait(20); // past the backoff a retry would have used

    expect(await core.pollActivityTask()).toBeUndefined();
    const rec = await historyStore.get('wf');
    expect(
      rec!.history.some((e) => e.type === 'activityRetryScheduled'),
    ).toBeFalse();
    expect((await terminalEvents(historyStore)).length).toBe(1);
  });

  /**
   * The cancel can land during a backoff, with no attempt out at all. The timer
   * armed for the next attempt is the window in which the activity stops being
   * wanted, so it re-reads the store when it fires rather than trusting the
   * decision it was armed with.
   */
  it('does not redispatch a retry that was waiting in backoff', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith();
    await seed(historyStore, activityTaskQueue, {
      retry: {maximumAttempts: 3, initialIntervalMs: 30},
    });
    const task = await core.pollActivityTask();
    await core.completeActivityTask(task!.token, {ok: false, error: 'flaky'});
    // In backoff now: no attempt out, one retry armed.
    expect(await core.pollActivityTask()).toBeUndefined();

    await core.requestCancel('wf');
    await wait(60); // the retry timer fires into a cancelled execution

    expect(await core.pollActivityTask()).toBeUndefined();
    expect(await terminalEvents(historyStore)).toEqual([
      jasmine.objectContaining({type: 'activityCancelled', seq: 0}),
    ]);
  });

  /**
   * A success that arrives after the cancel is a straggler like any other report
   * for a settled seq. History keeps the cancellation: the settlement the server
   * wrote is the disposition, and the attempt's own outcome has no consumer.
   */
  it('keeps the cancellation when the attempt finishes anyway', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith();
    await seed(historyStore, activityTaskQueue, retrying);
    const task = await core.pollActivityTask();
    await core.requestCancel('wf');

    await core.completeActivityTask(task!.token, {ok: true, result: 'done'});

    expect(await terminalEvents(historyStore)).toEqual([
      jasmine.objectContaining({type: 'activityCancelled', seq: 0}),
    ]);
  });

  /**
   * The in-flight window: a report that passed its lease check before the cancel
   * landed, and reaches the store after. Whatever it said, the cancel decided the
   * activity's fate, and the second settlement is the one that gets dropped.
   */
  it('records a report already in flight as cancelled, not failed', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith();
    await seed(historyStore, activityTaskQueue, retrying);
    await core.pollActivityTask();
    // Seen by the server with the cancel already in history and the seq not yet
    // settled — the state a report caught between the two appends observes.
    await historyStore.append('wf', [{type: 'cancelRequested'}]);

    await core.reportActivityResult('wf', 0, {
      ok: false,
      error: 'connection reset by peer',
    });

    expect(await terminalEvents(historyStore)).toEqual([
      jasmine.objectContaining({
        type: 'activityCancelled',
        error: 'connection reset by peer',
      }),
    ]);
    const rec = await historyStore.get('wf');
    expect(
      rec!.history.some((e) => e.type === 'activityRetryScheduled'),
    ).toBeFalse();
  });

  /** Sanity: the same failure before any cancel is retried exactly as before. */
  it('contrasts with a failure before the cancel, which is retried', async () => {
    const {core, activityTaskQueue, historyStore} = coreWith();
    await seed(historyStore, activityTaskQueue, retrying);
    const task = await core.pollActivityTask();

    await core.completeActivityTask(task!.token, {ok: false, error: 'flaky'});
    await wait(20);

    expect(await terminalEvents(historyStore)).toEqual([]);
    expect(await core.pollActivityTask()).toBeDefined(); // the second attempt
  });
});

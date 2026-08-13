/**
 * @fileoverview
 * What happens to a timer when the execution waiting on it stops waiting.
 *
 * Reported from a dashboard: a parent that loops forever sleeping between child runs was
 * cancelled, unwound through `CancelledFailure` — and its timer was still shown as open
 * afterwards.
 *
 * Two separate things were wrong, and neither was the one the symptom suggested.
 *
 * **The report.** `pendingWork` derives "pending" from history: a `timerStarted` with no
 * `timerFired`. History cannot say "and then the execution died", so a cancelled sleeper
 * reported that timer as pending forever. `describeExecution` now derives pending only
 * while the execution is running.
 *
 * **The timer itself.** Nothing released it. `timerService.cancel` was called from the
 * reset path and nowhere else, so an armed timer outlived the execution until its own
 * fire time — an hour, for an hour-long sleep, and long sleeps in cancelled executions is
 * exactly the scheduler shape.
 *
 * Neither was a correctness bug, and that is worth stating rather than assuming: a fire
 * for a settled execution was already dropped by `onFire`, and `resumeFromHistory` already
 * skipped non-running records. The first spec below pins that, so the cleanup added here
 * is understood as hygiene rather than as the thing standing between a timer and
 * corruption.
 */

import {createLocalRuntime} from '../../src';
import {
  MemoryHistoryStore,
  MemoryTaskQueue,
  MemoryTimerService,
  MemoryWorkflowTaskQueue,
  createServerCore,
} from '../../src/server';
import {sleep} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** The reported shape: loop forever, sleeping between rounds. */
function sleeper(store: MemoryHistoryStore) {
  return createLocalRuntime({historyStore: store}).registerWorkflow(
    'sleeper',
    async () => {
      for (;;) await sleep(3_600_000);
    },
  );
}

describe('a settled execution and its timer', () => {
  it('stops reporting the timer as pending once it is cancelled', async () => {
    const store = new MemoryHistoryStore();
    const rt = sleeper(store);
    const handle = rt.start('sleeper', [], {workflowId: 'p1'});
    await wait(80);

    // Waiting, and honestly reporting it.
    const running = await rt.service.describeExecution('p1');
    expect(running?.status).toBe('running');
    expect(running?.pending.timers.length).toBe(1);

    handle.cancel();
    await wait(120);

    const settled = await rt.service.describeExecution('p1');
    expect(settled?.status).not.toBe('running');
    expect(settled?.pending.timers).toEqual([]);
    rt.shutdown();
  });

  /**
   * The history is untouched, which is the half that must not be lost: "what was it
   * waiting on when it died" is a real postmortem question, and the honest place for
   * that answer is the event log rather than a field named `pending`.
   */
  it('keeps the timerStarted in history for the postmortem', async () => {
    const store = new MemoryHistoryStore();
    const rt = sleeper(store);
    const handle = rt.start('sleeper', [], {workflowId: 'p2'});
    await wait(80);
    handle.cancel();
    await wait(120);

    const rec = await store.get('p2');
    expect(rec?.history.map((e) => e.type)).toEqual([
      'timerStarted',
      'cancelRequested',
    ]);
    rt.shutdown();
  });

  // `cancelRequested` survives the suppression: it says what happened to the execution,
  // not what it is still owed.
  it('still reports that a cancel was requested', async () => {
    const store = new MemoryHistoryStore();
    const rt = sleeper(store);
    const handle = rt.start('sleeper', [], {workflowId: 'p3'});
    await wait(80);
    handle.cancel();
    await wait(120);

    expect((await rt.service.describeExecution('p3'))?.cancelRequested).toBe(
      true,
    );
    rt.shutdown();
  });
});

describe('the timer table when an execution settles', () => {
  /** A core wired to a timer service the spec can inspect. */
  function coreWith(
    timerService: MemoryTimerService,
    store: MemoryHistoryStore,
  ) {
    return createServerCore({
      historyStore: store,
      workflowTaskQueue: new MemoryWorkflowTaskQueue(),
      activityTaskQueue: new MemoryTaskQueue(),
      timerService,
      launch: () => {},
      kickWorkflowWorker: () => {},
      kickActivityWorker: () => {},
      log: () => {},
    });
  }

  /** How many timers the service still holds for anyone. */
  function armed(timerService: MemoryTimerService): number {
    return (timerService as unknown as {timers: Map<string, unknown>}).timers
      .size;
  }

  it('releases the timers an execution was holding', async () => {
    const store = new MemoryHistoryStore();
    const timerService = new MemoryTimerService();
    const core = coreWith(timerService, store);

    await store.create('t1', 'w', [], 'default');
    await core.applyWorkflowTaskResult('t1', {
      done: false,
      result: undefined,
      failed: false,
      failure: undefined,
      commands: [{type: 'startTimer', ms: 3_600_000, seq: 0}],
      carryover: {},
      parked: [],
    });
    expect(armed(timerService)).toBe(1);

    await core.terminate('t1', 'operator pulled it');

    expect(armed(timerService)).toBe(0);
    timerService.stop();
  });

  /**
   * Not a correctness fix, and this is the spec that says so. Before the cleanup a
   * surviving timer was harmless: `onFire` drops a fire for a record that is no longer
   * running, appending nothing and waking nothing. The cleanup stops it being *held*,
   * which is a resource question.
   */
  it('would have been harmless anyway: a fire for a settled execution is dropped', async () => {
    const store = new MemoryHistoryStore();
    const timerService = new MemoryTimerService();
    const core = coreWith(timerService, store);

    await store.create('t2', 'w', [], 'default');
    await core.applyWorkflowTaskResult('t2', {
      done: false,
      result: undefined,
      failed: false,
      failure: undefined,
      commands: [{type: 'startTimer', ms: 5, seq: 0}],
      carryover: {},
      parked: [],
    });
    await core.terminate('t2', 'gone');
    const historyAtSettle = (await store.get('t2'))?.history.length ?? 0;

    // Well past when the timer would have fired had it survived.
    await wait(40);

    expect((await store.get('t2'))?.history.length).toBe(historyAtSettle);
    expect(
      (await store.get('t2'))?.history.some((e) => e.type === 'timerFired'),
    ).toBe(false);
    timerService.stop();
  });

  it('leaves other executions alone', async () => {
    const store = new MemoryHistoryStore();
    const timerService = new MemoryTimerService();
    const core = coreWith(timerService, store);

    for (const id of ['a', 'b']) {
      await store.create(id, 'w', [], 'default');
      await core.applyWorkflowTaskResult(id, {
        done: false,
        result: undefined,
        failed: false,
        failure: undefined,
        commands: [{type: 'startTimer', ms: 3_600_000, seq: 0}],
        carryover: {},
        parked: [],
      });
    }
    expect(armed(timerService)).toBe(2);

    await core.terminate('a', 'gone');

    expect(armed(timerService)).toBe(1);
    timerService.stop();
  });
});

// A workflow that settles normally holds no timer either — the cleanup is on the
// disposition, not on cancellation specifically.
describe('a completed execution', () => {
  it('leaves nothing armed', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store}).registerWorkflow(
      'brief',
      async () => {
        await sleep(5);
        return 'done';
      },
    );

    await rt.start('brief', [], {workflowId: 'c1'}).result();
    const detail = await rt.service.describeExecution('c1');

    expect(detail?.status).toBe('completed');
    expect(detail?.pending.timers).toEqual([]);
    rt.shutdown();
  });
});

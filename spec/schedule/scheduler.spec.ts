/**
 * @fileoverview
 * The scheduler workflow, against a real runtime.
 *
 * These are behaviour specs: each `it` states one guarantee a person relying on a
 * schedule would state. Mostly short intervals — a schedule firing every 40ms is the
 * same mechanism as one firing nightly, and what is under test is *what* fires and
 * *when it does not*, never duration.
 *
 * Two specs deliberately use a long one instead. Interval length is not a neutral test
 * parameter here: it decides how much of a run is spent parked, and therefore whether a
 * signal arrives during a rollover (issue #82). Where a spec is about signals, the
 * realistic long interval is the honest choice rather than the convenient short one.
 *
 * The properties worth the most attention are the negative ones. A schedule that fires
 * too often is noticed immediately; one that silently skips a boundary, or keeps
 * firing after being paused, is the failure that goes unnoticed for a week.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import {isolateActivityRegistry} from '../support/isolate_activity_registry';
import {scheduler} from '../../src/schedule/scheduler.workflow';
import type {ScheduleDefinition, ScheduleStatus} from '../../src/protocol';
import {nextFire} from '../../src/schedule/activities';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** A runtime holding the scheduler plus a target that records each run it gets. */
function runtimeWith(store: MemoryHistoryStore, ran: string[]) {
  return createLocalRuntime({historyStore: store})
    .registerActivity('nextFire', nextFire)
    .registerWorkflow('scheduler', scheduler)
    .registerWorkflow('target', async (label: string) => {
      ran.push(label ?? 'run');
      return 'ok';
    });
}

const definition = (
  over: Partial<ScheduleDefinition> = {},
): ScheduleDefinition => ({
  spec: {type: 'interval', everyMs: 40},
  target: {name: 'target', args: ['run']},
  ...over,
});

/** The status the schedule's *current* run started with. */
async function statusOf(
  store: MemoryHistoryStore,
  id: string,
): Promise<ScheduleStatus | undefined> {
  const rec = await store.get(id);
  return rec?.carryover['schedule'] as ScheduleStatus | undefined;
}

describe('the scheduler workflow', () => {
  isolateActivityRegistry();

  it('starts its target on the interval, more than once', async () => {
    const store = new MemoryHistoryStore();
    const ran: string[] = [];
    runtimeWith(store, ran).start('scheduler', definition(), {
      workflowId: 'sched-1',
    });
    await wait(300);

    expect(ran.length).toBeGreaterThan(1);
  });

  /**
   * Each fire claims an id built from its boundary, which is what makes a repeated
   * fire land on one execution rather than running the work twice. The ids also say
   * the boundaries were distinct — a scheduler stuck on one boundary would re-claim a
   * single id and look, from run counts alone, like a schedule that had stopped.
   */
  it('names each run after its boundary, so a repeat claims one execution', async () => {
    const store = new MemoryHistoryStore();
    const ran: string[] = [];
    runtimeWith(store, ran).start('scheduler', definition(), {
      workflowId: 'sched-2',
    });
    await wait(300);

    const status = await statusOf(store, 'sched-2');
    const ids = (status?.recent ?? []).map((r) => r.targetId);
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids) expect(id).toMatch(/^sched-2-\d+$/);
    // Distinct boundaries, therefore distinct executions.
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Rolling over every cycle is what keeps this current: carryover reports what a run
  // started with, so a scheduler looping many cycles per run would show a status
  // frozen at whenever that run began.
  it('keeps its status readable while it is still running', async () => {
    const store = new MemoryHistoryStore();
    runtimeWith(store, []).start('scheduler', definition(), {
      workflowId: 'sched-3',
    });
    await wait(300);

    const status = await statusOf(store, 'sched-3');
    expect(status).toBeDefined();
    expect(status!.handledThroughMs).toBeGreaterThan(0);
    expect(status!.recent.length).toBeGreaterThan(0);
    expect((await store.get('sched-3'))?.status).toBe('running');
  });

  it('bounds the run list rather than growing carryover without limit', async () => {
    const store = new MemoryHistoryStore();
    // Fast enough to exceed the limit of 20 well inside the window.
    runtimeWith(store, []).start(
      'scheduler',
      definition({spec: {type: 'interval', everyMs: 1}}),
      {workflowId: 'sched-4'},
    );
    await wait(600);

    const status = await statusOf(store, 'sched-4');
    expect(status!.recent.length).toBeLessThanOrEqual(20);
    // Still alive: an unbounded list would eventually exceed MAX_CARRYOVER_BYTES and
    // the worker would refuse the run outright.
    expect((await store.get('sched-4'))?.status).toBe('running');
  });
});

describe('a paused schedule', () => {
  isolateActivityRegistry();

  it('starts nothing while paused', async () => {
    const store = new MemoryHistoryStore();
    const ran: string[] = [];
    runtimeWith(store, ran).start('scheduler', definition({paused: true}), {
      workflowId: 'sched-5',
    });
    await wait(300);

    expect(ran).toEqual([]);
    expect((await store.get('sched-5'))?.status).toBe('running');
  });

  it('holds no timer, so pausing costs nothing and lasts', async () => {
    const store = new MemoryHistoryStore();
    runtimeWith(store, []).start('scheduler', definition({paused: true}), {
      workflowId: 'sched-6',
    });
    await wait(200);

    const history = (await store.get('sched-6'))!.history;
    expect(history.filter((e) => e.type === 'timerStarted').length).toBe(0);
  });

  it('resumes on a signal and fires again', async () => {
    const store = new MemoryHistoryStore();
    const ran: string[] = [];
    const rt = runtimeWith(store, ran);
    const handle = rt.start('scheduler', definition({paused: true}), {
      workflowId: 'sched-7',
    });
    await wait(120);
    expect(ran).toEqual([]);

    handle.signal('resumeSchedule');
    await wait(300);

    expect(ran.length).toBeGreaterThan(0);
  });

  /**
   * Pausing a schedule that is *sleeping* works, which is every schedule anyone would
   * actually create: an hourly or nightly one spends essentially its whole run parked
   * on a timer, so a signal always finds a run to be delivered to.
   *
   * A long interval here for exactly that reason — it is the realistic case, and the
   * one whose behaviour can be asserted without asserting a race. See the note below.
   */
  it('stops firing when paused mid-sleep', async () => {
    const store = new MemoryHistoryStore();
    const ran: string[] = [];
    const rt = runtimeWith(store, ran);
    const handle = rt.start(
      'scheduler',
      definition({spec: {type: 'interval', everyMs: 3_600_000}}),
      {workflowId: 'sched-8'},
    );
    await wait(120);
    handle.signal('pauseSchedule');

    // Waited on *state* rather than a duration: a fixed grace period is a flake, since
    // a loaded queue takes longer to apply the pause and roll over.
    for (let i = 0; i < 60; i++) {
      if ((await statusOf(store, 'sched-8'))?.paused === true) break;
      await wait(25);
    }
    // The pause is seen mid-sleep, because `condition` re-evaluates at every
    // activation rather than only when the timer fires.
    expect((await statusOf(store, 'sched-8'))?.paused).toBe(true);

    const afterPause = ran.length;
    await wait(300);
    expect(ran.length).toBe(afterPause);
  });

  /*
   * There is deliberately no spec here for the fast-rollover case, and the absence is
   * the point.
   *
   * A rollover empties history, and an unconsumed `signal` event goes with it — so a
   * signal arriving between its own append and the application of the task result that
   * rolls the run over is destroyed silently (issue #82, measured). The window is the
   * fraction of a run spent *not* parked, which is negligible for the hourly schedule
   * above and grows as the interval shrinks.
   *
   * It is a **race**, not a certainty: at a 40ms interval the pause is sometimes lost
   * and sometimes delivered, depending on how loaded the process is. A spec asserting
   * either outcome is a spec asserting a coin flip, so there is none. #82 carries the
   * evidence and the fix; when it lands, the window closes and nothing here has to
   * change.
   */
});

describe('a manually triggered schedule', () => {
  isolateActivityRegistry();

  it('fires immediately, without waiting for a boundary', async () => {
    const store = new MemoryHistoryStore();
    const ran: string[] = [];
    const rt = runtimeWith(store, ran);
    // An interval far longer than this test, so nothing can fire on schedule.
    const handle = rt.start(
      'scheduler',
      definition({spec: {type: 'interval', everyMs: 3_600_000}}),
      {workflowId: 'sched-9'},
    );
    await wait(80);
    expect(ran).toEqual([]);

    handle.signal('triggerSchedule');
    await wait(250);

    expect(ran.length).toBe(1);
    const status = await statusOf(store, 'sched-9');
    expect(status!.recent[0]?.manual).toBe(true);
    expect(status!.recent[0]?.targetId).toBe('sched-9-manual-1');
  });

  // A trigger on a paused schedule is the "run it now" an operator reaches for when a
  // nightly job failed — pausing must not disable it.
  it('fires even while paused', async () => {
    const store = new MemoryHistoryStore();
    const ran: string[] = [];
    const rt = runtimeWith(store, ran);
    const handle = rt.start('scheduler', definition({paused: true}), {
      workflowId: 'sched-10',
    });
    await wait(80);

    handle.signal('triggerSchedule');
    await wait(250);

    expect(ran.length).toBe(1);
    // Still paused afterwards: a trigger is one run, not a resume.
    expect((await statusOf(store, 'sched-10'))!.paused).toBe(true);
  });

  it('gives each trigger its own id, so asking twice runs twice', async () => {
    const store = new MemoryHistoryStore();
    const ran: string[] = [];
    const rt = runtimeWith(store, ran);
    const handle = rt.start(
      'scheduler',
      definition({
        spec: {type: 'interval', everyMs: 3_600_000},
        paused: true,
      }),
      {workflowId: 'sched-11'},
    );
    await wait(80);

    handle.signal('triggerSchedule');
    await wait(150);
    handle.signal('triggerSchedule');
    await wait(250);

    expect(ran.length).toBe(2);
    const ids = (await statusOf(store, 'sched-11'))!.recent.map(
      (r) => r.targetId,
    );
    expect(new Set(ids)).toEqual(
      new Set(['sched-11-manual-1', 'sched-11-manual-2']),
    );
  });
});

describe('a schedule with bounds', () => {
  isolateActivityRegistry();

  /**
   * A finished schedule completes rather than sleeping forever. The distinction is for
   * whoever is looking: a completed execution says "this is over", where one asleep
   * indefinitely is indistinguishable from one that is broken.
   */
  it('completes once its bounds are exhausted', async () => {
    const store = new MemoryHistoryStore();
    const ran: string[] = [];
    runtimeWith(store, ran).start(
      'scheduler',
      definition({
        spec: {type: 'interval', everyMs: 40},
        // A window in the past: there is no boundary left to fire, ever.
        bounds: {notAfterMs: 1_000},
      }),
      {workflowId: 'sched-12'},
    );
    await wait(250);

    const rec = await store.get('sched-12');
    expect(rec?.status).toBe('completed');
    expect(rec?.result).toBe('exhausted');
    expect(ran).toEqual([]);
  });
});

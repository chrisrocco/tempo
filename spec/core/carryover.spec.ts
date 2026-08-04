/**
 * @fileoverview
 * Carryover: state a workflow keeps across its own runs without putting it in
 * its signature.
 *
 * The property that justifies the feature is the third test — surviving
 * continue-as-new. Everything a workflow knows normally lives in history, and
 * continue-as-new erases history; the arguments are the only other thing that
 * crosses, and requiring a helper's state to go there is what forces an
 * implementation detail into the caller's signature.
 *
 * The size cap has a test of its own because it is the guard against the one
 * predictable abuse — keeping a set of every item ever seen — and a guard that
 * does not fire is worse than none.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import {
  clearCarryover,
  continueAsNew,
  getCarryover,
  runActivity,
  setCarryover,
  sleep,
  workflowInfo,
} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('carryover', () => {
  /**
   * The load-bearing property, and the counter-intuitive one. A write is for the
   * *next* run; within this run every read keeps returning what the run started
   * with, however many tasks it takes.
   *
   * It has to work this way. Every task re-runs the workflow from line one, so a
   * read that could see an earlier task's write would make this task's commands
   * depend on state that is not in history — and replay would diverge from what
   * history records. The next test is that failure, made concrete.
   */
  it('does not show a write to a later read in the same run', async () => {
    const rt = createLocalRuntime()
      .registerActivity('noop', () => 'ok')
      .registerWorkflow('wf', async () => {
        setCarryover('cursor', 41);
        await runActivity('noop'); // suspend and resume across a task boundary
        return getCarryover<number>('cursor') ?? 'still unset';
      });

    await expectAsync(rt.start<string>('wf').result()).toBeResolvedTo(
      'still unset',
    );
    rt.shutdown();
  });

  /**
   * The regression test for why reads are run-scoped.
   *
   * This workflow branches on carryover to choose an activity argument — the
   * shape any cursor-driven poller has. With per-task reads the second task
   * passed a different argument than history recorded, and the execution wedged
   * on `nondeterminism at seq N` while looking merely "running".
   */
  it('lets a workflow branch on carryover without breaking replay', async () => {
    const store = new MemoryHistoryStore();
    const seen: (number | undefined)[] = [];
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('fetch', (since?: number) => {
        seen.push(since);
        return since === undefined ? [1, 2, 3] : [];
      })
      .registerWorkflow('wf', async () => {
        const since = getCarryover<number>('cursor');
        const items = await runActivity<number[]>('fetch', since);
        if (items.length > 0) setCarryover('cursor', items[items.length - 1]);
        await sleep(5);
        return `saw ${items.length}`;
      });

    await expectAsync(
      rt.start<string>('wf', [], {workflowId: 'wf-1'}).result(),
    ).toBeResolvedTo('saw 3');

    const rec = await store.get('wf-1');
    expect(rec!.taskFailures).toBe(0); // no nondeterminism
    expect(rec!.status).toBe('completed');
    rt.shutdown();
  });

  it('starts empty, so an unwritten key reads as undefined', async () => {
    const rt = createLocalRuntime().registerWorkflow('wf', async () =>
      getCarryover('never-written'),
    );

    await expectAsync(rt.start('wf').result()).toBeResolvedTo(undefined);
    rt.shutdown();
  });

  /**
   * The reason this exists. A workflow's state normally lives in history, and
   * continue-as-new erases history — so without this, a helper that needs to
   * remember something across a rollover has to make the caller carry it as an
   * argument.
   */
  it('survives continue-as-new', async () => {
    const rt = createLocalRuntime()
      .registerActivity('noop', () => 'ok')
      .registerWorkflow('wf', async () => {
        const runs = (getCarryover<number>('runs') ?? 0) + 1;
        setCarryover('runs', runs);
        if (runs >= 3) return `ran ${runs} times`;
        await runActivity('noop');
        return continueAsNew();
      });

    await expectAsync(rt.start<string>('wf').result()).toBeResolvedTo(
      'ran 3 times',
    );
    rt.shutdown();
  });

  /**
   * The record's carryover is what every task of a run is built from, so it must
   * not move while the run is in flight — that is precisely what would let two
   * tasks of one run disagree. Writes wait for the rollover.
   */
  it('leaves the stored value alone until the run rolls over', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('noop', () => 'ok')
      .registerWorkflow('wf', async () => {
        setCarryover('cursor', 'written');
        await runActivity('noop');
        await sleep(10_000); // park here, with no rollover in sight
        return 'unreachable';
      });

    rt.start('wf', [], {workflowId: 'wf-1'});
    await wait(60);

    const rec = await store.get('wf-1');
    expect(rec!.carryover).toEqual({}); // unchanged mid-run
    expect(rec!.status).toBe('running');
    rt.shutdown();
  });

  // Across a rollover, because that is the only place carryover is adopted —
  // asserting on a run that never rolls over would pass against an empty record
  // whether or not clearing worked at all.
  it('drops a cleared key rather than carrying it forward', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('noop', () => 'ok')
      .registerWorkflow('wf', async () => {
        const run = (getCarryover<number>('run') ?? 0) + 1;
        setCarryover('run', run);
        if (run === 1) setCarryover('temp', 'here');
        else clearCarryover('temp');
        await runActivity('noop');
        if (run >= 3) return 'done';
        return continueAsNew();
      });

    await rt.start('wf', [], {workflowId: 'wf-1'}).result();

    const rec = await store.get('wf-1');
    // 2, not 3: carryover is adopted at a rollover, and the third run *completed*
    // rather than rolling over — there is no next run to adopt it for. So the
    // stored value is what run 2 left for run 3.
    expect(rec!.carryover['run']).toBe(2); // the rollovers really happened
    expect('temp' in rec!.carryover).toBeFalse(); // and the key did not survive
    rt.shutdown();
  });

  /**
   * The guard against the abuse the feature invites: a set of every item ever
   * processed. It fails the workflow *task*, so the execution keeps running and
   * a corrected deploy recovers it — the same policy as any other task failure.
   */
  it('fails the task when carryover outgrows the cap', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store}).registerWorkflow(
      'hoarder',
      async () => {
        setCarryover('everything-ever-seen', 'x'.repeat(20_000));
        return 'done';
      },
    );

    rt.start('hoarder', [], {workflowId: 'wf-1'});
    await wait(80);

    const rec = await store.get('wf-1');
    expect(rec!.status).toBe('running'); // not settled — retried, per policy
    expect(rec!.taskFailures).toBeGreaterThan(0);
    expect(rec!.lastTaskFailure).toContain('carryover');
    // The message has to name the culprit, or it sends the reader hunting.
    expect(rec!.lastTaskFailure).toContain('everything-ever-seen');
    rt.shutdown();
  });

  /**
   * A read-modify-write increments once per *run*, not once per task, because
   * the read is the run's seed. Without that, the count would follow how many
   * tasks the execution happened to take — an artefact of scheduling rather than
   * anything the author wrote.
   */
  it('increments once per run, however many tasks the run takes', async () => {
    const rt = createLocalRuntime()
      .registerActivity('noop', () => 'ok')
      .registerWorkflow('wf', async () => {
        const runs = (getCarryover<number>('runs') ?? 0) + 1;
        setCarryover('runs', runs);
        // Three task boundaries in one run; the count must still be 1.
        await runActivity('noop');
        await runActivity('noop');
        await sleep(5);
        if (runs >= 2) return `ran ${runs} times`;
        return continueAsNew();
      });

    await expectAsync(rt.start<string>('wf').result()).toBeResolvedTo(
      'ran 2 times',
    );
    rt.shutdown();
  });

  it('is inert on the read side for a workflow that never writes', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store}).registerWorkflow(
      'plain',
      async () => (workflowInfo().continueAsNewSuggested ? 'hint' : 'no hint'),
    );

    await rt.start('plain', [], {workflowId: 'wf-1'}).result();

    expect(await store.get('wf-1').then((r) => r!.carryover)).toEqual({});
    rt.shutdown();
  });
});

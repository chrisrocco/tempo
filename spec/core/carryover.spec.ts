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
  it('reads back what was written, later in the same run', async () => {
    const rt = createLocalRuntime()
      .registerActivity('noop', () => 'ok')
      .registerWorkflow('wf', async () => {
        setCarryover('cursor', 41);
        await runActivity('noop'); // suspend and resume across a task boundary
        return getCarryover<number>('cursor')! + 1;
      });

    await expectAsync(rt.start<number>('wf').result()).toBeResolvedTo(42);
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

  it('is written to the record on every task, not only at a rollover', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('noop', () => 'ok')
      .registerWorkflow('wf', async () => {
        setCarryover('cursor', 'first');
        await runActivity('noop');
        setCarryover('cursor', 'second');
        await sleep(10_000); // park here, with no rollover in sight
        return 'unreachable';
      });

    rt.start('wf', [], {workflowId: 'wf-1'});
    await wait(60);

    // A crash here must not lose the write, and `describe` must not show stale
    // state — both follow from the record already holding it.
    const rec = await store.get('wf-1');
    expect(rec!.carryover['cursor']).toBe('second');
    expect(rec!.status).toBe('running');
    rt.shutdown();
  });

  it('drops a cleared key rather than carrying it forward', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('noop', () => 'ok')
      .registerWorkflow('wf', async () => {
        setCarryover('temp', 'here');
        await runActivity('noop');
        clearCarryover('temp');
        return 'done';
      });

    await rt.start('wf', [], {workflowId: 'wf-1'}).result();

    const rec = await store.get('wf-1');
    expect('temp' in rec!.carryover).toBeFalse();
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
   * The subtlest thing about carryover, and the reason writes are suppressed
   * during replay.
   *
   * Every task re-runs the workflow from its first line. If a replayed write
   * applied, this read-modify-write would run once per *task* rather than once
   * where it is written — the counter would count tasks, and its value would
   * depend on how the execution happened to be scheduled rather than on its
   * history. Written before the activity and read after it, this returns 1 only
   * because the second task's pass over the same line is suppressed.
   */
  it('applies a write once, not once per task that replays it', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store})
      .registerActivity('noop', () => 'ok')
      .registerWorkflow('wf', async () => {
        const seen = getCarryover<number>('n') ?? 0;
        setCarryover('n', seen + 1);
        await runActivity('noop');
        return getCarryover<number>('n');
      });

    // One task per replay; the count must reflect tasks, not replays-within-task.
    const result = await rt
      .start<number>('wf', [], {workflowId: 'wf-1'})
      .result();
    expect(result).toBe(1);
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

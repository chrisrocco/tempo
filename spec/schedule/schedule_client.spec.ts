/**
 * @fileoverview
 * `ScheduleClient` against a running engine — the whole feature, end to end.
 *
 * This is the spec that would have caught the assembly being wrong: the scheduler
 * registered under a name the client does not start, a run-id convention `listRuns`
 * cannot match, a status the dashboard cannot read. Each of those is invisible to the
 * unit specs on either side and fatal in use.
 *
 * The runtime here registers `scheduleWorkflows` exactly as a consumer's worker would,
 * so if that bundle is insufficient — a missing activity, a mismatched name — these
 * fail rather than something in production doing so.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import {isolateActivityRegistry} from '../support/isolate_activity_registry';
import {
  createScheduleClient,
  nextFire,
  scheduleWorkflows,
  type ScheduleDefinition,
} from '../../src/schedule';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** A runtime wired the way a consumer wires one, plus a target that records its runs. */
function harness(ran: string[]) {
  const store = new MemoryHistoryStore();
  const rt = createLocalRuntime({historyStore: store})
    // The activity the scheduler declares. A worker gets it from the workflow module's
    // `proxyActivities` call; the local runtime is registered explicitly.
    .registerActivity('nextFire', nextFire)
    .registerWorkflow('target', async () => {
      ran.push('run');
      return 'ok';
    });
  for (const [name, fn] of Object.entries(scheduleWorkflows))
    rt.registerWorkflow(name, fn);
  // Over the runtime's own service seam — the same object a remote caller would get
  // from `createRemoteService`, so this client is not a local-only construction.
  return {store, rt, client: createScheduleClient(rt.service)};
}

const hourly: ScheduleDefinition = {
  spec: {type: 'interval', everyMs: 3_600_000},
  target: {name: 'target'},
};
const fast: ScheduleDefinition = {
  spec: {type: 'interval', everyMs: 40},
  target: {name: 'target'},
};

describe('ScheduleClient', () => {
  isolateActivityRegistry();

  it('creates a schedule that actually fires', async () => {
    const ran: string[] = [];
    const {client} = harness(ran);

    client.create('sc-1', fast);
    await wait(300);

    expect(ran.length).toBeGreaterThan(1);
  });

  /**
   * The assembly check. `create` starts a workflow by name and the worker registers one
   * by name; if those disagree the schedule is an execution that never runs, and nothing
   * on either side of the seam would notice.
   */
  it('finds its own schedules in a listing', async () => {
    const {client} = harness([]);

    client.create('sc-2', hourly);
    client.create('sc-3', hourly);
    await wait(120);

    const ids = (await client.list()).map((s) => s.scheduleId).sort();
    expect(ids).toEqual(['sc-2', 'sc-3']);
  });

  it('rejects a bad spec instead of starting a doomed workflow', async () => {
    const {client} = harness([]);

    expect(() =>
      client.create('sc-4', {
        spec: {type: 'interval', everyMs: 0},
        target: {name: 'target'},
      }),
    ).toThrowError(/cannot create schedule "sc-4".*positive integer/);

    // Nothing was started, which is the point — a rejected spec leaves no execution to
    // find and clean up later.
    expect(await client.list()).toEqual([]);
  });

  it('describes the definition and the status separately', async () => {
    const ran: string[] = [];
    const {client} = harness(ran);

    client.create('sc-5', fast);
    await wait(300);

    const view = await client.describe('sc-5');
    expect(view?.status).toBe('running');
    // The definition, read back as given.
    expect(view?.definition?.spec).toEqual({type: 'interval', everyMs: 40});
    // The status, which only exists because carryover survives the rollovers.
    expect(view?.schedule?.recent.length).toBeGreaterThan(0);
    expect(view?.schedule?.paused).toBe(false);
  });

  it('answers undefined for a schedule that does not exist', async () => {
    const {client} = harness([]);
    expect(await client.describe('never-made')).toBeUndefined();
  });

  /**
   * `listRuns` depends on the run-naming convention holding — `<scheduleId>-<nominal>`.
   * If the scheduler ever names runs differently this fails, which is the only place
   * that link is checked.
   */
  it('lists the runs a schedule started, and only those', async () => {
    const ran: string[] = [];
    const {client} = harness(ran);

    client.create('sc-6', fast);
    await wait(300);

    const page = await client.listRuns('sc-6');
    expect(page.executions.length).toBeGreaterThan(0);
    for (const run of page.executions) {
      expect(run.workflowId).toMatch(/^sc-6-\d+$/);
      expect(run.name).toBe('target');
    }
  });

  it('pauses and resumes', async () => {
    const ran: string[] = [];
    const {client} = harness(ran);

    client.create('sc-7', hourly);
    await wait(100);
    client.pause('sc-7');
    for (let i = 0; i < 60; i++) {
      if ((await client.describe('sc-7'))?.schedule?.paused === true) break;
      await wait(25);
    }
    expect((await client.describe('sc-7'))?.schedule?.paused).toBe(true);

    client.resume('sc-7');
    for (let i = 0; i < 60; i++) {
      if ((await client.describe('sc-7'))?.schedule?.paused === false) break;
      await wait(25);
    }
    expect((await client.describe('sc-7'))?.schedule?.paused).toBe(false);
  });

  it('triggers a run on demand, on a schedule that would not otherwise fire', async () => {
    const ran: string[] = [];
    const {client} = harness(ran);

    client.create('sc-8', hourly);
    await wait(100);
    expect(ran).toEqual([]);

    client.trigger('sc-8');
    await wait(300);

    expect(ran.length).toBe(1);
    const view = await client.describe('sc-8');
    expect(view?.schedule?.recent[0]?.manual).toBe(true);
  });

  it('updates the spec in force', async () => {
    const ran: string[] = [];
    const {client} = harness(ran);

    client.create('sc-9', hourly);
    await wait(100);
    client.update('sc-9', {...hourly, spec: {type: 'interval', everyMs: 40}});

    for (let i = 0; i < 60; i++) {
      const spec = (await client.describe('sc-9'))?.definition?.spec;
      if (spec && 'everyMs' in spec && spec.everyMs === 40) break;
      await wait(25);
    }
    expect((await client.describe('sc-9'))?.definition?.spec).toEqual({
      type: 'interval',
      everyMs: 40,
    });
  });

  /**
   * The property `startWorkflow` exists for, reached through the operator surface:
   * deleting a schedule stops the schedule and leaves the work it set off alone. A
   * scheduler that used children would have cancelled every in-flight run here.
   */
  it('stops the schedule on delete and leaves its runs alone', async () => {
    const ran: string[] = [];
    const {store, client} = harness(ran);

    client.create('sc-10', fast);
    await wait(300);
    const runs = (await client.listRuns('sc-10')).executions;
    expect(runs.length).toBeGreaterThan(0);

    client.delete('sc-10');
    for (let i = 0; i < 60; i++) {
      if ((await client.describe('sc-10'))?.status !== 'running') break;
      await wait(25);
    }
    expect((await client.describe('sc-10'))?.status).not.toBe('running');

    const stopped = ran.length;
    await wait(200);
    expect(ran.length).toBe(stopped);

    // Not cancelled by the delete — every run reached its own outcome.
    for (const run of runs) {
      const rec = await store.get(run.workflowId);
      expect(rec?.status).toBe('completed');
    }
  });
});

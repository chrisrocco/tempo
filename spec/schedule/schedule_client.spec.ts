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

import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {createLocalRuntime} from '../../src';
import {
  createRemoteService,
  createRpcServer,
  createServerHost,
} from '../../src/services';
import {MemoryHistoryStore} from '../../src/server';
import {reportHash} from '../../src/worker';
import {isolateActivityRegistry} from '../support/isolate_activity_registry';
import {
  createScheduleClient,
  type ScheduleDefinition,
} from '../../src/schedule';
import {nextFire, scheduleWorkflows} from '../../src/schedule/worker';

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

    await client.create('sc-1', fast);
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

    await client.create('sc-2', hourly);
    await client.create('sc-3', hourly);
    await wait(120);

    const ids = (await client.list()).map((s) => s.scheduleId).sort();
    expect(ids).toEqual(['sc-2', 'sc-3']);
  });

  it('rejects a bad spec instead of starting a doomed workflow', async () => {
    const {client} = harness([]);

    await expectAsync(
      client.create('sc-4', {
        spec: {type: 'interval', everyMs: 0},
        target: {name: 'target'},
      }),
    ).toBeRejectedWithError(/cannot create schedule "sc-4".*positive integer/);

    // Nothing was started, which is the point — a rejected spec leaves no execution to
    // find and clean up later.
    expect(await client.list()).toEqual([]);
  });

  it('describes the definition and the status separately', async () => {
    const ran: string[] = [];
    const {client} = harness(ran);

    await client.create('sc-5', fast);
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

  // Silent under `createLocalRuntime`, and correctly so: its drain loops poll with no
  // identity, which by design records no worker row (see `worker_registry`). With no
  // fleet to describe, `isNameServed` answers `undefined` and this says nothing. The
  // warnings are exercised against a real polling fleet below.
  it('says nothing about a fleet it cannot see', async () => {
    const {client} = harness([]);

    const created = await client.create('sc-14', hourly);

    expect(created.scheduleId).toBe('sc-14');
    expect(created.warnings).toEqual([]);
  });

  /**
   * The stored definition names the queue, rather than leaving it for the engine to
   * resolve as "inherit the starter's". Two reasons, and the second is the one that bites:
   * `describe` should answer "where do this schedule's runs go" without the reader
   * knowing the inheritance rule, and inheritance is correct only while the scheduler is
   * colocated with the target's workers.
   */
  it('records the default queue on the definition rather than leaving it unset', async () => {
    const {client} = harness([]);

    await client.create('sc-11', {
      spec: {type: 'interval', everyMs: 3_600_000},
      target: {name: 'target'}, // no queue given
    });
    await wait(120);

    expect((await client.describe('sc-11'))?.definition?.target.taskQueue).toBe(
      'default',
    );
  });

  it('keeps an explicit target queue as given', async () => {
    const {client} = harness([]);

    await client.create('sc-12', {
      spec: {type: 'interval', everyMs: 3_600_000},
      target: {name: 'target', taskQueue: 'reports'},
    });
    await wait(120);

    expect((await client.describe('sc-12'))?.definition?.target.taskQueue).toBe(
      'reports',
    );
  });

  /**
   * The scheduler's queue and the target's queue are different questions, and were the
   * same value until that became clear. Tying them meant a schedule aimed at a dedicated
   * `reports` pool would only run if `scheduleWorkflows` had also been registered there —
   * so pointing a schedule at its own pool quietly stopped the schedule itself.
   */
  it('runs the scheduler on the scheduler queue, not the target queue', async () => {
    const ran: string[] = [];
    const {store, client} = harness(ran);

    await client.create('sc-13', {
      spec: {type: 'interval', everyMs: 40},
      target: {name: 'target', taskQueue: 'default'},
    });
    await wait(300);

    // The runtime's workers serve `default`; the scheduler must be there to have run.
    expect((await store.get('sc-13'))?.taskQueue).toBe('default');
    expect(ran.length).toBeGreaterThan(0);
  });

  /**
   * `listRuns` depends on the run-naming convention holding — `<scheduleId>-<nominal>`.
   * If the scheduler ever names runs differently this fails, which is the only place
   * that link is checked.
   */
  it('lists the runs a schedule started, and only those', async () => {
    const ran: string[] = [];
    const {client} = harness(ran);

    await client.create('sc-6', fast);
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

    await client.create('sc-7', hourly);
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

    await client.create('sc-8', hourly);
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

    await client.create('sc-9', hourly);
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

    await client.create('sc-10', fast);
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

/**
 * The warnings, against a fleet that actually polls.
 *
 * A real server over RPC, with a worker's poll simulated directly — that is enough,
 * because a manifest reaches the registry through the poll and nothing else. What this
 * covers that a hand-built `QueueWorkers[]` would not is the whole path: poll → RPC →
 * registry → `listQueues` → predicate → sentence.
 *
 * These are the last two "created fine, never runs" shapes in schedules. Both look
 * identical from outside — a schedule that exists, reports `running`, and produces
 * nothing.
 */
describe('ScheduleClient warnings against a polling fleet', () => {
  let host: ReturnType<typeof createServerHost>;
  let server: Server;
  let service: ReturnType<typeof createRemoteService>;

  beforeEach(async () => {
    host = createServerHost();
    server = createRpcServer(host);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const {port} = server.address() as AddressInfo;
    service = createRemoteService(`http://127.0.0.1:${port}`);
  });

  afterEach(async () => {
    host.shutdown();
    (
      server as Server & {closeAllConnections?: () => void}
    ).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  /**
   * A worker declaring itself: report what it runs, then poll carrying that report's
   * digest. Both halves are needed — the report supplies the names and the digest is what
   * tells the server its copy is still current.
   */
  const workerServing = async (
    names: string[],
    identity = 'w1@host',
  ): Promise<void> => {
    const workflows = names.map((name) => ({name}));
    const hash = reportHash(workflows);
    await service.reportWorkflows({
      identity,
      taskQueue: 'default',
      hash,
      workflows,
    });
    await service.pollWorkflowTask({
      taskQueue: 'default',
      identity,
      servesHash: hash,
    });
  };

  it('says nothing when both the scheduler and the target are served', async () => {
    await workerServing(['scheduler', 'nightlyReport']);
    const client = createScheduleClient(service);

    const created = await client.create('s-1', {
      spec: {type: 'interval', everyMs: 3_600_000},
      target: {name: 'nightlyReport'},
    });

    expect(created.warnings).toEqual([]);
  });

  it('warns when no worker runs the target workflow', async () => {
    await workerServing(['scheduler']);
    const client = createScheduleClient(service);

    const created = await client.create('s-2', {
      spec: {type: 'interval', everyMs: 3_600_000},
      target: {name: 'nightlyReport'},
    });

    expect(created.warnings.length).toBe(1);
    expect(created.warnings[0]).toContain('nightlyReport');
    expect(created.warnings[0]).toContain('runs will not start');
  });

  /**
   * The forgotten `scheduleWorkflows` registration — the hole this closes. The schedule
   * is created, the execution exists, and no worker will ever replay it.
   */
  it('warns when no worker runs the scheduler itself', async () => {
    await workerServing(['nightlyReport']);
    const client = createScheduleClient(service);

    const created = await client.create('s-3', {
      spec: {type: 'interval', everyMs: 3_600_000},
      target: {name: 'nightlyReport'},
    });

    expect(created.warnings.length).toBe(1);
    expect(created.warnings[0]).toContain('scheduleWorkflows');
  });

  it('reports both when neither is served', async () => {
    await workerServing(['somethingElse']);
    const client = createScheduleClient(service);

    const created = await client.create('s-4', {
      spec: {type: 'interval', everyMs: 3_600_000},
      target: {name: 'nightlyReport'},
    });

    expect(created.warnings.length).toBe(2);
  });

  /**
   * Created regardless, which is the point. A queue with no worker for a name usually
   * means a deploy still rolling, and refusing would trade a recoverable state for an
   * unrecoverable one.
   */
  it('creates the schedule anyway, warning or not', async () => {
    await workerServing(['somethingElse']);
    const client = createScheduleClient(service);

    await client.create('s-5', {
      spec: {type: 'interval', everyMs: 3_600_000},
      target: {name: 'nightlyReport'},
    });

    expect((await client.describe('s-5'))?.status).toBe('running');
  });

  /**
   * Silence rather than a guess. Nothing polls `reports`, so `isNameServed` cannot
   * distinguish an empty pool from one whose workers have not started — and warning on
   * "cannot tell" is how a warning becomes noise people filter out.
   */
  it('stays quiet about a queue nobody polls', async () => {
    await workerServing(['scheduler', 'nightlyReport']);
    const client = createScheduleClient(service);

    const created = await client.create('s-6', {
      spec: {type: 'interval', everyMs: 3_600_000},
      target: {name: 'nightlyReport', taskQueue: 'reports'},
    });

    expect(created.warnings).toEqual([]);
  });

  // A worker that reports no manifest makes the answer unknown, not negative — so an
  // older worker binary in the fleet silences the warning rather than triggering it.
  it('stays quiet when a worker on the queue reports no manifest', async () => {
    await workerServing(['scheduler']);
    await service.pollWorkflowTask({
      taskQueue: 'default',
      identity: 'old@host',
    });
    const client = createScheduleClient(service);

    const created = await client.create('s-7', {
      spec: {type: 'interval', everyMs: 3_600_000},
      target: {name: 'nightlyReport'},
    });

    expect(created.warnings).toEqual([]);
  });
});

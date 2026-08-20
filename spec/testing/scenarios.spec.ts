/**
 * @fileoverview
 * Every named scenario, actually produced.
 *
 * This is the file that makes the harness worth shipping from here rather than
 * leaving each dashboard to build its own fixtures. A scenario is a claim about
 * a state the engine can be in, and a claim nobody checks is exactly the kind of
 * fixture that drifts from the engine and takes a UI with it.
 *
 * One server for the whole file, seeded with everything: standing one up costs a
 * port, two poll loops and a round of seeding, and doing that six times to assert
 * six things would trade a real minute of CI for no extra coverage. The scenarios
 * are independent by construction — separate workflow ids, separate queues — so
 * sharing a server is not sharing state between the cases below.
 */

import {isStuck, serverUrl} from '../../src/protocol';
import {
  SCENARIO_IDS,
  startScenario,
  UNSERVED_QUEUE,
  type ScenarioServer,
} from '../../src/testing';
import {SCENARIO_DESCRIPTORS} from '../../src/testing/scenarios.workflow';

/** Generous: it stands up a server and waits for six states to be observable. */
const SETUP_TIMEOUT_MS = 60_000;

describe('the scenario harness', () => {
  let server: ScenarioServer;

  beforeAll(async () => {
    server = await startScenario(
      [
        'settled-mixed',
        'parked',
        'retrying',
        'stuck',
        'unserved-queue',
        'split-manifest',
      ],
      // Below Jasmine's own ceiling for this hook, so a scenario that cannot
      // reach its state fails with the label it was waiting for rather than with
      // a bare timeout that says nothing about which one.
      {timeoutMs: 30_000},
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
  });

  it('binds a port and reports where it is', () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toContain(`:${server.port}`);
  });

  it('answers health with the same endpoint it handed the caller', async () => {
    // A dashboard built against this fixture reads the server's address off
    // `health()`, so a fixture that left those fields empty would send it down
    // the fallback path — building a state no deployment produces, which is the
    // one thing a shared fixture must not do.
    const health = await server.client.health();

    expect(health.port).toBe(server.port);
    expect(health.host).toBe('127.0.0.1');
    expect(serverUrl(health)).toBe(server.url);
  });

  it('serves a completed execution carrying its result', async () => {
    const detail = await server.client
      .getHandle(SCENARIO_IDS.completed)
      .describe();

    expect(detail?.status).toBe('completed');
    expect(detail?.result).toBe('hello');
  });

  it('serves a failed execution carrying why it failed', async () => {
    const detail = await server.client
      .getHandle(SCENARIO_IDS.failed)
      .describe();

    expect(detail?.status).toBe('failed');
    expect(detail?.failure).toContain('always fails');
  });

  it('serves an execution parked on a condition', async () => {
    const detail = await server.client
      .getHandle(SCENARIO_IDS.parked)
      .describe();

    expect(detail?.status).toBe('running');
    expect(detail?.parked.length).toBeGreaterThan(0);
  });

  /**
   * Wedged, not failed — the distinction a listing cannot make from `status`
   * alone, and the reason `isStuck` is exported from `protocol/` rather than
   * rederived by every reader. Both this and `scenario-failed` involve something
   * going wrong; only this one is still running and still retrying.
   */
  it('serves a wedged execution that isStuck reports as stuck', async () => {
    const detail = await server.client.getHandle(SCENARIO_IDS.stuck).describe();

    expect(detail?.status).toBe('running');
    expect(detail && isStuck(detail)).toBe(true);
    expect(detail?.lastTaskFailure).toContain('no workflow registered');
  });

  /**
   * The pair that is easy to conflate. A wedged execution is on a queue that *is*
   * served — a worker looked at the task and could not run it — while the
   * unserved one has never been looked at, so its failure count is still zero.
   */
  it('distinguishes a wedged execution from one nobody has claimed', async () => {
    const [wedged, unclaimed] = await Promise.all([
      server.client.getHandle(SCENARIO_IDS.stuck).describe(),
      server.client.getHandle(SCENARIO_IDS.unserved).describe(),
    ]);

    expect(wedged?.taskFailures).toBeGreaterThan(0);
    expect(unclaimed?.taskFailures).toBe(0);
  });

  it('serves an activity between retry attempts', async () => {
    const groups = await server.client.counts();
    const retrying = groups.retryingActivities.find(
      (group) => group.name === 'scenario_fail',
    );

    expect(retrying).toBeDefined();
    expect(retrying?.attempts).toBeGreaterThan(0);
  });

  it('serves an execution on a queue no worker polls', async () => {
    const detail = await server.client
      .getHandle(SCENARIO_IDS.unserved)
      .describe();

    expect(detail?.status).toBe('running');
    expect(detail?.taskQueue).toBe(UNSERVED_QUEUE);
  });

  it('leaves that queue unserved, so isQueueServed can say so', async () => {
    const queues = await server.client.queues();
    const unserved = queues.find((queue) => queue.taskQueue === UNSERVED_QUEUE);

    // Either no row at all (nothing ever polled it) or a row with no workers.
    // Both are the same reading; which one appears depends on whether anything
    // has referenced the queue, and a fixture should not pin that.
    expect(unserved?.workers ?? []).toEqual([]);
  });

  it('publishes a catalogue with the descriptors the workflows declared', async () => {
    const workflows = await server.client.workflows();
    const parks = workflows.find(
      (workflow) => workflow.name === 'scenarioParks',
    );

    expect(parks?.title).toBe('Waits for a signal');
    expect(parks?.description).toContain('release');
  });

  /**
   * The one above reads as an example; this one is the guarantee. The fixtures
   * hold their descriptions in a name-keyed map, and the compiler now pins the
   * *keys* to registered workflows — but it cannot see whether a description
   * ever reaches the wire. Asserting one of four left three that could stop
   * arriving silently, which is the half of the drift a type does not cover.
   */
  it('carries every described scenario through to that catalogue', async () => {
    const workflows = await server.client.workflows();

    for (const [name, descriptor] of Object.entries(SCENARIO_DESCRIPTORS)) {
      const published = workflows.find((workflow) => workflow.name === name);

      expect(published)
        .withContext(`${name} missing from the catalogue`)
        .toBeDefined();
      expect(published?.title)
        .withContext(`${name} title`)
        .toBe(descriptor.title);
      expect(published?.description)
        .withContext(`${name} description`)
        .toBe(descriptor.description);
    }
  });

  it('reports a workflow two workers describe differently as conflicting', async () => {
    const workflows = await server.client.workflows();
    const completes = workflows.find(
      (workflow) => workflow.name === 'scenarioCompletes',
    );

    expect(completes?.conflicting).toBe(true);
  });
});

describe('the scenario harness — an empty server', () => {
  it(
    'starts with no scenarios at all, which is a state too',
    async () => {
      const server = await startScenario();
      try {
        const page = await server.client.list();
        expect(page.executions).toEqual([]);
      } finally {
        await server.stop();
      }
    },
    SETUP_TIMEOUT_MS,
  );
});

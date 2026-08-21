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
 * port, two poll loops and a round of seeding, and doing that once per scenario
 * would trade a real minute of CI for no extra coverage. The scenarios are
 * independent by construction — separate workflow ids, separate queues — so
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

/** Generous: it stands up a server and waits for every state to be observable. */
const SETUP_TIMEOUT_MS = 60_000;

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('the scenario harness', () => {
  let server: ScenarioServer;

  beforeAll(async () => {
    server = await startScenario(
      [
        'settled-mixed',
        'parked',
        'awaiting-approval',
        'bugfix-agent',
        'schedules',
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

  it('serves an execution advertising an approval request', async () => {
    const detail = await server.client
      .getHandle(SCENARIO_IDS.awaitingApproval)
      .describe();
    const awaiting = detail?.parked[0]?.awaiting as
      {kind?: unknown; signal?: unknown; detail?: unknown} | undefined;

    expect(detail?.status).toBe('running');
    // The whole affordance: what kind of wait, where to answer it, and what a
    // human is being asked — everything a dashboard needs to render the request.
    expect(awaiting?.kind).toBe('approval');
    expect(awaiting?.signal).toBe('decide');
    expect(awaiting?.detail).toEqual({
      what: 'Ship the pending release',
      requestedBy: 'scenario-harness',
    });
  });

  /**
   * The closed loop the scenario exists for, driven the way a dashboard would
   * drive it: the signal name comes from the parked state itself, not from an
   * imported constant, and the attribution in the payload comes back on the
   * settled result. This settles `scenario-awaiting-approval`; nothing after
   * this spec reads it.
   */
  it('settles when a decision is sent to the signal the state names', async () => {
    const handle = server.client.getHandle<string>(
      SCENARIO_IDS.awaitingApproval,
    );
    const detail = await handle.describe();
    const awaiting = detail?.parked[0]?.awaiting as {signal: string};

    handle.signal(awaiting.signal, {
      approved: true,
      approvedBy: 'chris@example.com',
      via: 'scenario-spec',
    });

    expect(await handle.result()).toBe('approved by chris@example.com');
  });

  it('seeds the agent parked at intake, with the journey so far in history', async () => {
    const detail = await server.client
      .getHandle(SCENARIO_IDS.bugfixAgent)
      .describe();
    const awaiting = detail?.parked[0]?.awaiting as
      {kind?: unknown; signal?: unknown} | undefined;

    expect(detail?.status).toBe('running');
    expect(awaiting?.kind).toBe('approval');
    expect(awaiting?.signal).toBe('intake');
    // Reaching the gate proves the stages before it really ran: a tolerated
    // child failure and a retried flaky activity are already in the record.
    const types = new Set(detail?.history.map((event) => event.type));
    for (const expected of [
      'childCompleted',
      'childFailed',
      'activityFailed',
      'activityRetryScheduled',
    ])
      expect(types.has(expected as never))
        .withContext(`${expected} before intake`)
        .toBe(true);
  });

  /**
   * The scenario's whole point, driven the way a dashboard would drive it: two
   * human approvals in, one history out with **every parent-side event family
   * in it**. `cancelRequested` is the one family a completing run cannot hold,
   * so it is asserted where it lives — the watchdog child the agent cancelled.
   * This settles `scenario-bugfix-agent`; nothing after this spec reads it.
   */
  it('runs the whole arc on two approvals, with every event family in one history', async () => {
    const handle = server.client.getHandle<string>(SCENARIO_IDS.bugfixAgent);
    const parkedOn = async (signal: string): Promise<boolean> => {
      const detail = await handle.describe();
      return (detail?.parked ?? []).some(
        (parked) =>
          (parked.awaiting as {signal?: unknown} | undefined)?.signal ===
          signal,
      );
    };
    const until = async (
      label: string,
      predicate: () => Promise<boolean>,
    ): Promise<void> => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await wait(100);
      }
      throw new Error(`timed out waiting for: ${label}`);
    };

    handle.signal('intake', {approved: true, approvedBy: 'triage'});
    await until('the agent reaches the metrics gate', () =>
      parkedOn('shipMetrics'),
    );
    handle.signal('shipMetrics', {approved: true, approvedBy: 'release'});
    await until(
      'the agent completes',
      async () => (await handle.describe())?.status === 'completed',
    );

    const detail = (await handle.describe())!;
    expect(detail.result).toContain('BUG-4021 fixed');
    expect(detail.result).toContain('ramped to 100%');
    const types = new Set(detail.history.map((event) => event.type));
    for (const family of [
      'activityScheduled',
      'activityStarted',
      'activityCompleted',
      'activityFailed',
      'activityRetryScheduled',
      'timerStarted',
      'timerFired',
      'childStarted',
      'childCompleted',
      'childFailed',
      'childCancelRequested',
      'signal',
      'workflowSignaled',
      'workflowStarted',
      'patchRecorded',
      'conditionParked',
      'conditionUnparked',
    ])
      expect(types.has(family as never))
        .withContext(`history holds a ${family}`)
        .toBe(true);

    // The cancelled watchdog caught its cancellation and stood down — its
    // history is where `cancelRequested` lives.
    const watchdog = await server.client
      .getHandle(`${SCENARIO_IDS.bugfixAgent}-watchdog`)
      .describe();
    expect(watchdog?.status).toBe('completed');
    expect(watchdog?.result).toBe('stood down — CI settled first');
    expect(
      watchdog?.history.some((event) => event.type === 'cancelRequested'),
    ).toBe(true);

    // The launch announcement outlived the arc as its own execution.
    const announcement = await server.client
      .getHandle(`${SCENARIO_IDS.bugfixAgent}-announcement`)
      .describe();
    expect(announcement?.status).toBe('completed');
    expect(announcement?.result).toContain('BUG-4021 fixed and launched');
  }, 30_000);

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

  it('serves both schedule states: one live, one paused', async () => {
    // A schedule is one execution of the `scheduler` workflow whose props are
    // the definition in force — which is exactly how a dashboard reads them.
    const [heartbeat, paused] = await Promise.all([
      server.client.getHandle(SCENARIO_IDS.heartbeatSchedule).describe(),
      server.client.getHandle(SCENARIO_IDS.pausedSchedule).describe(),
    ]);

    expect(heartbeat?.status).toBe('running');
    expect(heartbeat?.name).toBe('scheduler');
    const heartbeatDef = heartbeat?.props as {
      spec?: {everyMs?: number};
      paused?: boolean;
    };
    expect(heartbeatDef.spec?.everyMs).toBe(15_000);

    expect(paused?.status).toBe('running');
    expect((paused?.props as {paused?: boolean}).paused).toBe(true);
  });

  it('reports the scheduler in its manifest, so isNameServed answers yes', async () => {
    // Registered is not enough: `isNameServed` reads what workers *report*, and
    // a harness that ran the scheduler without reporting it would warn every
    // schedule creation about a worker that exists — a state no
    // correctly-configured deployment produces.
    const workflows = await server.client.workflows();
    const scheduler = workflows.find(
      (workflow) => workflow.name === 'scheduler',
    );

    expect(scheduler).toBeDefined();
    expect(scheduler?.taskQueues).toContain(server.taskQueue);
  });

  it('runs what a schedule fires — a trigger produces a completed run', async () => {
    // Triggered rather than waiting out a boundary, because triggers work even
    // on a paused schedule and are immediate — the deterministic way to prove
    // the harness's workers really serve the scheduler and its firings. The
    // fired run's id is `<scheduleId>-<ordinal>`, so a prefix query finds it.
    server.client
      .getHandle(SCENARIO_IDS.pausedSchedule)
      .signal('triggerSchedule');

    const deadline = Date.now() + 15_000;
    let fired;
    while (Date.now() < deadline) {
      const page = await server.client.list({
        workflowIdPrefix: `${SCENARIO_IDS.pausedSchedule}-`,
      });
      fired = page.executions.find(
        (execution) => execution.status === 'completed',
      );
      if (fired !== undefined) break;
      await wait(100);
    }
    expect(fired).toBeDefined();

    const run = await server.client.getHandle(fired!.workflowId).describe();
    expect(run?.result).toBe('quarterly cleanup swept');
  }, 20_000);

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

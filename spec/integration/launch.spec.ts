/**
 * @fileoverview
 * The launch pipeline end to end: a CL with lint findings goes in, a fully
 * launched and cleaned-up flag comes out, and every human in the middle is a
 * signal.
 *
 * It is here because the example is only worth reading if it runs. The durations
 * are the one thing that changes between this and a real deployment — the policy
 * arrives as a workflow *argument*, so a spec passes milliseconds where an
 * operator passes days, and the workflow code under test is byte-identical to the
 * code that takes eleven days in production. That is the property being
 * demonstrated as much as any assertion below.
 *
 * Signals are sent to children **by the id the parent claimed for them**
 * (`land:cl/1`, `ramp:exp:my_flag`), which is what a real webhook or approval
 * link would do: the id is derived from the domain, so an outside system can
 * address the right execution without having been told a run id.
 */

import {createLocalRuntime, type Runtime} from '../../src';
import {
  addCl,
  createLaunchActivities,
  createWorld,
  type World,
} from '../../examples/launch/activities';
import {
  landCl,
  launch,
  rampExperiment,
  type LaunchRequest,
  type LaunchResult,
  type RampStage,
} from '../../examples/launch/workflows';

// real-time wait, for letting timers and async drives make progress in a test
function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Poll until a condition holds, so a test can act at the right moment. */
async function until(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await wait(2);
  }
}

function hosting(world: World): Runtime {
  const rt = createLocalRuntime();
  for (const [name, fn] of Object.entries(createLaunchActivities(world))) {
    rt.registerActivity(name, fn as (...args: unknown[]) => unknown);
  }
  return rt
    .registerWorkflow('launch', launch)
    .registerWorkflow('landCl', landCl)
    .registerWorkflow('rampExperiment', rampExperiment);
}

/** The real policy's shape, at a thousandth of its duration. */
const POLICY: RampStage[] = [
  {pct: 1, holdMs: 10},
  {pct: 5, holdMs: 10},
  {pct: 10, holdMs: 20, then: 'report'},
  {pct: 50, holdMs: 20, gate: 'approveHalf', then: 'analyze'},
  {pct: 100, holdMs: 0, gate: 'approveFullLaunch'},
];

function request(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    cl: 'cl/1',
    bug: 'b/1',
    owner: 'dev@example.com',
    policy: POLICY,
    pollMs: 5,
    guardrailMs: 5,
    approvalTimeoutMs: 2_000,
    ...overrides,
  };
}

/** Wait until an activity has been called, so a test can act mid-flight. */
function untilCalled(world: World, activity: string): Promise<void> {
  return until(
    () => (world.calls.get(activity) ?? 0) > 0,
    `${activity} to run`,
  );
}

/**
 * A CL blocked on a failing test — the one finding `applyEdits` does not clear —
 * so its landing loop keeps reconciling until the test is fixed from outside.
 */
function stuckOnATest(): World {
  const world = createWorld();
  addCl(world, 'cl/1', [{id: 't1', kind: 'test', message: 'FooTest is red'}]);
  world.flags.set('cl/1', 'my_flag');
  return world;
}

/** A world with one CL that has lint findings and introduces a flag. */
function seeded(): World {
  const world = createWorld();
  addCl(world, 'cl/1', [
    {id: 'f1', kind: 'lint', message: 'line too long'},
    {id: 'f2', kind: 'analyzer', message: 'unused import'},
  ]);
  world.flags.set('cl/1', 'my_flag');
  return world;
}

/** Approve a gate as soon as the pipeline asks for it. */
async function approveWhenAsked(
  rt: Runtime,
  world: World,
  signalName: string,
  approved = true,
): Promise<void> {
  await until(
    () => world.outbox.some((line) => line.includes(`[${signalName}]`)),
    `request for ${signalName}`,
  );
  rt.getHandle('ramp:exp:my_flag').signal(signalName, {approved});
}

describe('launch pipeline — the whole thing', () => {
  it('takes a CL with lint findings all the way to a cleaned-up full launch', async () => {
    const world = seeded();
    const rt = hosting(world);
    const handle = rt.start<LaunchResult>('launch', [request()]);

    await approveWhenAsked(rt, world, 'approveHalf');
    await approveWhenAsked(rt, world, 'approveFullLaunch');

    const result = await handle.result();
    expect(result.status).toBe('launched');

    // Steps 1–3: the findings were fixed and the CL submitted.
    expect(world.cls.get('cl/1')!.submitted).toBe(true);
    expect(world.cls.get('cl/1')!.edits.length).toBeGreaterThan(0);

    // Step 4: the flag was detected and its setup CL landed.
    expect(world.cls.get('cl/setup-my_flag')!.submitted).toBe(true);

    // Steps 5–14: every rung of the policy was served, in order.
    const ramps = world.outbox.filter((l) => l.startsWith('exp:my_flag:'));
    expect(ramps).toEqual([
      'exp:my_flag: 0% → 1%',
      'exp:my_flag: 1% → 5%',
      'exp:my_flag: 5% → 10%',
      'exp:my_flag: 10% → 50%',
      'exp:my_flag: 50% → 100%',
    ]);
    expect(world.experiments.get('exp:my_flag')!.pct).toBe(100);

    // Step 9: the owner got the snapshot before being asked to approve 50%.
    const reportAt = world.outbox.findIndex((l) => l.startsWith('report to'));
    const askedAt = world.outbox.findIndex((l) => l.includes('[approveHalf]'));
    expect(reportAt).toBeGreaterThanOrEqual(0);
    expect(reportAt).toBeLessThan(askedAt);

    // Steps 15–16: cleanup landed, owner notified, bug closed.
    expect(world.cls.get('cl/cleanup-my_flag')!.submitted).toBe(true);
    expect(world.outbox).toContain(
      'notify dev@example.com: my_flag is fully launched and cleaned up',
    );
    expect(world.outbox.some((l) => l.startsWith('closed b/1:'))).toBe(true);

    rt.shutdown();
  });

  it('answers a comment on the CL while it is still landing, and folds the edit into the next pass', async () => {
    // A failing test is the one finding `applyEdits` cannot clear, so the
    // reconcile loop keeps cycling and the comment lands mid-flight — which is
    // the case worth testing. Anything an edit fixes would submit on pass one.
    const world = stuckOnATest();
    const rt = hosting(world);
    const handle = rt.start<LaunchResult>('launch', [request()]);

    await until(() => world.cls.has('cl/1'), 'the landing child');
    await untilCalled(world, 'trySubmit');
    rt.getHandle('land:cl/1').signal('commentPosted', {
      id: 'c1',
      author: 'reviewer@example.com',
      body: 'nit: rename this variable please',
      on: 'cl',
    });

    const cl = world.cls.get('cl/1')!;
    await until(
      () => cl.edits.some((e) => e.startsWith('comment:c1')),
      'the comment edit to be applied',
    );

    // The reply came from the supervisor branch; the edit it decided on was
    // applied by the main loop, not by the branch itself. Both landed in the
    // same reconcile pass, which is the point of the branch queueing rather
    // than writing.
    expect(cl.replies).toContain(
      'Thanks reviewer@example.com, addressing that now.',
    );

    // Someone fixes the test, and the very next reconcile pass submits.
    cl.findings = [];
    await handle.result();
    expect(cl.submitted).toBe(true);

    rt.shutdown();
  });

  it('abandons the CL when a reviewer asks it to, and never reaches the ramp', async () => {
    const world = stuckOnATest();
    const rt = hosting(world);
    const handle = rt.start<LaunchResult>('launch', [request()]);

    await untilCalled(world, 'trySubmit');
    rt.getHandle('land:cl/1').signal('commentPosted', {
      id: 'c9',
      author: 'reviewer@example.com',
      body: 'please abandon this, we are going another way',
      on: 'cl',
    });

    const result = await handle.result();
    expect(result.status).toBe('abandoned');
    expect(world.cls.get('cl/1')!.abandoned).toContain('reviewer@example.com');
    expect(world.experiments.size).toBe(0);

    rt.shutdown();
  });
});

describe('launch pipeline — stopping safely', () => {
  it('rolls traffic back to 0% when a guardrail regresses mid-ramp', async () => {
    const world = seeded();
    const rt = hosting(world);
    const handle = rt.start<LaunchResult>('launch', [request()]);

    // Break a guardrail as soon as traffic is being served.
    await until(
      () => (world.experiments.get('exp:my_flag')?.pct ?? 0) > 0,
      'the first rung',
    );
    world.experiments.get('exp:my_flag')!.guardrails = {
      regressed: true,
      reason: 'latency p99 up 40%',
    };

    const result = await handle.result();
    expect(result.status).toBe('halted');
    expect(result.detail).toContain('latency p99');

    // The rollback is the point: compensation ran on a live context, which it
    // could not have done had the halt been a cancellation.
    expect(world.experiments.get('exp:my_flag')!.pct).toBe(0);
    expect(world.outbox.some((l) => l.endsWith('→ 0%'))).toBe(true);

    rt.shutdown();
  });

  it('rolls back when a halt signal arrives, addressed to the ramp by its claimed id', async () => {
    const world = seeded();
    const rt = hosting(world);
    const handle = rt.start<LaunchResult>('launch', [request()]);

    await until(
      () => (world.experiments.get('exp:my_flag')?.pct ?? 0) > 0,
      'the first rung',
    );
    rt.getHandle('ramp:exp:my_flag').signal('haltRamp', {
      reason: 'oncall asked to stop',
    });

    const result = await handle.result();
    expect(result.status).toBe('halted');
    expect(result.detail).toBe('oncall asked to stop');
    expect(world.experiments.get('exp:my_flag')!.pct).toBe(0);

    rt.shutdown();
  });

  it('holds traffic where it is when nobody answers an approval', async () => {
    const world = seeded();
    const rt = hosting(world);
    const handle = rt.start<LaunchResult>('launch', [
      request({approvalTimeoutMs: 30}),
    ]);

    const result = await handle.result();
    expect(result.status).toBe('timedOut');

    // Held at the last rung it was approved for, not rolled back: nothing went
    // wrong with the experiment, a human simply did not answer.
    expect(world.experiments.get('exp:my_flag')!.pct).toBe(10);

    rt.shutdown();
  });

  it('stops before the last rung when the analysis pass is not clean', async () => {
    const world = seeded();
    const rt = hosting(world);
    const handle = rt.start<LaunchResult>('launch', [request()]);

    await until(
      () => world.experiments.has('exp:my_flag'),
      'the experiment to exist',
    );
    world.experiments.get('exp:my_flag')!.analysis = {
      clean: false,
      summary: 'conversion down 2%',
    };
    await approveWhenAsked(rt, world, 'approveHalf');

    const result = await handle.result();
    expect(result.status).toBe('halted');
    expect(result.detail).toContain('conversion down 2%');

    // The 100% gate was never opened — an unclean analysis does not reach a human.
    expect(world.outbox.some((l) => l.includes('[approveFullLaunch]'))).toBe(
      false,
    );
    expect(world.experiments.get('exp:my_flag')!.pct).toBe(0);

    rt.shutdown();
  });
});

describe('launch pipeline — ids as claims', () => {
  it('ramps once when two launches target the same CL', async () => {
    const world = seeded();
    const rt = hosting(world);

    // Two separate pipelines — a retriggered automation, a colleague kicking it
    // off by hand — pointed at one CL. Their ids differ; what they claim inside
    // does not.
    const first = rt.start<LaunchResult>('launch', [request()], {
      workflowId: 'launch:automation',
    });
    const second = rt.start<LaunchResult>('launch', [request()], {
      workflowId: 'launch:by-hand',
    });

    await approveWhenAsked(rt, world, 'approveHalf');
    await approveWhenAsked(rt, world, 'approveFullLaunch');

    // The effect-level claim holds, and it is the one that matters: traffic
    // walked the policy once, not twice, even though two pipelines asked for it.
    expect((await second.result()).status).toBe('launched');
    expect(
      world.outbox.filter((l) => l.startsWith('exp:my_flag:')).length,
    ).toBe(5);
    expect(world.cls.get('cl/1')!.submitted).toBe(true);

    // ...but the *waiter* is not deduped, and this is the sharp edge. A child
    // records one parent (`parentOfChild` in the server is a 1:1 map), so its
    // completion resumes whichever pipeline claimed it last. The other is never
    // woken and sits `running` forever — which presents exactly like a wedged
    // execution, because that is what it is.
    await wait(50);
    expect(first.status()).toBe('running');

    first.terminate('orphaned by a shared child claim');
    rt.shutdown();
  });

  it('rejects a second client start on a claimed id — asynchronously, through the handle', async () => {
    const world = seeded();
    const rt = hosting(world);
    rt.start<LaunchResult>('launch', [request()], {workflowId: 'launch:cl/1'});

    // Worth pinning twice over. It differs from `executeChild`, where a taken id
    // means "await the existing one" — and the failure arrives on the handle
    // rather than at the call, so a caller that only calls `start` and walks
    // away never learns the second pipeline did not exist.
    const duplicate = rt.start<LaunchResult>('launch', [request()], {
      workflowId: 'launch:cl/1',
    });
    await expectAsync(duplicate.result()).toBeRejectedWithError(
      /already exists/,
    );

    rt.shutdown();
  });
});

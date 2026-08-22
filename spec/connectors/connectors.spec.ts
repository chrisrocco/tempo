/**
 * @fileoverview
 * The connectors framework, end to end on the local runtime — every derived
 * surface of one definition, exercised against the tracker fixture connector
 * (`support/tracker.ts`), whose schemas come from a deliberately non-Zod
 * Standard Schema vendor (`support/mini_schema.ts`). That vendor is itself the
 * point: this repo carries no schema library, so these tests are only writable
 * because the framework is vendor-agnostic.
 *
 * The headline test is the watcher path, because it is the one built from the
 * most engine parts: `watch.<trigger>()` spawns a `pollForever` child keyed by a
 * deterministic id, the child signals the parent per event, and the handle
 * wraps `signalStream`. The test plays the human — resolving the issue from the
 * host side while the workflow is parked — so what is asserted is the real
 * contract: an external fact reaches a waiting workflow as a signal, once.
 *
 * Command tests assert **effects, not invocations**, by re-firing handlers the
 * way the engine's at-least-once delivery will: `createIssue` twice with one
 * externalId is one issue; `transitionIssue` twice to one status succeeds both
 * times. These are the same certifications a live suite will run against real
 * services; here they certify the framework's own plumbing around them.
 *
 * ## Registration happens in `beforeAll`, deliberately
 *
 * `use()` registers activities and the watcher workflow into the process-global
 * registries, exactly like `proxyActivities` — that is its contract. Done at
 * module scope it would leak into every suite that runs after this file
 * **loads** (`spec/integration/worker_entrypoint.spec.ts` asserts a worker with
 * nothing registered refuses to start), so this suite registers at run time and
 * restores both registries after — the same save-and-restore fidelity as
 * `spec/support/isolate_workflow_registry.ts`, at suite scope.
 */

import {createLocalRuntime, type Runtime} from '../../src';
import {createWorkflow, type AnyWorkflowFn} from '../../src/workflow';
import {
  registeredActivityImpls,
  registerActivityImpls,
  resetActivityRegistry,
} from '../../src/activity_registry';
import {
  registeredWorkflowImpls,
  resetWorkflowRegistry,
} from '../../src/workflow_registry';
import {catalogue, ConnectorError, toMs} from '../../src/connectors';
import {fakeTracker, tracker} from './support/tracker';

/** Poll the host-side fixture until a fact holds — never the engine's job. */
async function eventually<T>(
  probe: () => T | undefined,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function kindOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof ConnectorError) return e.kind;
    throw e;
  }
  return 'no error';
}

describe('connectors — one definition, every derived surface', () => {
  let rt: Runtime;
  let savedWorkflows: ReturnType<typeof registeredWorkflowImpls> = [];
  let savedActivities: ReturnType<typeof registeredActivityImpls> = [];

  beforeAll(() => {
    savedWorkflows = registeredWorkflowImpls();
    savedActivities = registeredActivityImpls();

    const trk = tracker.use();
    const incidentTicket = createWorkflow({
      key: 'incidentTicket',
      async run({incidentId, summary}: {incidentId: string; summary: string}) {
        const issue = await trk.command.createIssue({
          projectKey: 'OPS',
          summary,
          externalId: `incident/${incidentId}`,
        });

        const resolved = trk.watch.issueTransitioned({
          every: 25,
          where: {issueKey: issue.key, to: 'resolved'},
          start: 'all', // deterministic under test: no baseline race
        });
        const evt = await resolved.next();
        resolved.stop();

        await trk.command.transitionIssue({issueKey: issue.key, to: 'closed'});
        return {issueKey: issue.key, resolvedFrom: evt.from};
      },
    });

    rt = createLocalRuntime();
    const regs = tracker.registrations();
    for (const [name, fn] of Object.entries(regs.activities)) {
      rt.registerActivity(name, fn);
    }
    for (const [name, fn] of Object.entries(regs.workflows)) {
      rt.registerWorkflow(name, fn);
    }
    rt.registerWorkflow('incidentTicket', incidentTicket);
  });

  afterAll(() => {
    rt.shutdown();
    resetWorkflowRegistry();
    for (const [key, fn] of savedWorkflows) {
      createWorkflow({key, run: fn as AnyWorkflowFn});
    }
    resetActivityRegistry();
    registerActivityImpls(Object.fromEntries(savedActivities));
  });

  it('runs a workflow through create → watch → resolve signal → close', async () => {
    const handle = rt.start('incidentTicket', {
      incidentId: '1234',
      summary: 'API error rate above 5%',
    });

    // Play the human: once the ticket exists, resolve it from outside.
    const issue = await eventually(
      () => fakeTracker.byExternalId('incident/1234'),
      'the incident issue to be created',
    );
    fakeTracker.forceTransition(issue.key, 'resolved');

    const result = (await handle.result()) as {
      issueKey: string;
      resolvedFrom: string;
    };
    expect(result.issueKey).toBe(issue.key);
    expect(result.resolvedFrom).toBe('open');
    expect(fakeTracker.issues.get(issue.key)?.status).toBe('closed');
  });

  it('createIssue is idempotent under the double delivery retries produce', async () => {
    const direct = tracker.direct();
    const first = await direct.command.createIssue({
      projectKey: 'OPS',
      summary: 'exactly one of me',
      externalId: 'once/42',
    });
    const second = await direct.command.createIssue({
      projectKey: 'OPS',
      summary: 'exactly one of me',
      externalId: 'once/42',
    });
    expect(second.key).toBe(first.key);
    const matches = (
      await direct.query.searchIssues({projectKey: 'OPS'})
    ).filter((issue) => issue.externalId === 'once/42');
    expect(matches.length).toBe(1);
  });

  it('transitionIssue converges: a retry landing after success still succeeds', async () => {
    const direct = tracker.direct();
    const issue = await direct.command.createIssue({
      projectKey: 'OPS',
      summary: 'converge on me',
      externalId: 'converge/1',
    });
    await direct.command.transitionIssue({issueKey: issue.key, to: 'resolved'});
    const again = await direct.command.transitionIssue({
      issueKey: issue.key,
      to: 'resolved',
    });
    expect(again.status).toBe('resolved');
  });

  it('non-retryable failures arrive as typed ConnectorErrors', async () => {
    const direct = tracker.direct();
    expect(
      await kindOf(() => direct.query.getIssue({issueKey: 'OPS-999'})),
    ).toBe('notFound');
    expect(
      await kindOf(() =>
        direct.command.createIssue({projectKey: 'OPS'} as never),
      ),
    ).toBe('invalid');
  });

  it('renders the catalogue through the vendor emitter and flags unsafe commands', () => {
    const entries = catalogue([tracker]);

    const create = entries.find((entry) => entry.name === 'createIssue');
    expect(create?.idempotency).toBe('natural');
    expect(Array.isArray(create?.input?.['required'])).toBe(true);
    expect(create?.input?.['required'] as string[]).toContain('externalId');

    const comment = entries.find((entry) => entry.name === 'addComment');
    expect(comment?.idempotency).toBe('unsafe');
    expect(comment?.unsafeBecause).toBeTruthy();

    const trig = entries.find((entry) => entry.kind === 'trigger');
    expect(trig?.name).toBe('issueTransitioned');
    expect(trig?.event).toBeDefined();
    expect(trig?.filter).toBeDefined();
  });

  it('parses watch intervals: milliseconds and duration text', () => {
    expect(toMs(250)).toBe(250);
    expect(toMs('30 seconds')).toBe(30_000);
    expect(toMs('5 minutes')).toBe(300_000);
    expect(toMs('2 hours')).toBe(7_200_000);
    expect(toMs('100ms')).toBe(100);
    expect(() => toMs('a fortnight')).toThrow();
  });
});

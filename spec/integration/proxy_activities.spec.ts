/**
 * @fileoverview
 * `proxyActivities` — declaring the activities a workflow calls, which registers
 * them.
 *
 * The problem it solves is one of scale rather than keystrokes. A worker is handed
 * its activities as one object, and for a small artifact a module namespace keeps
 * that honest by itself. It stops being honest when a workflow is decomposed across
 * helper modules that each reach for their own activities: the entrypoint has to
 * name every one of those modules from memory, nothing checks the list, and an
 * omission surfaces as an execution parked on an activity that retries forever.
 *
 * This file covers the mechanism against an empty registry, via
 * `isolateActivityRegistry()` inside each describe — save and restore rather than
 * clear, because the registry is one map for the whole process and a bare reset would
 * delete what other files declared at load. The case the feature actually exists for —
 * a real workflow module declaring activities in a file the entrypoint never names — is
 * `decomposed_workflow.spec.ts`, which relies on exactly those load-time declarations.
 */

import 'jasmine';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {
  activityNameConflicts,
  registeredActivityImpls,
} from '../../src/activity_registry';
import {isolateActivityRegistry} from '../support/isolate_activity_registry';
import {
  createRemoteService,
  createRpcServer,
  createServerHost,
} from '../../src/services';
import {startWorker} from '../../src/tempo';
import {proxyActivities} from '../../src/workflow';

interface Harness {
  url: string;
  service: ReturnType<typeof createRemoteService>;
  teardown: () => Promise<void>;
}

async function startServer(): Promise<Harness> {
  const host = createServerHost();
  const server = createRpcServer(host);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const {port} = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    service: createRemoteService(url),
    teardown: async () => {
      host.shutdown();
      (
        server as Server & {closeAllConnections?: () => void}
      ).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('proxyActivities — one call types and registers', () => {
  isolateActivityRegistry();

  it('returns a proxy that forwards to the activity of the same name', async () => {
    const impls = {greet: (name: string) => `Hello, ${name}!`};
    const act = proxyActivities(impls);
    async function greeter(name: string): Promise<string> {
      return act.greet(name);
    }

    const server = await startServer();
    // No `activities` property: the workflow's own declaration is the wiring.
    const worker = startWorker({
      name: 'greeter',
      serverUrl: server.url,
      workflows: {greeter},
    });

    try {
      const {workflowId} = server.service.start('greeter', ['world']);
      await expectAsync(server.service.getResult(workflowId)).toBeResolvedTo(
        'Hello, world!',
      );
    } finally {
      await worker.stop();
      await server.teardown();
    }
  }, 15000);

  it('drops non-callable members, so a whole module namespace is fine', () => {
    proxyActivities({GREETING: 'Hello', greet: () => 'hi'});

    const worker = startWorker({
      name: 'greeter',
      serverUrl: 'http://127.0.0.1:1',
      workflows: {w: async () => 'x'},
    });
    expect(worker.roles).toEqual(['workflow', 'activity']);
    void worker.stop();
  });

  /**
   * Roles are derived from what a worker has definitions for, so a declaration has
   * to count — otherwise a worker whose activities all arrived this way would refuse
   * `--role=activity` as unsatisfiable while being perfectly able to serve it.
   */
  it('counts declared activities when deciding which roles it can serve', () => {
    // A name no other spec file uses: one registry serves the whole process, so two
    // files declaring different functions under one name is a collision.
    proxyActivities({settleInvoice: () => 'ok'});

    const worker = startWorker({
      name: 'orders',
      serverUrl: 'http://127.0.0.1:1',
      workflows: {w: async () => 'x'},
    });
    expect(worker.roles).toContain('activity');
    void worker.stop();
  });
});

describe('proxyActivities — precedence and collisions', () => {
  isolateActivityRegistry();

  // A caller that supplies its own set is unaffected by what the loaded workflow
  // modules declared, which is what keeps a test double possible.
  it('lets an explicitly passed activity win over a declared one', async () => {
    const act = proxyActivities({greet: () => 'declared'});
    async function greeter(): Promise<string> {
      return act.greet();
    }

    const server = await startServer();
    const worker = startWorker({
      name: 'greeter',
      serverUrl: server.url,
      workflows: {greeter},
      activities: {greet: () => 'passed explicitly'},
    });

    try {
      const {workflowId} = server.service.start('greeter', []);
      await expectAsync(server.service.getResult(workflowId)).toBeResolvedTo(
        'passed explicitly',
      );
    } finally {
      await worker.stop();
      await server.teardown();
    }
  }, 15000);

  // A module genuinely can evaluate twice — two resolution paths, or a bundle plus a
  // `require` — and that is nobody's mistake.
  it('accepts the same function under the same name twice', () => {
    const greet = (): string => 'hi';

    proxyActivities({greet});
    expect(() => proxyActivities({greet})).not.toThrow();
  });

  /**
   * Last-write-wins rather than a throw, and the reason is not squeamishness.
   * Registration now happens inside every `proxyActivities` call, and those run at
   * module load — so a throw fires while modules are still evaluating, before any
   * application or test setup exists to catch it. A process that loads two workflow
   * modules claiming one name would crash on import rather than report a
   * diagnosable error, and this repo's own suite is such a process.
   */
  it('lets the last registration win when two implementations claim a name', () => {
    proxyActivities({greet: () => 'first'});

    expect(() => proxyActivities({greet: () => 'second'})).not.toThrow();
    expect(Object.fromEntries(registeredActivityImpls())['greet']?.()).toBe(
      'second',
    );
  });

  // Not silent, though: `startWorker` logs one `activity.name_conflict` per name, so
  // an artifact running the wrong implementation says so in its own log.
  it('records the conflict so a worker can report it', () => {
    proxyActivities({greet: () => 'first'});
    proxyActivities({greet: () => 'second'});

    expect(activityNameConflicts()).toContain('greet');
  });

  it('records nothing when the same function is registered twice', () => {
    const greet = (): string => 'hi';

    proxyActivities({greet});
    proxyActivities({greet});

    expect(activityNameConflicts()).toEqual([]);
  });

  /**
   * Snapshotted at construction: a worker's set must not shift after the readiness
   * line has already reported what it serves.
   */
  it('does not pick up activities declared after a worker started', () => {
    const worker = startWorker({
      name: 'workflows-only',
      serverUrl: 'http://127.0.0.1:1',
      workflows: {w: async () => 'x'},
    });
    proxyActivities({tooLateToMatter: () => 'x'});

    expect(worker.roles).toEqual(['workflow']);
    void worker.stop();
  });
});

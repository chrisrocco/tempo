/**
 * @fileoverview
 * `Tempo.registerActivities` — activities registering themselves where they are
 * defined, in the shape of `customElements.define`.
 *
 * The point is that an activity cannot be defined and then forgotten on the way to
 * a worker. That mistake is otherwise close to invisible: `activity_worker` answers
 * an unregistered name with `no activity <name>`, which is an activity *failure*, so
 * it retries with backoff and the execution parks. Nothing says "the worker is
 * missing this".
 *
 * What is pinned here is mostly that it stays a **default** rather than becoming the
 * mechanism. A process-global registry is the one piece of ambient state in this
 * repo, and the reason it is tolerable is that anything needing isolation — 42 local
 * runtimes in `local.spec.ts`, 14 workers in `worker_entrypoint.spec.ts` — keeps
 * passing its own activities and is unaffected by what the process has imported.
 */

import 'jasmine';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {
  registerActivities,
  resetRegisteredActivities,
  startWorker,
} from '../../src/tempo';
import {
  createRemoteService,
  createRpcServer,
  createServerHost,
} from '../../src/services';
import {runActivity} from '../../src/workflow';

/** The global registry is shared, so every case starts from empty. */
afterEach(() => {
  resetRegisteredActivities();
});

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

async function greeter(name: string): Promise<string> {
  return runActivity<string>('greet', name);
}

describe('registerActivities — defining and registering in one place', () => {
  it('runs a workflow whose activity was never passed to startWorker', async () => {
    registerActivities({greet: (name: string) => `Hello, ${name}!`});
    const server = await startServer();
    // No `activities` property at all — the registration is the wiring.
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

  /**
   * Roles are derived from what a worker has definitions for, so a registration has
   * to count. Otherwise a worker with only registered activities would refuse
   * `--role=activity` as unsatisfiable while being perfectly able to serve it.
   */
  it('counts registered activities when deciding which roles it can serve', () => {
    registerActivities({greet: () => 'hi'});
    const worker = startWorker({
      name: 'greeter',
      serverUrl: 'http://127.0.0.1:1',
      workflows: {greeter},
    });

    expect(worker.roles).toEqual(['workflow', 'activity']);
    void worker.stop();
  });

  it('ignores non-callable properties, so a whole module namespace is fine', () => {
    registerActivities({GREETING: 'Hello', greet: () => 'hi'});
    const worker = startWorker({
      name: 'greeter',
      serverUrl: 'http://127.0.0.1:1',
      activities: {},
      workflows: {greeter},
    });

    expect(worker.roles).toEqual(['workflow', 'activity']);
    void worker.stop();
  });
});

describe('registerActivities — it is a default, not the mechanism', () => {
  /**
   * The property that makes a process-global tolerable. A caller that passes its own
   * activities is unaffected by whatever else the process imported, which is what
   * keeps the local runtime and every worker spec isolated.
   */
  it('lets an explicitly passed activity win over a registered one', async () => {
    registerActivities({greet: () => 'from the global registry'});
    const server = await startServer();
    const worker = startWorker({
      name: 'greeter',
      serverUrl: server.url,
      workflows: {greeter},
      activities: {greet: () => 'passed explicitly'},
    });

    try {
      const {workflowId} = server.service.start('greeter', ['world']);
      await expectAsync(server.service.getResult(workflowId)).toBeResolvedTo(
        'passed explicitly',
      );
    } finally {
      await worker.stop();
      await server.teardown();
    }
  }, 15000);

  it('leaves a worker that registers nothing globally exactly as it was', () => {
    const worker = startWorker({
      name: 'workflows-only',
      serverUrl: 'http://127.0.0.1:1',
      workflows: {greeter},
    });

    expect(worker.roles).toEqual(['workflow']);
    void worker.stop();
  });

  /**
   * Snapshotted at construction rather than read through on every task: a worker's
   * registered set should not shift under it mid-life, and both `roles` and the
   * `WORKER_READY` line are derived from it.
   */
  it('does not pick up activities registered after it started', () => {
    const worker = startWorker({
      name: 'workflows-only',
      serverUrl: 'http://127.0.0.1:1',
      workflows: {greeter},
    });
    registerActivities({greet: () => 'too late'});

    expect(worker.roles).toEqual(['workflow']);
    void worker.stop();
  });
});

/**
 * The seam where the two features meet, which neither side of the merge that
 * created it had a reason to test.
 *
 * `--local` runs one workflow in-process with no server, and it is the cheapest way
 * to prove a *built* artifact registered what it should. If it did not see
 * module-scope registrations it would report a self-registering artifact as broken —
 * the exact false alarm it exists to rule out.
 */
describe('registerActivities — a local run sees them too', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
    // `startLocalRun` reports the run's outcome by setting `process.exitCode`, so
    // leaving it set would fail the whole suite from a passing spec.
    process.exitCode = undefined;
  });

  it('runs a registered activity under --local, with no server anywhere', async () => {
    registerActivities({greet: (name: string) => `Hello, ${name}!`});
    process.argv = [...originalArgv, '--local=greeter', '--args=["world"]'];

    // A local run prints its result to stdout and does not expose a promise, so the
    // result is read the way a launch site reads it.
    let out = '';
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      out += String(chunk);
      return true;
    };
    try {
      startWorker({name: 'greeter', workflows: {greeter}});
      const deadline = Date.now() + 5000;
      while (out === '' && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.stdout.write = write;
    }

    expect(out.trim()).toBe('"Hello, world!"');
    expect(process.exitCode).toBe(0);
  }, 15000);
});

describe('registerActivities — collisions', () => {
  /**
   * A module genuinely can evaluate twice — resolved through two paths, or present
   * in both a bundle and a `require` — and that is nobody's mistake.
   */
  it('accepts the same function under the same name twice', () => {
    const greet = (): string => 'hi';

    registerActivities({greet});
    expect(() => registerActivities({greet})).not.toThrow();
  });

  // Like `customElements.define`. Keeping one of two implementations silently is the
  // kind of wrong that surfaces as an activity behaving oddly in production.
  it('refuses a different function under a name already taken', () => {
    registerActivities({greet: () => 'first'});

    expect(() => registerActivities({greet: () => 'second'})).toThrowError(
      /activity "greet" is already registered as a different function/,
    );
  });

  it('names the activity that collided', () => {
    registerActivities({sendEmail: () => 'first'});

    expect(() => registerActivities({sendEmail: () => 'second'})).toThrowError(
      /sendEmail/,
    );
  });
});

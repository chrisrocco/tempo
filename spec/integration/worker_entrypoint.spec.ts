/**
 * @fileoverview
 * `startWorker` as a caller meets it: what it registers, which server it
 * connects to, and what it refuses.
 *
 * These are internals specs (per AGENTS.md's two-kinds split) — the entrypoint
 * is host wiring rather than the programming model, which
 * `spec/integration/local.spec.ts` documents. What is pinned here is the part
 * between the module namespace and a running execution: the registration the
 * entrypoint does on the caller's behalf, and the precedence rules that decide
 * where the work goes.
 *
 * Every case runs against a real server on loopback, because a worker only has
 * one shape now — poll loops against a `RemoteService`. These used to compose an
 * in-process runtime through `--runtime=local` to avoid the port; that flag is
 * gone (see `src/tempo.ts`), and a loopback server is cheap enough that it was
 * never the reason to keep it.
 */

import 'jasmine';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {
  createRemoteService,
  createRpcServer,
  createServerHost,
} from '../../src/services';
import {isolateActivityRegistry} from '../support/isolate_activity_registry';
import {DEFAULT_PORT} from '../../src/process_flags';
import {
  DEFAULT_SERVER_URL,
  requestedRole,
  resolveServerUrl,
  resolveActivityConcurrency,
  resolveTaskQueue,
  startWorker,
} from '../../src/tempo';
import {proxyActivities} from '../../src/workflow';

/** The reference shape: a module namespace holding a constant and an activity. */
const activities = {
  GREETING: 'Hello',
  // A name unique to this file: the registry is one map for the whole process, so two
  // fixtures sharing an activity name is a conflict a worker now refuses to start on.
  greetForEntrypoint: (name: string): string => `Hello, ${name}!`,
};

const act = proxyActivities(activities);

async function greeter(name: string): Promise<string> {
  return act.greetForEntrypoint(name);
}

const workflows = {greeter};

/** A live server on loopback, plus the client and teardown that go with it. */
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

/**
 * `startWorker` reads `process.argv` directly, because a deployed binary has no
 * caller to pass it. Specs that exercise that reading put it back afterwards.
 *
 * Note what the test runner's own argv proves incidentally: it carries
 * `--config=` and, when filtered, `--filter=`, and a worker constructed under it
 * starts anyway. Unknown flags have to be ignored, which is the constraint
 * `process_flags.ts` records — a worker that rejected an argv it did not
 * recognize could not be built inside a spec at all.
 */
const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
});

/** Run as if launched with these flags appended to the command line. */
function launchedWith(...flags: string[]): void {
  process.argv = [...originalArgv, ...flags];
}

/**
 * Retry until a value appears. A worker's first poll is what registers it, so
 * anything asking the server "who is out there" has to wait for one to land.
 */
async function pollUntil<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error('timed out waiting for a worker');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('worker entrypoint — registering what it was handed', () => {
  isolateActivityRegistry();

  it('registers both halves from the module namespaces it was handed', async () => {
    const server = await startServer();
    try {
      const worker = startWorker({
        name: 'greeter',
        serverUrl: server.url,
        workflows,
        activities,
      });

      expect(worker.roles).toEqual(['workflow', 'activity']);
      await worker.stop();
    } finally {
      await server.teardown();
    }
  });

  // The constant sitting beside the activity is the case: a module namespace
  // carries whatever the module exported, and only the callables may register.
  it('runs a workflow whose activity module also exports constants', async () => {
    const server = await startServer();
    const worker = startWorker({
      name: 'greeter',
      serverUrl: server.url,
      workflows,
      activities,
    });

    try {
      const {workflowId} = server.service.start('greeter', ['ada']);
      await expectAsync(server.service.getResult(workflowId)).toBeResolvedTo(
        'Hello, ada!',
      );
    } finally {
      await worker.stop();
      await server.teardown();
    }
  });
});

describe('worker entrypoint — choosing a server', () => {
  isolateActivityRegistry();

  it('connects to the server it was given in code', async () => {
    const server = await startServer();
    const worker = startWorker({
      name: 'greeter',
      serverUrl: server.url,
      workflows,
      activities,
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
  });

  /**
   * The precedence that keeps one artifact redeployable: the code's URL is the
   * default it ships with, and the launch site is the deployment. Proven by
   * pointing the code at a closed port — the work still lands, so the flag is
   * what was dialled.
   */
  it('lets the launch site override the server the code shipped with', async () => {
    const server = await startServer();
    launchedWith(`--server=${server.url}`);

    const worker = startWorker({
      name: 'greeter',
      serverUrl: 'http://127.0.0.1:1',
      workflows,
      activities,
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
  });
});

/**
 * The precedence rules on their own, without a worker or a global to rewrite.
 * These are the functions `startWorker` calls, and each takes its argv rather
 * than reaching for `process.argv` precisely so this block can exist.
 */
describe('worker entrypoint — resolving configuration', () => {
  it('prefers the launch site, then the code, then the default', () => {
    expect(resolveServerUrl(['--server=http://a:1'], 'http://b:2')).toBe(
      'http://a:1',
    );
    expect(resolveServerUrl([], 'http://b:2')).toBe('http://b:2');
    expect(resolveServerUrl([], undefined)).toBe(DEFAULT_SERVER_URL);
  });

  it('applies the same precedence to the queue', () => {
    expect(resolveTaskQueue(['--queue=fast'], 'slow')).toBe('fast');
    expect(resolveTaskQueue([], 'slow')).toBe('slow');
    expect(resolveTaskQueue([], undefined)).toBe('default');
  });

  it('applies the same precedence to activity concurrency', () => {
    expect(resolveActivityConcurrency(['--activity-concurrency=8'], 2)).toBe(8);
    expect(resolveActivityConcurrency([], 2)).toBe(2);
    // Undefined rather than 1: the loop owns its own default, so the entrypoint
    // does not have to know it and the two cannot drift apart.
    expect(resolveActivityConcurrency([], undefined)).toBeUndefined();
  });

  it('refuses an activity concurrency that is not a positive integer', () => {
    // A typo in a unit file, and the failure mode it prevents is quiet: a worker
    // that fell back to running one at a time would look perfectly healthy while
    // delivering none of the throughput it was redeployed for.
    for (const bad of ['abc', '0', '-2', '2.5']) {
      expect(() =>
        resolveActivityConcurrency([`--activity-concurrency=${bad}`], 4),
      ).toThrowError(/positive integer/);
    }
  });

  it('leaves an empty activity concurrency to the shared flag guard', () => {
    // `--activity-concurrency=` is refused one level down, by the same rule that
    // refuses a bare `--data-dir`: a flag given without a value is someone who
    // meant to say something. Asserted here so the two messages are not quietly
    // merged into one that fits neither.
    expect(() =>
      resolveActivityConcurrency(['--activity-concurrency='], 4),
    ).toThrowError(/needs a value/);
  });

  it('reports which source asked for a role', () => {
    expect(requestedRole(['--role=activity'], 'workflow')).toEqual({
      value: 'activity',
      source: '--role',
    });
    expect(requestedRole([], 'workflow')).toEqual({
      value: 'workflow',
      source: 'role',
    });
    expect(requestedRole([], undefined)).toBeUndefined();
  });

  // The port both sides of a deployment have to agree on. A worker dialling one
  // number while the server binds another is a deployment where every process is
  // healthy and no work ever moves.
  it('defaults to the port the server defaults to binding', () => {
    expect(DEFAULT_SERVER_URL).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
    expect(DEFAULT_PORT).toBe(7777);
  });
});

describe('worker entrypoint — what it refuses', () => {
  isolateActivityRegistry();

  it('refuses a role the binary cannot serve', () => {
    launchedWith('--role=activity');

    expect(() => startWorker({name: 'workflows-only', workflows})).toThrowError(
      /registers no activities/,
    );
  });

  it('refuses a worker that registers nothing', () => {
    expect(() => startWorker({name: 'empty'})).toThrowError(
      /registers no workflows or activities/,
    );
  });

  it('refuses a role that is not one of the two', () => {
    launchedWith('--role=cluster');

    expect(() =>
      startWorker({name: 'greeter', workflows, activities}),
    ).toThrowError(/must be "workflow" or "activity".*cluster/);
  });

  // A unit file and a source file are very different things to go and fix, so
  // "this binary cannot serve that role" is only actionable if it says which.
  it('names the flag or the options object, whichever asked', () => {
    expect(() =>
      startWorker({name: 'workflows-only', role: 'activity', workflows}),
    ).toThrowError(/started as role=activity/);

    launchedWith('--role=activity');
    expect(() => startWorker({name: 'workflows-only', workflows})).toThrowError(
      /started as --role=activity/,
    );
  });
});

describe('worker entrypoint — the options object is the configuration', () => {
  isolateActivityRegistry();

  it('takes the role from code, with no flag in sight', () => {
    const worker = startWorker({
      name: 'greeter',
      role: 'workflow',
      serverUrl: 'http://127.0.0.1:1', // never reached: nothing is started
      workflows,
      activities,
    });

    expect(worker.roles).toEqual(['workflow']);
    void worker.stop();
  });

  // The exception, and the only reason it exists: one artifact, two services.
  it('lets the launch site override the role the code shipped with', () => {
    launchedWith('--role=activity');

    const worker = startWorker({
      name: 'greeter',
      role: 'workflow',
      serverUrl: 'http://127.0.0.1:1',
      workflows,
      activities,
    });

    expect(worker.roles).toEqual(['activity']);
    void worker.stop();
  });

  /**
   * `identity` is the config with no launch-site override on purpose — a
   * container passes `process.env['HOSTNAME']` through the options object
   * instead. So the thing worth proving is that it travels: the name a
   * deployment chooses is the name an operator reads back out of `tempo
   * queues`, which is the whole point of setting it.
   */
  it('sends the identity it was configured with to the server', async () => {
    const server = await startServer();
    const worker = startWorker({
      name: 'greeter',
      serverUrl: server.url,
      identity: 'greeter-7f3a@cluster-b',
      workflows,
      activities,
    });

    try {
      const identities = await pollUntil(async () => {
        const queues = await server.service.listQueues();
        const names = queues.flatMap((queue) =>
          queue.workers.map((seen) => seen.identity),
        );
        return names.includes('greeter-7f3a@cluster-b') ? names : undefined;
      });

      expect(identities).toContain('greeter-7f3a@cluster-b');
    } finally {
      await worker.stop();
      await server.teardown();
    }
  });

  it('defaults the identity to something an operator can act on', async () => {
    const server = await startServer();
    const worker = startWorker({
      name: 'greeter',
      serverUrl: server.url,
      workflows,
      activities,
    });

    try {
      const identities = await pollUntil(async () => {
        const queues = await server.service.listQueues();
        const names = queues.flatMap((queue) =>
          queue.workers.map((seen) => seen.identity),
        );
        return names.length > 0 ? names : undefined;
      });

      // `${pid}@${hostname}` — the convention Temporal uses, and a string that
      // leads somewhere rather than an opaque handle.
      expect(identities[0]).toMatch(/^\d+@.+/);
    } finally {
      await worker.stop();
      await server.teardown();
    }
  });

  // Pass-through, so what is worth pinning is that the entrypoint accepts them
  // at all — a knob that exists on the loop and not here is one a deployment
  // cannot reach without editing the engine.
  it('accepts the poll timings the loops understand', async () => {
    const server = await startServer();
    const worker = startWorker({
      name: 'greeter',
      serverUrl: server.url,
      pollIntervalMs: 5,
      errorBackoffMs: 10,
      maxErrorBackoffMs: 100,
      workflows,
      activities,
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
  });
});

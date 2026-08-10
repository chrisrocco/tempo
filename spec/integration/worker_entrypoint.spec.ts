/**
 * @fileoverview
 * `Tempo.startWorker` as a caller meets it: what it registers, which server it
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
import {startWorker} from '../../src/tempo';
import {proxyActivities} from '../../src/workflow';

/** The reference shape: a module namespace holding a constant and an activity. */
const activities = {
  GREETING: 'Hello',
  greet: (name: string): string => `Hello, ${name}!`,
};

const act = proxyActivities<typeof activities>({});

async function greeter(name: string): Promise<string> {
  return act.greet(name);
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
 * `startWorker` reads `process.env` directly, because a deployed binary has no
 * caller to pass it. Specs that exercise that reading put it back afterwards.
 */
const originalRole = process.env['TEMPO_ROLE'];
const originalServerUrl = process.env['TEMPO_SERVER_URL'];

afterEach(() => {
  restore('TEMPO_ROLE', originalRole);
  restore('TEMPO_SERVER_URL', originalServerUrl);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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
   * default it ships with, and the environment is the deployment. Proven by
   * pointing the code at a closed port — the work still lands, so the
   * environment is what was dialled.
   */
  it('lets the environment override the server the code shipped with', async () => {
    const server = await startServer();
    process.env['TEMPO_SERVER_URL'] = server.url;

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

describe('worker entrypoint — what it refuses', () => {
  it('refuses a role the binary cannot serve', () => {
    process.env['TEMPO_ROLE'] = 'activity';

    expect(() => startWorker({name: 'workflows-only', workflows})).toThrowError(
      /registers no activities/,
    );
  });

  it('refuses a worker that registers nothing', () => {
    expect(() => startWorker({name: 'empty'})).toThrowError(
      /registers no workflows or activities/,
    );
  });

  // The error has to name where the ask was written, because "this binary
  // cannot serve that role" is only actionable if you know which file to open.
  it('names the environment or the options object, whichever asked', () => {
    expect(() =>
      startWorker({name: 'workflows-only', role: 'activity', workflows}),
    ).toThrowError(/started as role=activity/);

    process.env['TEMPO_ROLE'] = 'activity';
    expect(() => startWorker({name: 'workflows-only', workflows})).toThrowError(
      /started as TEMPO_ROLE=activity/,
    );
  });
});

describe('worker entrypoint — the options object is the configuration', () => {
  it('takes the role from code, with no environment variable in sight', () => {
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
  it('lets the environment override the role the code shipped with', () => {
    process.env['TEMPO_ROLE'] = 'activity';

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
   * `identity` is the config that has no environment variable on purpose — a
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

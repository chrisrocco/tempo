/**
 * @fileoverview
 * `Tempo.startWorker` as a caller meets it: which runtime it composes, which
 * server it connects to, and what it refuses.
 *
 * These are internals specs (per AGENTS.md's two-kinds split) — the entrypoint
 * is host wiring rather than the programming model, which
 * `spec/integration/local.spec.ts` documents. What is pinned here is the part
 * between the module namespace and a running execution: the registration the
 * entrypoint does on the caller's behalf, and the precedence rules that decide
 * where the work goes.
 *
 * Two of these cases would otherwise only be reachable through a spawned
 * process (`spec/integration/distributed.spec.ts`, `cli.spec.ts`), which is why
 * `--runtime=local` exists at all: an in-process runtime makes the entrypoint
 * itself testable without a port, a server, or a child to wait on.
 */

import 'jasmine';
import type {ChildProcess} from 'node:child_process';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {spawnEntry} from '../../src/cli/process';
import {
  createRemoteService,
  createRpcServer,
  createServerHost,
} from '../../src/services';
import {startWorker, resolveRuntime} from '../../src/tempo';
import {proxyActivities} from '../../src/workflow';
import {repoPath} from '../support/repo_root';

/** The reference deployable binary, run as a deployment would run it. */
const WORKER_ENTRY = repoPath('examples/greeter.ts');

/** Run a worker binary to completion, capturing what it printed. */
function runToCompletion(
  args: string[],
  env: Record<string, string> = {},
): Promise<{code: number | null; out: string; err: string}> {
  return new Promise((resolve) => {
    const proc: ChildProcess = spawnEntry(WORKER_ENTRY, {args, env});
    let out = '';
    let err = '';
    proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('exit', (code) => resolve({code, out, err}));
  });
}

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
 * `startWorker` reads `process.argv` and `process.env` directly, because a
 * deployed binary has no caller to pass them. Specs that exercise that reading
 * put them back afterwards.
 */
const originalArgv = process.argv;
const originalRole = process.env['TEMPO_ROLE'];
const originalServerUrl = process.env['TEMPO_SERVER_URL'];

afterEach(() => {
  process.argv = originalArgv;
  restore('TEMPO_ROLE', originalRole);
  restore('TEMPO_SERVER_URL', originalServerUrl);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('worker entrypoint — choosing a runtime', () => {
  it('runs a workflow end to end in local mode, with no server anywhere', async () => {
    const worker = startWorker({
      name: 'greeter',
      runtime: 'local',
      workflows,
      activities,
    });

    try {
      const handle = worker.localRuntime!.start<string>('greeter', ['world']);
      await expectAsync(handle.result()).toBeResolvedTo('Hello, world!');
    } finally {
      await worker.stop();
    }
  });

  it('registers both halves from the module namespaces it was handed', async () => {
    const worker = startWorker({
      name: 'greeter',
      runtime: 'local',
      workflows,
      activities,
    });

    expect(worker.roles).toEqual(['workflow', 'activity']);
    await worker.stop();
  });

  // The constant sitting beside the activity is the case: a module namespace
  // carries whatever the module exported, and only the callables may register.
  it('starts a workflow whose activity module also exports constants', async () => {
    const worker = startWorker({
      name: 'greeter',
      runtime: 'local',
      workflows,
      activities,
    });

    try {
      const handle = worker.localRuntime!.start<string>('greeter', ['ada']);
      await expectAsync(handle.result()).toBeResolvedTo('Hello, ada!');
    } finally {
      await worker.stop();
    }
  });

  it('leaves a remote worker without a local runtime to reach', async () => {
    const server = await startServer();
    try {
      const worker = startWorker({
        name: 'greeter',
        serverUrl: server.url,
        workflows,
        activities,
      });
      expect(worker.localRuntime).toBeUndefined();
      await worker.stop();
    } finally {
      await server.teardown();
    }
  });

  it('takes the flag from the launch site over the mode in code', async () => {
    process.argv = [...originalArgv, '--runtime=local'];

    const worker = startWorker({
      name: 'greeter',
      runtime: 'remote',
      serverUrl: 'http://127.0.0.1:1', // never dialled: the flag wins
      workflows,
      activities,
    });

    expect(worker.localRuntime).toBeDefined();
    await worker.stop();
  });
});

describe('worker entrypoint — the real binary, run from a command line', () => {
  /**
   * The flag's other use: boot the shipped artifact with no server anywhere and
   * see whether it comes up at all. Every export registers or the process
   * throws, which is the check `--describe` cannot make — it reads names
   * without composing anything.
   *
   * It exits rather than staying up because nothing outside the process can
   * reach a local runtime, so once the module finishes there is no work left to
   * hold the event loop. That is the behaviour, not an accident of the test.
   */
  it('boots the shipped worker binary with no server, and exits cleanly', async () => {
    const {code, out} = await runToCompletion(['--runtime=local']);

    expect(code).toBe(0);
    expect(out).toContain('WORKER_READY greeter workflow,activity default');
  }, 30000);

  it('fails the binary outright when a role is asked of the local runtime', async () => {
    const {code, err} = await runToCompletion(['--runtime=local'], {
      TEMPO_ROLE: 'workflow',
    });

    expect(code).toBe(1);
    expect(err).toContain('no poll loops to split');
  }, 30000);

  // `--describe` reports the artifact's contents without composing anything, so
  // it must keep working under a flag that chooses what to compose.
  it('still describes itself under a runtime flag, without connecting', async () => {
    const {code, out} = await runToCompletion([
      '--runtime=local',
      '--describe',
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(out.trim())).toEqual({
      name: 'greeter',
      workflows: ['greeter'],
      activities: ['greet'],
    });
  }, 30000);
});

describe('worker entrypoint — the runtime flag', () => {
  it('reads the mode the launch site asked for', () => {
    expect(resolveRuntime(['--runtime=local'], undefined)).toBe('local');
    expect(resolveRuntime(['--runtime=remote'], undefined)).toBe('remote');
  });

  it('falls back to the mode the code shipped, then to remote', () => {
    expect(resolveRuntime([], 'local')).toBe('local');
    expect(resolveRuntime([], undefined)).toBe('remote');
  });

  it('lets the flag override the mode in code, in both directions', () => {
    expect(resolveRuntime(['--runtime=local'], 'remote')).toBe('local');
    expect(resolveRuntime(['--runtime=remote'], 'local')).toBe('remote');
  });

  // Guessing what an unfinished argument meant is how a worker ends up in the
  // wrong runtime quietly, which is the one outcome the flag exists to prevent.
  it('refuses a bare --runtime rather than assuming local', () => {
    expect(() => resolveRuntime(['--runtime'], undefined)).toThrowError(
      /takes a value/,
    );
  });

  it('refuses a mode it does not have, and says which it has', () => {
    expect(() => resolveRuntime(['--runtime=cluster'], undefined)).toThrowError(
      /"local" or "remote".*cluster/,
    );
  });

  it('ignores flags meant for something else', () => {
    expect(
      resolveRuntime(['--describe', '--runtime-ish=local'], undefined),
    ).toBe('remote');
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
  /**
   * A role splits the two poll loops, and local mode has none to split. Serving
   * it half-way would park every execution on an activity nothing will run —
   * a hang rather than a failure, which is why this is worth a startup error.
   */
  it('refuses a role under the local runtime, and says why', () => {
    process.env['TEMPO_ROLE'] = 'workflow';

    expect(() =>
      startWorker({name: 'greeter', runtime: 'local', workflows, activities}),
    ).toThrowError(/no poll loops to split/);
  });

  it('still refuses a role the binary cannot serve in remote mode', () => {
    process.env['TEMPO_ROLE'] = 'activity';

    expect(() => startWorker({name: 'workflows-only', workflows})).toThrowError(
      /registers no activities/,
    );
  });

  it('refuses a worker that registers nothing, in either runtime', () => {
    expect(() => startWorker({name: 'empty', runtime: 'local'})).toThrowError(
      /registers no workflows or activities/,
    );
    expect(() => startWorker({name: 'empty'})).toThrowError(
      /registers no workflows or activities/,
    );
  });
});

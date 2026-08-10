/**
 * @fileoverview
 * `tempo start` and `tempo result` against a real server over the RPC.
 *
 * Driven through `runCli` with an argv, not by calling the command functions, so
 * what is covered includes the dispatch and the parsing — a flag wired to the
 * wrong field is exactly the bug a CLI spec should catch and a unit test of the
 * command body cannot.
 *
 * stdout is captured rather than inspected after the fact because what these
 * commands *print* is their contract: an id, or a result, and nothing else on
 * the happy path. A stray line breaks `$(tempo start …)` in a shell.
 */

import 'jasmine';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {runCli} from '../../src/cli/cli';
import {
  createRemoteService,
  createRpcServer,
  createServerHost,
} from '../../src/services';
import {startWorker} from '../../src/tempo';
import {proxyActivities} from '../../src/workflow';

const activities = {
  greet: (name: string): string => `Hello, ${name}!`,
  boom: (): string => {
    throw new Error('activity exploded');
  },
};

const act = proxyActivities<typeof activities>({retry: {maximumAttempts: 1}});

async function greeter(name: string): Promise<string> {
  return act.greet(name);
}

async function adder(a: number, b: number): Promise<number> {
  return a + b;
}

async function thrower(): Promise<string> {
  return act.boom();
}

const workflows = {greeter, adder, thrower};

interface Harness {
  url: string;
  service: ReturnType<typeof createRemoteService>;
  teardown: () => Promise<void>;
}

/** A server and a worker, both real, on a port nobody had to pick. */
async function startDeployment(): Promise<Harness> {
  const host = createServerHost();
  const server = createRpcServer(host);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const {port} = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const worker = startWorker({
    name: 'greeter',
    serverUrl: url,
    workflows,
    activities,
  });

  return {
    url,
    service: createRemoteService(url),
    teardown: async () => {
      await worker.stop();
      host.shutdown();
      (
        server as Server & {closeAllConnections?: () => void}
      ).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Run a command line, capturing what it wrote where. */
async function tempo(
  argv: string[],
): Promise<{code: number; out: string; err: string}> {
  let out = '';
  let err = '';
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    out += String(chunk);
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    err += String(chunk);
    return true;
  };
  try {
    const code = await runCli(argv);
    return {code, out, err};
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

describe('tempo start', () => {
  it('prints the workflow id and leaves the execution running', async () => {
    const d = await startDeployment();
    try {
      const {code, out} = await tempo([
        'start',
        'greeter',
        'world',
        `--server=${d.url}`,
      ]);

      expect(code).toBe(0);
      const workflowId = out.trim();
      expect(workflowId).not.toBe('');
      await expectAsync(d.service.getResult(workflowId)).toBeResolvedTo(
        'Hello, world!',
      );
    } finally {
      await d.teardown();
    }
  }, 15000);

  it('blocks and prints the result under --wait', async () => {
    const d = await startDeployment();
    try {
      const {code, out} = await tempo([
        'start',
        'greeter',
        'world',
        '--wait',
        `--server=${d.url}`,
      ]);

      expect(code).toBe(0);
      expect(out).toBe('Hello, world!\n');
    } finally {
      await d.teardown();
    }
  }, 15000);

  // The typing rule: unquoted words stay strings, and anything JSON-shaped is
  // read as itself. `adder 1 2` returning 3 rather than "12" is the whole point.
  it('passes numeric arguments as numbers', async () => {
    const d = await startDeployment();
    try {
      const {code, out} = await tempo([
        'start',
        'adder',
        '1',
        '2',
        '--wait',
        `--server=${d.url}`,
      ]);

      expect(code).toBe(0);
      expect(out).toBe('3\n');
    } finally {
      await d.teardown();
    }
  }, 15000);

  /**
   * The reason `--wait` exists: a CI job runs one workflow and is told whether it
   * worked. A failed workflow exiting 0 would make that check silently useless.
   */
  it('exits non-zero when the workflow it waited for failed', async () => {
    const d = await startDeployment();
    try {
      const {code, err} = await tempo([
        'start',
        'thrower',
        '--wait',
        `--server=${d.url}`,
      ]);

      expect(code).toBe(1);
      expect(err).toContain('activity exploded');
    } finally {
      await d.teardown();
    }
  }, 15000);

  // A queue nothing is polling parks the execution forever, so the flag has to
  // actually reach the server rather than being accepted and dropped.
  it('starts on the queue it was given', async () => {
    const d = await startDeployment();
    try {
      const {code, out} = await tempo([
        'start',
        'greeter',
        'world',
        '--queue=nobody-serves-this',
        `--server=${d.url}`,
      ]);

      expect(code).toBe(0);
      const detail = await d.service.describeExecution(out.trim());
      expect(detail?.taskQueue).toBe('nobody-serves-this');
      expect(detail?.status).toBe('running');
    } finally {
      await d.teardown();
    }
  }, 15000);

  it('fails with the command that would fix it when no server is there', async () => {
    const {code, err} = await tempo([
      'start',
      'greeter',
      '--server=http://127.0.0.1:1',
    ]);

    expect(code).toBe(1);
    expect(err).toContain('cannot reach a tempo server');
    expect(err).toContain('tempo up');
  }, 15000);

  it('names the missing workflow name rather than starting nothing', async () => {
    const {code, err} = await tempo(['start']);

    expect(code).toBe(1);
    expect(err).toContain('missing workflow name');
  });
});

describe('tempo result', () => {
  it('redeems the id a bare start printed', async () => {
    const d = await startDeployment();
    try {
      const started = await tempo([
        'start',
        'greeter',
        'ada',
        `--server=${d.url}`,
      ]);
      const {code, out} = await tempo([
        'result',
        started.out.trim(),
        `--server=${d.url}`,
      ]);

      expect(code).toBe(0);
      expect(out).toBe('Hello, ada!\n');
    } finally {
      await d.teardown();
    }
  }, 15000);

  it('exits non-zero for an execution that failed', async () => {
    const d = await startDeployment();
    try {
      const started = await tempo(['start', 'thrower', `--server=${d.url}`]);
      const {code, err} = await tempo([
        'result',
        started.out.trim(),
        `--server=${d.url}`,
      ]);

      expect(code).toBe(1);
      expect(err).toContain('activity exploded');
    } finally {
      await d.teardown();
    }
  }, 15000);

  it('names the missing workflow id', async () => {
    const {code, err} = await tempo(['result']);

    expect(code).toBe(1);
    expect(err).toContain('missing workflow id');
  });
});

describe('tempo — the surface itself', () => {
  it('prints usage with no command, and exits successfully', async () => {
    const {code, out} = await tempo([]);

    expect(code).toBe(0);
    expect(out).toContain('tempo start');
    expect(out).toContain('tempo result');
  });

  it('names an unknown command and shows what it does know', async () => {
    const {code, err} = await tempo(['deploy']);

    expect(code).toBe(1);
    expect(err).toContain('unknown command "deploy"');
    expect(err).toContain('tempo start');
  });
});

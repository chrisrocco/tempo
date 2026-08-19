/**
 * @fileoverview
 * `--local`: the built worker artifact running one workflow with no server.
 *
 * Two layers, because the flag makes two separate claims and only one of them
 * can be checked cheaply:
 *
 * - **`resolveLocalRun` and `runLocally`**, in-process — what the launch site
 *   asked for, what it refuses, and that the workflow actually runs against the
 *   registries the entrypoint was handed.
 * - **The real binary, spawned** — the claim the in-process cases cannot make.
 *   The reason this flag exists is to prove a *shipped artifact* has its
 *   workflows registered, and an assertion that never leaves this process proves
 *   nothing about a process. These cases run `examples/greeter.ts` the way a
 *   developer would and read its stdout and exit code.
 *
 * The refusals get as much room as the happy path on purpose. `--local` in a
 * supervisor's command line is the failure mode this feature introduces — a
 * service that runs one workflow, exits, and is restarted forever — so what the
 * flag does when combined with deployment flags is part of its contract rather
 * than an edge case.
 */

import 'jasmine';
import {spawn} from 'node:child_process';
import {resolveLocalRun, runLocally} from '../../src/tempo';
import {runActivity} from '../../src/workflow';
import {repoPath} from '../support/repo_root';

const GREETER = repoPath('examples/greeter.ts');

/** The registries `startWorker` builds from module namespaces, as it builds them. */
const activities: [string, (...args: any[]) => unknown][] = [
  ['greet', (name: string) => `Hello, ${name}!`],
  [
    'explode',
    () => {
      throw new Error('activity blew up');
    },
  ],
];
const workflows: [string, (...args: any[]) => unknown][] = [
  ['greeter', ({name}: {name: string}) => runActivity<string>('greet', name)],
  ['detonator', () => runActivity('explode')],
];

const registrations = {workflows, activities};

/** Run a deployable entrypoint the way a developer would, and collect all of it. */
function runBinary(
  args: string[],
): Promise<{code: number | null; out: string; err: string}> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', GREETER, ...args],
      {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({code, out, err}));
  });
}

describe('--local — what the launch site asked for', () => {
  it('is absent unless --local was given', () => {
    expect(resolveLocalRun([])).toBeUndefined();
    expect(resolveLocalRun(['--role=workflow'])).toBeUndefined();
  });

  it('names the workflow, and defaults to no props', () => {
    expect(resolveLocalRun(['--local=greeter'])).toEqual({
      workflow: 'greeter',
      props: undefined,
    });
  });

  it('reads props as a JSON object', () => {
    expect(
      resolveLocalRun(['--local=greeter', '--props={"name":"world","n":2}']),
    ).toEqual({
      workflow: 'greeter',
      props: {name: 'world', n: 2},
    });
  });

  it('refuses --local without a workflow to run', () => {
    // There are no boolean flags in this repo, and a local run has to know what
    // to run — so the existing "needs a value" rejection is the right answer
    // rather than something this flag has to special-case.
    expect(() => resolveLocalRun(['--local='])).toThrowError(
      /--local needs a value/,
    );
  });
});

describe('--local — the flags it refuses', () => {
  it('refuses --server, rather than picking one of two contradictory launch sites', () => {
    // Guessing means either running locally a workflow the caller wanted sent to
    // a server, or silently ignoring a server they named. Both are worse than
    // failing to start.
    expect(() =>
      resolveLocalRun(['--local=greeter', '--server=http://127.0.0.1:7777']),
    ).toThrowError(/--server cannot be combined with --local/);
  });

  it('refuses --role, which could only narrow a local run into a stuck one', () => {
    // One in-process pair serves every queue here. A role would leave the
    // execution parked on work nothing in the process will claim.
    expect(() =>
      resolveLocalRun(['--local=greeter', '--role=workflow']),
    ).toThrowError(/--role cannot be combined with --local/);
  });

  it('refuses props that are not a JSON object', () => {
    // A workflow takes one props object. A bare string arrives as something it
    // cannot destructure and fails somewhere inside it, which is much further
    // from the mistake.
    expect(() =>
      resolveLocalRun(['--local=greeter', '--props="world"']),
    ).toThrowError(/--props must be a JSON object/);
    expect(() =>
      resolveLocalRun(['--local=greeter', '--props=not json']),
    ).toThrowError(/--props must be JSON/);
  });

  it('names the array case, which is what the old --args spelling passed', () => {
    // The one wrong shape that used to be the *only* right one, so it is what a
    // command line written against the previous flag still carries. Saying so is
    // the difference between a one-line fix and re-reading the entrypoint.
    expect(() =>
      resolveLocalRun(['--local=greeter', '--props=["world"]']),
    ).toThrowError(/--props must be a JSON object, not an array/);
  });
});

describe('--local — running the workflow', () => {
  it('runs it against the registries the entrypoint was handed', async () => {
    const result = await runLocally(
      {workflow: 'greeter', props: {name: 'world'}},
      registrations,
    );

    // Through a real activity, so this covers the registration of both halves —
    // a workflow that resolved without its activity would prove much less.
    expect(result).toBe('Hello, world!');
  });

  it('rejects for a workflow the artifact does not have', async () => {
    // The whole reason the flag earns its place: an artifact whose workflows were
    // never registered otherwise says nothing until executions park on a queue
    // whose workers reject every task.
    await expectAsync(
      runLocally({workflow: 'absent', props: undefined}, registrations),
    ).toBeRejectedWithError(/no workflow registered as absent/);
  });

  it('rejects with the workflow’s own failure', async () => {
    await expectAsync(
      runLocally({workflow: 'detonator', props: undefined}, registrations),
    ).toBeRejectedWithError(/activity blew up/);
  });

  it('leaves nothing holding the event loop open', async () => {
    // The runtime's timers are what would keep a finished run alive, and the
    // process is expected to exit on its own rather than being killed — see
    // `startLocalRun`, which sets `process.exitCode` instead of calling
    // `process.exit` so stdout is not truncated. If this ever regressed the
    // spawned cases below would hang rather than fail.
    await runLocally(
      {workflow: 'greeter', props: {name: 'world'}},
      registrations,
    );
    expect(true).toBeTrue();
  });
});

describe('--local — the real binary', () => {
  it('prints the result as JSON on stdout and exits 0', async () => {
    const {code, out, err} = await runBinary([
      '--local=greeter',
      '--props={"name":"world"}',
    ]);

    expect(code).toBe(0);
    // JSON, so a caller can parse it, and so a workflow returning nothing is
    // `null` rather than the word "undefined".
    expect(out.trim()).toBe('"Hello, world!"');
    // stdout carries the result and nothing else: no readiness line, because
    // this process is not a worker and nothing is going to poll.
    expect(out).not.toContain('WORKER_READY');
    expect(err).toContain('LOCAL RUN');
  }, 30000);

  it('says LOCAL RUN on stderr before it runs, on every run', async () => {
    const {err} = await runBinary([
      '--local=greeter',
      '--props={"name":"world"}',
    ]);

    // The only defence against a `--local` left in a supervisor's command line.
    // Nothing here can detect a supervisor — that would mean knowing which one,
    // which is the knowledge this repo deliberately does not carry — so the
    // banner has to be unmissable in a log instead. It names what the process
    // will do and what it is not.
    expect(err).toMatch(/LOCAL RUN greeter greeter/);
    expect(err).toMatch(/Not a deployment/);
  }, 30000);

  it('exits 1 for a workflow the artifact does not register', async () => {
    const {code, err} = await runBinary(['--local=absent']);

    // Usable as a build check: a non-zero exit is what a CI step reads.
    expect(code).toBe(1);
    expect(err).toContain('no workflow registered as absent');
  }, 30000);

  it('does not need a server to be running anywhere', async () => {
    // Nothing was started before this case, and the default server URL points at
    // a port nothing is listening on. A local run that quietly fell back to the
    // remote composition would hang here rather than answer.
    const {code, out} = await runBinary([
      '--local=greeter',
      '--props={"name":"alone"}',
    ]);

    expect(code).toBe(0);
    expect(out.trim()).toBe('"Hello, alone!"');
  }, 30000);
});

/**
 * @fileoverview
 * The `tempo` CLI end to end, as a user runs it: `tempo up` supervises a real
 * server + worker in the foreground, and the client commands drive workflows
 * through them over RPC. Everything here shells out to bin/tempo.ts — no
 * in-process shortcuts — so the command surface itself is what is under test.
 */

import {spawn, type ChildProcess} from 'node:child_process';
import {forwardOutput, stopChild, waitForLine} from '../../src/cli/process';

const WORKER = 'examples/greeter.ts';
/** A worker whose workflow settles as failed; see its @fileoverview for why. */
const FAILING_WORKER = 'spec/support/failing_worker.ts';

function tempo(args: string[]): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'bin/tempo.ts', ...args], {
    env: {...process.env},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Run a CLI command to completion, capturing what it printed. */
function runTempo(
  args: string[],
): Promise<{code: number | null; out: string; err: string}> {
  return new Promise((resolve) => {
    const proc = tempo(args);
    let out = '';
    let err = '';
    proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('exit', (code) => resolve({code, out, err}));
  });
}

describe('tempo CLI', () => {
  // `tempo up` is the dev loop: one command brings up the whole topology, and
  // the workflow commands drive it. Port 0 takes any free port, and `up` prints
  // the URL it settled on.
  it('brings up a server and worker, then runs a workflow through them', async () => {
    const server = tempo(['up', WORKER, '--port=0']);
    forwardOutput(server, 'up');
    try {
      const [, url] = await waitForLine(
        server,
        /server listening on (\S+)/,
        30000,
      );
      await waitForLine(server, /worker greeter ready/, 30000);

      const {code, out} = await runTempo([
        'start',
        'greeter',
        'world',
        '--wait',
        `--server=${url}`,
      ]);

      expect(code).toBe(0);
      expect(out.trim()).toBe('Hello, world!');
    } finally {
      await stopChild(server);
    }
  }, 60000);

  /**
   * One-shot mode: the whole round-trip as a single foreground command, which is
   * the shortest path from "nothing running" to "a workflow ran on a real worker
   * through a real server". It has to own port discovery and readiness itself —
   * a shell script doing this would have to guess at both.
   */
  it('runs one workflow to completion and stops, with --run', async () => {
    const {code, out} = await runTempo([
      'up',
      WORKER,
      '--port=0',
      '--run=greeter',
      'world',
    ]);

    expect(code).toBe(0);
    expect(out).toContain('Hello, world!');
  }, 60000);

  // The exit code is the workflow's outcome, so this composes in CI: a failed
  // execution must fail the command rather than being reported only in the log.
  it('exits non-zero when the one-shot workflow fails', async () => {
    const {code, err} = await runTempo([
      'up',
      FAILING_WORKER,
      '--port=0',
      '--run=failer',
    ]);

    expect(code).toBe(1);
    expect(err).toContain('activity exploded');
  }, 60000);

  /**
   * `--host` has to reach two places that are easy to change independently: the
   * server's bind, and the URL `up` hands the worker. Binding IPv6 loopback
   * proves both — the worker only connects if the URL was built from the address
   * actually bound *and* bracketed, and it stays off any external interface, so
   * this does not trip a firewall prompt in CI the way 0.0.0.0 would.
   */
  it('binds the host it is given, and the worker still connects', async () => {
    const {code, out} = await runTempo([
      'up',
      WORKER,
      '--host=::1',
      '--port=0',
      '--run=greeter',
      'world',
    ]);

    expect(code).toBe(0);
    expect(out).toContain('http://[::1]:');
    expect(out).toContain('Hello, world!');
    // Loopback is private, so the exposure warning must stay quiet here.
    expect(out).not.toContain('reachable from other machines');
  }, 60000);

  // A workflow started without --wait returns its id immediately; `tempo result`
  // fetches the outcome afterwards, which is the fire-and-forget shape.
  it('starts a workflow detached and fetches its result separately', async () => {
    const server = tempo(['up', WORKER, '--port=0']);
    forwardOutput(server, 'up');
    try {
      const [, url] = await waitForLine(
        server,
        /server listening on (\S+)/,
        30000,
      );
      await waitForLine(server, /worker greeter ready/, 30000);

      const started = await runTempo([
        'start',
        'greeter',
        'world',
        `--server=${url}`,
      ]);
      expect(started.code).toBe(0);
      const workflowId = started.out.trim();
      expect(workflowId).toBeTruthy();

      const fetched = await runTempo(['result', workflowId, `--server=${url}`]);
      expect(fetched.code).toBe(0);
      expect(fetched.out.trim()).toBe('Hello, world!');
    } finally {
      await stopChild(server);
    }
  }, 60000);

  // A command pointed at a server that isn't there fails loudly instead of
  // silently dropping the write into a closed port.
  it('fails with a clear error when no server is reachable', async () => {
    const {code, err} = await runTempo([
      'start',
      'greeter',
      '--server=http://127.0.0.1:1',
    ]);
    expect(code).toBe(1);
    expect(err).toContain('cannot reach a tempo server');
  }, 30000);

  it('reports an unknown command and prints usage', async () => {
    const {code, err} = await runTempo(['nope']);
    expect(code).toBe(1);
    expect(err).toContain('unknown command "nope"');
    expect(err).toContain('tempo up <entry>');
  }, 30000);

  it('lists executions with their status', async () => {
    const server = tempo(['up', WORKER, '--port=0']);
    forwardOutput(server, 'up');
    try {
      const [, url] = await waitForLine(
        server,
        /server listening on (\S+)/,
        30000,
      );
      await waitForLine(server, /worker greeter ready/, 30000);
      await runTempo([
        'start',
        'greeter',
        'world',
        '--wait',
        `--server=${url}`,
      ]);

      const {code, out} = await runTempo(['list', `--server=${url}`]);
      expect(code).toBe(0);
      expect(out).toContain('WORKFLOW ID');
      expect(out).toContain('greeter');
      expect(out).toContain('completed');
    } finally {
      await stopChild(server);
    }
  }, 60000);

  /**
   * The operator's actual question — "which of these is broken?" — against a
   * listing containing both kinds of `running`. A typo'd workflow name is
   * retried forever by design, so it sits in the list looking exactly like a
   * healthy execution unless the row says otherwise.
   */
  it('marks stuck executions in the listing, and filters to them', async () => {
    const server = tempo(['up', WORKER, '--port=0']);
    forwardOutput(server, 'up');
    try {
      const [, url] = await waitForLine(
        server,
        /server listening on (\S+)/,
        30000,
      );
      await waitForLine(server, /worker greeter ready/, 30000);

      await runTempo([
        'start',
        'greeter',
        'world',
        '--wait',
        `--server=${url}`,
      ]);
      const typo = await runTempo([
        'start',
        'greter',
        'world',
        `--server=${url}`,
      ]);
      const stuckId = typo.out.trim();
      await wait(2000); // let the task fail at least once

      const listed = await runTempo(['list', `--server=${url}`]);
      expect(listed.code).toBe(0);
      expect(listed.out).toContain('STUCK');
      expect(listed.out).toContain('no workflow registered as greter');
      expect(listed.out).toContain('greeter'); // the healthy one is still listed

      const filtered = await runTempo(['list', '--stuck', `--server=${url}`]);
      expect(filtered.code).toBe(0);
      expect(filtered.out).toContain(stuckId);
      // The completed execution must not appear — that is the point of --stuck.
      expect(filtered.out).not.toContain('completed');

      // And terminating it clears the listing, so the filter tracks reality.
      await runTempo(['terminate', stuckId, 'typo', `--server=${url}`]);
      const after = await runTempo(['list', '--stuck', `--server=${url}`]);
      expect(after.out).toContain('no stuck executions');
    } finally {
      await stopChild(server);
    }
  }, 60000);

  it('describes a finished execution, including its history', async () => {
    const server = tempo(['up', WORKER, '--port=0']);
    forwardOutput(server, 'up');
    try {
      const [, url] = await waitForLine(
        server,
        /server listening on (\S+)/,
        30000,
      );
      await waitForLine(server, /worker greeter ready/, 30000);
      const started = await runTempo([
        'start',
        'greeter',
        'world',
        '--wait',
        `--server=${url}`,
      ]);
      expect(started.code).toBe(0);
      const [row] = JSON.parse(
        (await runTempo(['list', '--json', `--server=${url}`])).out,
      ) as {workflowId: string}[];

      const {code, out} = await runTempo([
        'describe',
        row.workflowId,
        `--server=${url}`,
      ]);
      expect(code).toBe(0);
      expect(out).toContain('completed');
      expect(out).toContain('result:    Hello, world!');
      expect(out).toContain('activityScheduled seq=0 greet(world)');
      expect(out).toContain('activityCompleted seq=0');
    } finally {
      await stopChild(server);
    }
  }, 60000);

  // The reason this command exists: an execution that is not moving should say
  // what it is waiting for. Running only the workflow role leaves the activity
  // undispatched, which is what a crashed or misconfigured activity tier looks
  // like from the server's side.
  it('reports what a parked execution is waiting on', async () => {
    const server = spawn(
      process.execPath,
      ['--import', 'tsx', 'bin/server-main.ts'],
      {env: {...process.env, PORT: '0'}, stdio: ['ignore', 'pipe', 'pipe']},
    );
    const [, port] = await waitForLine(server, /LISTENING (\d+)/, 30000);
    const url = `http://127.0.0.1:${port}`;
    const worker = spawn(process.execPath, ['--import', 'tsx', WORKER], {
      env: {...process.env, TEMPO_SERVER_URL: url, TEMPO_ROLE: 'workflow'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForLine(worker, /WORKER_READY greeter workflow/, 30000);
      const started = await runTempo([
        'start',
        'greeter',
        'stuck',
        `--server=${url}`,
      ]);
      const workflowId = started.out.trim();

      // Poll until the workflow worker has dispatched the activity.
      let out = '';
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        out = (await runTempo(['describe', workflowId, `--server=${url}`])).out;
        if (out.includes('activity  seq=0')) break;
      }

      expect(out).toContain('running');
      expect(out).toContain('waiting on:');
      expect(out).toContain('activity  seq=0  greet');
    } finally {
      await stopChild(worker);
      await stopChild(server);
    }
  }, 60000);

  // Deliberately no worker: the execution can never make progress, so the
  // terminate is the only thing that can settle it and the assertion cannot race
  // a workflow finishing on its own.
  it('terminates an execution that no worker is advancing', async () => {
    const server = spawn(
      process.execPath,
      ['--import', 'tsx', 'bin/server-main.ts'],
      {env: {...process.env, PORT: '0'}, stdio: ['ignore', 'pipe', 'pipe']},
    );
    try {
      const [, port] = await waitForLine(server, /LISTENING (\d+)/, 30000);
      const url = `http://127.0.0.1:${port}`;
      const started = await runTempo([
        'start',
        'greeter',
        'world',
        `--server=${url}`,
      ]);
      const workflowId = started.out.trim();

      const killed = await runTempo([
        'terminate',
        workflowId,
        'no longer needed',
        `--server=${url}`,
      ]);
      expect(killed.code).toBe(0);

      const {out} = await runTempo([
        'describe',
        workflowId,
        '--json',
        `--server=${url}`,
      ]);
      const detail = JSON.parse(out) as {status: string; failure?: string};
      expect(detail.status).toBe('terminated');
      expect(detail.failure).toBe('no longer needed');
    } finally {
      await stopChild(server);
    }
  }, 60000);

  it('fails with a clear error when the execution does not exist', async () => {
    const server = tempo(['up', WORKER, '--port=0']);
    forwardOutput(server, 'up');
    try {
      const [, url] = await waitForLine(
        server,
        /server listening on (\S+)/,
        30000,
      );
      const {code, err} = await runTempo([
        'describe',
        'no-such-id',
        `--server=${url}`,
      ]);
      expect(code).toBe(1);
      expect(err).toContain('no execution no-such-id');
    } finally {
      await stopChild(server);
    }
  }, 60000);
});

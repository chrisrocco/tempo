// The `tempo` CLI end to end, as a user runs it: `tempo up` supervises a real
// server + worker in the foreground, and the client commands drive workflows
// through them over RPC. Everything here shells out to bin/tempo.ts — no
// in-process shortcuts — so the command surface itself is what is under test.
import { spawn, type ChildProcess } from 'node:child_process';
import { forwardOutput, stopChild, waitForLine } from '../../src/cli/process';

const WORKER = 'examples/greeter/worker.ts';

function tempo(args: string[]): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'bin/tempo.ts', ...args], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Run a CLI command to completion, capturing what it printed. */
function runTempo(
  args: string[],
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const proc = tempo(args);
    let out = '';
    let err = '';
    proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('exit', (code) => resolve({ code, out, err }));
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

      const { code, out } = await runTempo([
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
    const { code, err } = await runTempo([
      'start',
      'greeter',
      '--server=http://127.0.0.1:1',
    ]);
    expect(code).toBe(1);
    expect(err).toContain('cannot reach a tempo server');
  }, 30000);

  it('reports an unknown command and prints usage', async () => {
    const { code, err } = await runTempo(['nope']);
    expect(code).toBe(1);
    expect(err).toContain('unknown command "nope"');
    expect(err).toContain('tempo up <entry>');
  }, 30000);
});

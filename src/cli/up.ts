/**
 * @fileoverview
 * `tempo up` — run the whole topology in the foreground as child processes:
 * nothing installed, nothing persisted unless asked. This is the dev loop and the
 * CI shape, and the mode to use where systemd is not PID 1 (containers).
 *
 * Two modes. Without `--run` it stays up until interrupted. With `--run` it
 * starts one workflow, prints the result, and stops — a whole distributed
 * round-trip as one foreground command, which is what you want for a first
 * end-to-end run or a CI check. The one-shot mode exists because the obvious
 * alternative — a shell script that starts a server, sleeps, starts a worker,
 * sleeps again, then issues `tempo start` — has to guess at readiness and cannot
 * learn the port at all when the server binds port 0. Both are already solved
 * here: the port comes from the server's own LISTENING line and the launch waits
 * for the worker's WORKER_READY line.
 *
 * `TEMPO_ROLE` is deliberately left unset, so one worker process serves both
 * roles — fewer moving parts while iterating. Installed deployments split the
 * roles into separate services instead (one supervised service per role, scaled
 * independently); see the target surface in cli.ts.
 */

import type {ChildProcess} from 'node:child_process';
import * as path from 'node:path';
import {startWorkflow} from './client';
import {describeWorker} from './describe';
import {forwardOutput, spawnEntry, stopChild, waitForLine} from './process';

/**
 * The framework's own server main — shipped with the CLI, never user-built.
 *
 * Resolved from this module's own directory, so the CLI finds its server
 * wherever it is run from. It used to resolve against the *working directory*,
 * which assumed `npm run tempo` from the repo root and broke anywhere else —
 * a trade the comment here admitted to, taken because `import.meta` is banned
 * (`tools/style.ts`) and ESM left nothing else to use. CommonJS has
 * `__dirname`, so the trade is off.
 *
 * Two levels up from `src/cli/` is the package root; `bin/` sits beside `src/`.
 */
const SERVER_ENTRY = path.resolve(
  __dirname,
  '..',
  '..',
  'bin',
  'server-main.ts',
);

/** One workflow to run to completion, for `up`'s one-shot mode. */
export interface RunRequest {
  name: string;
  args: unknown[];
  /** Worker pool to run on; the worker must be serving the same queue. */
  taskQueue?: string;
}

/**
 * Turn a bind address into one a client can dial.
 *
 * A wildcard bind is not an address: `0.0.0.0` means "every IPv4 interface", and
 * connecting to it is unspecified — it happens to reach localhost on Windows and
 * Linux, and fails on some other stacks. So the wildcards map to their loopback,
 * and every other host is already dialable and passes through. IPv6 literals get
 * bracketed, since `http://::1:7233` has no unambiguous reading.
 */
export function connectableHost(bindHost: string): string {
  const host =
    bindHost === '0.0.0.0' || bindHost === ''
      ? '127.0.0.1'
      : bindHost === '::' || bindHost === '::0'
        ? '::1'
        : bindHost;
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * Can only this machine reach a server bound here?
 *
 * Drives the exposure warning, so it has to be about reachability rather than
 * about being the default: `::1` is not `127.0.0.1` but is just as private, and
 * warning about it would train people to ignore the warning that matters. The
 * whole `127.0.0.0/8` block is loopback, not just `.0.1`.
 */
export function isLoopbackHost(host: string): boolean {
  return host === '::1' || host === 'localhost' || host.startsWith('127.');
}

export interface UpOptions {
  /** Path to the worker entrypoint or built binary. */
  entry: string;
  /**
   * Interface for the server to bind. Defaults to `127.0.0.1`. `0.0.0.0` lets
   * other machines connect — the RPC has no auth, so keep it off public networks.
   */
  host?: string;
  /** Server listen port. 0 (the default) takes any free port. */
  port?: number;
  /** Persist history here; omit for an in-memory server. */
  dataDir?: string;
  /**
   * Run one workflow, print its result, and tear the topology down again,
   * instead of staying up until interrupted.
   */
  run?: RunRequest;
}

/** Resolve when the user interrupts us, or when a supervised child dies first. */
function waitForShutdown(
  children: {label: string; child: ChildProcess}[],
): Promise<string> {
  return new Promise((resolve) => {
    for (const {label, child} of children)
      child.once('exit', (code) => resolve(`${label} exited with ${code}`));
    process.once('SIGINT', () => resolve('interrupted'));
    process.once('SIGTERM', () => resolve('terminated'));
  });
}

export async function up(options: UpOptions): Promise<number> {
  // Validate the artifact before starting anything — a binary that cannot
  // describe itself cannot run, and failing here leaves nothing to clean up.
  const manifest = await describeWorker(options.entry);

  const server = spawnEntry(SERVER_ENTRY, {
    env: {
      HOST: options.host,
      PORT: String(options.port ?? 0),
      DATA_DIR: options.dataDir,
    },
  });
  forwardOutput(server, 'server');

  let worker: ChildProcess | undefined;
  try {
    // The readiness line reports what it actually bound, which is the only
    // reliable source: the port may have been 0, and the host may have been
    // defaulted by the server rather than passed here.
    const [, port, boundHost] = await waitForLine(
      server,
      /LISTENING (\d+) (\S+)/,
    );
    const serverUrl = `http://${connectableHost(boundHost!)}:${port}`;
    process.stdout.write(`tempo: server listening on ${serverUrl}\n`);
    if (!isLoopbackHost(boundHost!))
      process.stdout.write(
        `tempo: bound ${boundHost} — reachable from other machines, and the RPC has no auth or TLS\n`,
      );

    worker = spawnEntry(options.entry, {
      env: {TEMPO_SERVER_URL: serverUrl, TEMPO_ROLE: undefined},
    });
    forwardOutput(worker, manifest.name);
    const [, roles] = await waitForLine(worker, /WORKER_READY \S+ (\S+)/);

    // One-shot: the topology exists to serve a single execution, so the result
    // is the exit condition. `finally` below stops both children either way —
    // including when getResult rejects because the workflow failed.
    if (options.run) {
      process.stdout.write(`tempo: worker ${manifest.name} ready (${roles})\n`);
      return await startWorkflow(
        serverUrl,
        options.run.name,
        options.run.args,
        true, // wait: the point of one-shot mode is the result
        options.run.taskQueue,
      );
    }

    process.stdout.write(
      `tempo: worker ${manifest.name} ready (${roles})\ntempo: Ctrl-C to stop\n`,
    );

    const reason = await waitForShutdown([
      {label: 'server', child: server},
      {label: `worker ${manifest.name}`, child: worker},
    ]);
    process.stdout.write(`\ntempo: stopping (${reason})\n`);
    return reason === 'interrupted' || reason === 'terminated' ? 0 : 1;
  } finally {
    if (worker) await stopChild(worker);
    await stopChild(server);
  }
}

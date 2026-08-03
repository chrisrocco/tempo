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
 * Resolved against the working directory rather than the module's own URL:
 * `import.meta` is not available under every module target this has to build
 * for, so it is banned repo-wide (`tools/style.ts`). The trade is real — this
 * now assumes the CLI runs from the repo root, which `npm run tempo` does. A
 * CLI installed elsewhere would need its entry passed in explicitly.
 */
const SERVER_ENTRY = path.resolve('bin/server-main.ts');

/** One workflow to run to completion, for `up`'s one-shot mode. */
export interface RunRequest {
  name: string;
  args: unknown[];
  /** Worker pool to run on; the worker must be serving the same queue. */
  taskQueue?: string;
}

export interface UpOptions {
  /** Path to the worker entrypoint or built binary. */
  entry: string;
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
      PORT: String(options.port ?? 0),
      DATA_DIR: options.dataDir,
    },
  });
  forwardOutput(server, 'server');

  let worker: ChildProcess | undefined;
  try {
    const [, port] = await waitForLine(server, /LISTENING (\d+)/);
    const serverUrl = `http://127.0.0.1:${port}`;
    process.stdout.write(`tempo: server listening on ${serverUrl}\n`);

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

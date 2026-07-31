/**
 * @fileoverview
 * `tempo up` — run the whole topology in the foreground as child processes:
 * nothing installed, nothing persisted unless asked. This is the dev loop and the
 * CI shape, and the mode to use where systemd is not PID 1 (containers).
 *
 * `TEMPO_ROLE` is deliberately left unset, so one worker process serves both
 * roles — fewer moving parts while iterating. Installed deployments split the
 * roles into separate services instead; see docs/guides/build-and-deploy.md.
 */

import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describeWorker } from './describe';
import { forwardOutput, spawnEntry, stopChild, waitForLine } from './process';

/** The framework's own server main — shipped with the CLI, never user-built. */
const SERVER_ENTRY = fileURLToPath(
  new URL('../../bin/server-main.ts', import.meta.url),
);

export interface UpOptions {
  /** Path to the worker entrypoint or built binary. */
  entry: string;
  /** Server listen port. 0 (the default) takes any free port. */
  port?: number;
  /** Persist history here; omit for an in-memory server. */
  dataDir?: string;
}

/** Resolve when the user interrupts us, or when a supervised child dies first. */
function waitForShutdown(
  children: { label: string; child: ChildProcess }[],
): Promise<string> {
  return new Promise((resolve) => {
    for (const { label, child } of children)
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
      env: { TEMPO_SERVER_URL: serverUrl, TEMPO_ROLE: undefined },
    });
    forwardOutput(worker, manifest.name);
    const [, roles] = await waitForLine(worker, /WORKER_READY \S+ (\S+)/);
    process.stdout.write(
      `tempo: worker ${manifest.name} ready (${roles})\ntempo: Ctrl-C to stop\n`,
    );

    const reason = await waitForShutdown([
      { label: 'server', child: server },
      { label: `worker ${manifest.name}`, child: worker },
    ]);
    process.stdout.write(`\ntempo: stopping (${reason})\n`);
    return reason === 'interrupted' || reason === 'terminated' ? 0 : 1;
  } finally {
    if (worker) await stopChild(worker);
    await stopChild(server);
  }
}

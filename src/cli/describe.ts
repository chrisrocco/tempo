/**
 * @fileoverview
 * The `--describe` handshake: ask a worker artifact what it is. This is the
 * contract that lets the CLI take a *binary* rather than a config file — the tool
 * interrogates the artifact instead of being told about it somewhere that can
 * drift. `tempo up` uses it to name and validate the worker before starting
 * anything; `tempo deploy` will use it to decide which role services to install.
 */

import {spawnLaunchable} from './process';
import type {Launchable} from './ports/toolchain';

export interface WorkerManifest {
  name: string;
  workflows: string[];
  activities: string[];
}

function isManifest(value: unknown): value is WorkerManifest {
  const m = value as Partial<WorkerManifest> | null;
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof m.name === 'string' &&
    Array.isArray(m.workflows) &&
    Array.isArray(m.activities)
  );
}

/**
 * Run `--describe` against an already-resolved worker and parse its manifest.
 * Doubles as a smoke test: an artifact that cannot describe itself cannot run,
 * so failing here is failing before anything has been started or installed.
 *
 * Takes a `Launchable` rather than a path, so this module has no opinion about
 * how the artifact came to be runnable — under a build system, resolving it is
 * what built it.
 */
export function describeWorker(
  worker: Launchable,
  timeoutMs = 20000,
): Promise<WorkerManifest> {
  const entry = [worker.command, ...worker.args].join(' ');
  return new Promise((resolve, reject) => {
    const child = spawnLaunchable(worker, {args: ['--describe']});
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out running ${entry} --describe`));
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run ${entry}: ${e.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(
          new Error(`${entry} --describe exited with ${code}\n${err}`),
        );
      // Take the last JSON-looking line: the manifest is the final thing printed.
      const line = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('{'))
        .pop();
      if (!line)
        return reject(
          new Error(`${entry} --describe printed no manifest\n${out}${err}`),
        );
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isManifest(parsed))
          return reject(new Error(`${entry} --describe printed ${line}`));
        resolve(parsed);
      } catch {
        return reject(new Error(`${entry} --describe printed ${line}`));
      }
    });
  });
}

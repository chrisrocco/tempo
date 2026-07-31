/**
 * @fileoverview
 * Child-process plumbing shared by the CLI: launching an entrypoint, waiting on
 * a readiness line, forwarding output, and stopping a child without orphans.
 * `tempo up` supervises processes with this; `tempo deploy` will reuse the same
 * launch shape to interrogate a built artifact.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface SpawnEntryOptions {
  args?: string[];
  env?: Record<string, string | undefined>;
}

/**
 * Launch a server or worker entrypoint. A TypeScript path runs under `tsx` so
 * sources work with no build step; a `.js` path runs under plain Node; anything
 * else is taken to be a self-contained executable and run directly — which is
 * the shape a built binary has.
 */
export function spawnEntry(
  entry: string,
  options: SpawnEntryOptions = {},
): ChildProcess {
  const args = options.args ?? [];
  let command: string;
  let commandArgs: string[];
  if (entry.endsWith('.ts') || entry.endsWith('.mts')) {
    command = process.execPath;
    commandArgs = ['--import', 'tsx', entry, ...args];
  } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
    command = process.execPath;
    commandArgs = [entry, ...args];
  } else {
    command = entry;
    commandArgs = args;
  }
  return spawn(command, commandArgs, {
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Resolve when the child prints a line matching `re`. Listeners are additive, so
 * a caller may forward the same output elsewhere at the same time. Rejects if the
 * child exits first — a process that died is never going to become ready.
 */
export function waitForLine(
  child: ChildProcess,
  re: RegExp,
  timeoutMs = 20000,
): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${re}\n${out}${err}`));
    }, timeoutMs);

    function onOut(d: Buffer): void {
      out += d.toString();
      const match = out.match(re);
      if (match) {
        cleanup();
        resolve(match);
      }
    }
    function onErr(d: Buffer): void {
      err += d.toString();
    }
    function onExit(code: number | null): void {
      cleanup();
      reject(new Error(`process exited with ${code}\n${out}${err}`));
    }
    function cleanup(): void {
      clearTimeout(timer);
      child.stdout?.off('data', onOut);
      child.stderr?.off('data', onErr);
      child.off('exit', onExit);
    }

    child.stdout?.on('data', onOut);
    child.stderr?.on('data', onErr);
    child.on('exit', onExit);
  });
}

/** Forward a child's output to ours, one prefixed line at a time. */
export function forwardOutput(child: ChildProcess, label: string): void {
  function pipe(
    stream: NodeJS.ReadableStream | null,
    out: NodeJS.WritableStream,
  ): void {
    stream?.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n'))
        if (line.trim()) out.write(`[${label}] ${line}\n`);
    });
  }
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
}

/** SIGTERM, then SIGKILL if it does not go quietly. */
export function stopChild(child: ChildProcess, graceMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/**
 * @fileoverview
 * Child-process plumbing shared by the CLI: spawning what a toolchain resolved,
 * waiting on a readiness line, forwarding output, and stopping a child without
 * orphans. `tempo up` supervises processes with this.
 */

import {spawn, type ChildProcess} from 'node:child_process';
import type {Launchable} from './ports/toolchain';

export interface SpawnOptions {
  /** Arguments appended after the launchable's own. */
  args?: string[];
  env?: Record<string, string | undefined>;
}

/**
 * Spawn something a `Toolchain` resolved. This module deliberately does not know
 * how a target became a command — that question has a different answer per build
 * system and lives behind `ports/toolchain.ts`; what is left here is the same
 * either way: pipe the output, inherit the environment, hand back the child.
 */
export function spawnLaunchable(
  launchable: Launchable,
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(
    launchable.command,
    [...launchable.args, ...(options.args ?? [])],
    {
      env: {...process.env, ...options.env},
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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

/**
 * @fileoverview
 * The real machine: `Host` over `node:fs` and `node:child_process`.
 *
 * Thin by design — every decision worth making lives in `up`, `down`, `status`,
 * and `units.ts`, all of which are testable against a fake. What is here is the
 * part that cannot be tested without a Linux box and root, so it is kept small
 * enough to read and verify by eye.
 */

import {execFile} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {CommandResult, Host, UserPaths} from './ports/host';

/**
 * The machine this process is running on.
 *
 * A function rather than a constant so that constructing it is a decision at a
 * call site — `up(options, systemHost())` reads as "do this to the real machine",
 * which is worth one pair of parentheses.
 */
export function systemHost(): Host {
  return {
    euid(): number {
      // Absent on Windows, where the concept does not exist. -1 reads as "not
      // root", which is the permissive answer and correct: with user units there
      // is nothing privileged left to guard.
      return process.geteuid?.() ?? -1;
    },

    userPaths(): UserPaths {
      // The XDG defaults, which are what the specification says to use when a
      // variable is unset *or empty* — an exported-but-empty `XDG_DATA_HOME` is
      // common enough in shell profiles that `??` alone would be wrong here.
      const home = os.homedir();
      const xdg = (name: string, fallback: string): string => {
        const value = process.env[name];
        return value && value.trim() !== '' ? value : `${home}/${fallback}`;
      };
      return {
        data: xdg('XDG_DATA_HOME', '.local/share'),
        config: xdg('XDG_CONFIG_HOME', '.config'),
        state: xdg('XDG_STATE_HOME', '.local/state'),
      };
    },

    async makeDirectory(directory: string): Promise<void> {
      await fs.mkdir(directory, {recursive: true});
    },

    async installFile(source: string, destination: string): Promise<void> {
      // `realpath` first, so what gets copied is the file a symlink pointed at
      // rather than the link. `copyFile` would follow it too, but saying so here
      // is what stops the next reader from "simplifying" this into a rename.
      const resolved = await fs.realpath(source);

      // The temporary sits in the destination's own directory so the rename is
      // within one filesystem. `rename(2)` across devices fails with EXDEV, and a
      // temp directory elsewhere is exactly how that happens in production.
      const temporary = path.join(
        path.dirname(destination),
        `.${path.basename(destination)}.${process.pid}.tmp`,
      );

      await fs.copyFile(resolved, temporary);
      try {
        await fs.rename(temporary, destination);
      } catch (e) {
        // Leaving a stray dotfile in the install root would make the next deploy
        // look like it half-worked.
        await fs.rm(temporary, {force: true});
        throw e;
      }
    },

    async writeFile(destination: string, contents: string): Promise<void> {
      await fs.writeFile(destination, contents, 'utf8');
    },

    run(command: string, args: readonly string[]): Promise<CommandResult> {
      return new Promise((resolve, reject) => {
        execFile(command, [...args], (error, stdout, stderr) => {
          // A non-zero exit arrives here as an `error` carrying `code`; that is an
          // answer, not a failure, so it resolves. An `error` without a numeric
          // code is the command not existing or not being executable, which is
          // not an answer to anything.
          const code = (error as {code?: unknown} | null)?.code;
          if (error && typeof code !== 'number') {
            reject(error);
            return;
          }
          resolve({code: typeof code === 'number' ? code : 0, stdout, stderr});
        });
      });
    },
  };
}

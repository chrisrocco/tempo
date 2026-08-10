/**
 * @fileoverview
 * The seam onto the machine being deployed to: privilege, files, and commands.
 *
 * `up`, `down`, and `status` exist to write `/opt`, render into
 * `/etc/systemd/system`, and run `systemctl`. **None of that is available in a
 * spec, and none of it is available at all on a machine that is not Linux.**
 * Without a seam there is no way to test any of this, and the parts most worth
 * testing — the exact text of a unit file, the order of copy/reload/restart — are
 * exactly the parts that never touch a real system.
 *
 * So the machine is one interface, passed in as an argument rather than imported.
 * One implementation over `node:fs` and `node:child_process` (`system_host.ts`),
 * one fake that records calls (`spec/support/fake_host.ts`).
 *
 * ## This is not the `Toolchain` port that #62 deleted
 *
 * That one abstracted "how a build target becomes a process" on behalf of two
 * callers who had to agree about it, and it was deleted once both got out of that
 * business — a seam with nothing on either side. This abstracts *the machine*,
 * for the concrete purpose of making a deployment testable off the machine. It
 * has one real implementation and one fake, which is the shape a port is supposed
 * to have.
 *
 * ## Why `run` reports an exit code instead of throwing
 *
 * A non-zero exit is ordinary here rather than exceptional: `systemctl is-active`
 * exits 3 for an inactive unit, and `id` exits 1 for a user that does not exist.
 * Both are *answers*. A seam that rejected on them would make every caller write
 * a `catch` to read a fact, which is how a genuine failure ends up swallowed by
 * the same handler that was there to read a boolean.
 *
 * Callers that require success say so explicitly — see `requireSuccess` in
 * `systemctl.ts`.
 */

/** What a command did: how it exited, and what it said. */
export interface CommandResult {
  /** Exit status. `0` is success; anything else may still be a valid answer. */
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything a deployment does to the machine it is deploying to. */
export interface Host {
  /**
   * The effective user id, so `up` can refuse **before its first write** rather
   * than discovering it lacks permission halfway through. A partial deploy is
   * worse than a refused one.
   *
   * Returns a negative number where the concept does not exist — Windows has no
   * `geteuid` — which reads as "not root" and refuses, correctly.
   */
  euid(): number;

  /** Create a directory and any missing parents. Succeeds if it already exists. */
  makeDirectory(path: string): Promise<void>;

  /**
   * Install a file: copy its **contents** to a temporary name beside the
   * destination, then `rename(2)` over it.
   *
   * Both halves are load-bearing and both fail late rather than loudly if
   * skipped. Copying contents rather than the link is what stops a `blaze-bin`
   * symlink farm from installing links that dangle the next time someone builds
   * with different flags — a deployment that breaks with no deploy having
   * happened. Renaming into place is what stops systemd from restarting into a
   * half-written file.
   */
  installFile(source: string, destination: string): Promise<void>;

  /** Write a file outright, creating or replacing it. For the unit files. */
  writeFile(destination: string, contents: string): Promise<void>;

  /** Run a command and wait for it. See the fileoverview on the exit code. */
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}

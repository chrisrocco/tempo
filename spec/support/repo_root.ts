/**
 * @fileoverview
 * Where the repo is, answered from this file's own location rather than from the
 * process's working directory.
 *
 * Specs reach outside themselves for two things — the sources a checker reads,
 * and the entrypoints a process test spawns — and both used to be written as
 * `path.resolve('bin/tempo.ts')`, which silently means "relative to wherever
 * `npm test` happened to be run". That held because npm scripts run from the
 * package root, and it is the assumption a build system has no reason to
 * preserve: Bazel runs an action in a sandbox with a working directory it
 * chooses, and every one of those paths resolves to nothing.
 *
 * `__dirname` is fixed to the file, so it holds under `npm test`, under a
 * process spawned with any working directory, and under a sandbox. It is
 * available because this repo is CommonJS — see the note in
 * `tsconfig.json` for why it is, which is the same reason as this.
 */

import * as path from 'node:path';

/** The repository root — two levels up from `spec/support/`. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * A path inside the repo, whatever the caller's working directory is. Segments
 * are joined, so `repoPath('bin', 'tempo.ts')` and `repoPath('bin/tempo.ts')`
 * are the same thing.
 */
export function repoPath(...segments: string[]): string {
  return path.join(REPO_ROOT, ...segments);
}

/**
 * @fileoverview
 * The toolchain that builds nothing: run what is already there.
 *
 * This is what the CLI has always done, now behind
 * [`ports/toolchain.ts`](ports/toolchain.ts) rather than switched on inline. A
 * TypeScript path runs under `tsx` so sources work with no build step, a `.js`
 * path runs under plain Node, and anything else is taken to be a self-contained
 * executable and run directly — which is the shape a built binary has, and the
 * reason this file needs no special case for one.
 *
 * It stays the default because it is the only one that works with nothing
 * installed and nothing configured: clone, `npm install`, `tempo up`. A build
 * system's toolchain is a better answer once there is a build system, and a
 * worse one before.
 */

import * as path from 'node:path';
import type {Launchable, Toolchain} from './ports/toolchain';

/**
 * The `tsx` loader, resolved from this module to an absolute path.
 *
 * `--import tsx` would make the **child** resolve the bare specifier from its
 * own working directory, which is not necessarily ours and need not contain a
 * `node_modules` at all.
 */
const TSX_LOADER = require.resolve('tsx');

/**
 * The framework's own server main — shipped with the CLI, never user-built.
 *
 * Two levels up from `src/cli/` is the package root; `bin/` sits beside `src/`.
 * Resolved from this module's directory so the CLI finds its server wherever it
 * is run from.
 */
const SERVER_ENTRY = path.resolve(
  __dirname,
  '..',
  '..',
  'bin',
  'server-main.ts',
);

/** Resolve one path the way this toolchain runs things. */
function launchableFor(entry: string): Launchable {
  if (entry.endsWith('.ts') || entry.endsWith('.mts'))
    return {command: process.execPath, args: ['--import', TSX_LOADER, entry]};
  if (entry.endsWith('.js') || entry.endsWith('.mjs'))
    return {command: process.execPath, args: [entry]};
  return {command: entry, args: []};
}

/** Run targets from the working tree, compiling nothing. */
export function createSourceToolchain(): Toolchain {
  return {
    launch: (target) => Promise.resolve(launchableFor(target)),
    server: () => Promise.resolve(launchableFor(SERVER_ENTRY)),
  };
}

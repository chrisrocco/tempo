#!/usr/bin/env node
/**
 * @fileoverview
 * The `tempo` CLI entrypoint. All logic lives in `src/cli`; this file only wires
 * argv in and an exit code out.
 */

import {runCli} from '../src/cli/cli';

// `void … .then(…)` rather than top-level await: TLA is only legal under some
// module targets (TS1378), and a binary should not constrain how the project is
// compiled. The `void` is the floating-promise rule — nothing awaits this, and
// saying so is the difference between a deliberate fire-and-forget and an
// oversight (tools/style.ts).
void runCli(process.argv.slice(2)).then((code) => {
  // `exitCode` rather than `exit()`: stdout may still be draining, and a piped
  // write that has not flushed is lost if the process is torn down under it.
  process.exitCode = code;
});

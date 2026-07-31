#!/usr/bin/env node
/**
 * @fileoverview
 * The `tempo` CLI entrypoint. All logic lives in `src/cli`; this file only wires
 * argv in and an exit code out.
 */

import { runCli } from '../src/cli/cli';

process.exitCode = await runCli(process.argv.slice(2));

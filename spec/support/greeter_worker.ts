/**
 * @fileoverview
 * The reference worker binary, in one file: an activity, a workflow, and the
 * entrypoint that hands both to the library.
 *
 * In spec/support/ rather than an examples/ tree, deliberately: a runnable file
 * is honest only while something runs it, and here the suite is what does —
 * spec/integration/distributed.spec.ts launches this binary exactly as a
 * deployment would (one process per role) and spec/integration/local_run.spec.ts
 * runs its `--local` path. The examples/ tree it used to live in held files CI
 * only typechecked, which is how examples rot.
 *
 * Run it by hand the same way — `--server=URL` picks the server and
 * `--role=ROLE` picks a single poll loop (see src/tempo.ts for the full input
 * surface). Or run one workflow through it with no server at all:
 *
 *   tsx spec/support/greeter_worker.ts --local=greeter --args='["world"]'
 *
 * Real projects should split activities and workflows into separate modules: a
 * workflow module that imports activities with `import type * as` keeps their
 * implementations — and their I/O dependencies — out of the workflow bundle.
 * Everything is together here for readability.
 */

import {startWorker} from '../../src';
import {proxyActivities} from '../../src/workflow';

// ── activities — the only place I/O is allowed ─────────────────────────────
export const GREETING = 'Hello';

export function greet(name: string): string {
  return `${GREETING}, ${name}!`;
}

// Stands in for a module namespace: a real activities module exports constants
// alongside its activities, and only the callables may become registry entries —
// a rule both `proxyActivities` and `startWorker` have to respect.
const activities = {GREETING, greet};

// ── workflows — deterministic orchestration, reaching I/O only via activities ─
const act = proxyActivities(activities, {
  retry: {maximumAttempts: 3},
});

export async function greeter(name: string): Promise<string> {
  return act.greet(name);
}

const workflows = {greeter};

// ── the entrypoint — this file is the build target ─────────────────────────
startWorker({
  name: 'greeter',
  activities,
  workflows,
});

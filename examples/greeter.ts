/**
 * @fileoverview
 * The reference deployable worker, in one file: an activity, a workflow, and the
 * entrypoint that hands both to the library.
 *
 * Run it with `tempo up examples/greeter.ts`, or directly — `TEMPO_SERVER_URL`
 * picks the server, `TEMPO_ROLE` picks a single poll loop, and `--describe`
 * prints what the artifact contains (see src/tempo.ts for the full input
 * surface). This is the binary spec/integration/distributed.spec.ts and
 * cli.spec.ts actually run, so it stays honest.
 *
 * Real projects should split activities and workflows into separate modules: a
 * workflow module that imports activities with `import type * as` keeps their
 * implementations — and their I/O dependencies — out of the workflow bundle.
 * Everything is together here for readability.
 */

import {Tempo} from '../src';
import {proxyActivities} from '../src/workflow';

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
const act = proxyActivities<typeof activities>({
  retry: {maximumAttempts: 3},
});

export async function greeter(name: string): Promise<string> {
  return act.greet(name);
}

const workflows = {greeter};

// ── the entrypoint — this file is the build target ─────────────────────────
Tempo.startWorker({
  name: 'greeter',
  activities,
  workflows,
});

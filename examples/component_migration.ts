/**
 * @fileoverview
 * An illustration: an agent porting a component, with the try-until-green loop
 * written as a workflow rather than as a `while` in a script.
 *
 * This is pseudo-code and does not run — `createAgent` and `sh` below are
 * declared rather than implemented, and the prompts are sketches. What is real
 * is the control flow, which is the part worth copying:
 *
 *     author ──▶ test ──┬── green ──▶ commit
 *                       └── red ────▶ repair ──▶ test ──▶ …
 *
 * ## Why the loop belongs in a workflow
 *
 * A migration is a long, expensive, flaky sequence: an agent turn costs minutes
 * and money, a test run can hang, and the whole job is the kind someone starts
 * and then closes their laptop on. As a script, a crash on the fourth attempt
 * throws away the three turns that got there — and there is nothing to ask what
 * it is currently doing.
 *
 * As a workflow, every turn and every test run is an activity, so each result is
 * a history event. A worker dying mid-migration loses at most the attempt in
 * flight, and replay walks the loop back to exactly where it was. The loop's own
 * state — which attempt this is, what failed last time — is ordinary local state
 * in a deterministic function, so it is rebuilt from history for free rather
 * than checkpointed by hand.
 *
 * The agent is deliberately stateless between turns for the same reason: each
 * activity opens its own session and is told everything it needs in the prompt.
 * A session held open across attempts is in-memory state on one worker, which is
 * the one thing the engine cannot reconstruct — see src/workflow.ts. History is
 * the memory here, and the prompt is how the agent reads it.
 *
 * ## What a real one would add
 *
 * A `defineSignal` for human review before the commit, `continueAsNew` if a
 * component can churn through hundreds of attempts, and timeouts tuned to how
 * long a turn actually takes. Each fits around this loop without changing it.
 */

import {executeChild, proxyActivities} from '../src/workflow';

// ── the agent, in the two calls this example uses ──────────────────────────

/** One agent session. `prompt` runs a turn and resolves with what it said. */
interface Agent {
  prompt(instruction: string): Promise<string>;
}

/** Opens a session rooted at a working directory. Declared, not implemented. */
declare function createAgent(options: {cwd: string}): Agent;

/** Runs a shell command and collects its output. Declared, not implemented. */
declare function sh(
  cwd: string,
  command: string,
): Promise<{code: number; output: string}>;

// ── activities — the only place I/O is allowed ─────────────────────────────

/** The checkout the agent edits. A real one would take it from a flag. */
const REPO = '/srv/checkouts/design-system';

export interface ComponentSpec {
  /** The component being migrated — `DataTable`, `Combobox`, … */
  name: string;
  /** One already migrated, whose conventions the new one should follow. */
  reference: string;
  /** Anything the reference cannot say: props dropped, APIs that changed. */
  notes: string;
}

export interface TestReport {
  passed: boolean;
  /** The tail only: this lands in history, so it must not be a log dump. */
  output: string;
}

/**
 * One agent turn: write the new component from the reference one.
 *
 * It is told not to run the tests, because the workflow runs them. An agent
 * that tests itself reports its own verdict, and a verdict the engine did not
 * record is a verdict that does not survive the worker.
 */
export async function authorComponent(spec: ComponentSpec): Promise<string> {
  const agent = createAgent({cwd: REPO});
  return agent.prompt(
    `Port ${spec.name} to the new component library.\n` +
      `Follow ${spec.reference}, which is already migrated: match its file ` +
      `layout, its prop conventions, and its test style.\n` +
      `${spec.notes}\n` +
      `Write the component and its tests. Do not run them.`,
  );
}

/**
 * One agent turn: hand back the failures and ask for a fix.
 *
 * A fresh session, carrying no memory of the previous attempt — everything it
 * needs is in this prompt, which is exactly what makes the turn replayable.
 */
export async function repairComponent(input: {
  spec: ComponentSpec;
  failure: string;
  attempt: number;
}): Promise<string> {
  const agent = createAgent({cwd: REPO});
  return agent.prompt(
    `The tests for ${input.spec.name} fail — attempt ${input.attempt}.\n` +
      `Fix the component, not the tests.\n\n${input.failure}`,
  );
}

export async function runTests(spec: ComponentSpec): Promise<TestReport> {
  const run = await sh(REPO, `npm test -- ${spec.name}`);
  return {passed: run.code === 0, output: lastLines(run.output, 100)};
}

export async function commitComponent(spec: ComponentSpec): Promise<void> {
  await sh(REPO, `git add -A && git commit -m "migrate ${spec.name}"`);
}

/** Kept out of `activities` on purpose: only callables there become tasks. */
function lastLines(text: string, count: number): string {
  return text.split('\n').slice(-count).join('\n');
}

export const activities = {
  authorComponent,
  repairComponent,
  runTests,
  commitComponent,
};

// ── workflows — deterministic orchestration, reaching I/O only via activities ─

const act = proxyActivities(activities, {
  // A turn that dies on a flaky API error should not end a migration that is
  // four attempts in. This retry is about the *call* failing; the repair loop
  // below is about the agent's work being wrong. Different failures, different
  // budgets.
  retry: {maximumAttempts: 3, initialIntervalMs: 10_000},
  // Bound one attempt, so a wedged turn fails instead of being redelivered
  // alongside the one still running — see protocol/activity_options.ts. If the
  // agent SDK reports progress, call `heartbeat()` from it (src/activity.ts)
  // and set `heartbeatTimeoutMs` too: without one, the engine cannot tell a
  // thinking agent from a dead worker.
  startToCloseTimeoutMs: 15 * 60_000,
});

/** How many times the agent may be shown the failures before we give up. */
const MAX_REPAIRS = 5;

export interface MigrationResult {
  component: string;
  passed: boolean;
  /** Repair turns spent. Zero means the first draft was green. */
  repairs: number;
  /** The failures we gave up on, when we did. */
  lastFailure?: string;
}

export async function migrateComponent(
  spec: ComponentSpec,
): Promise<MigrationResult> {
  await act.authorComponent(spec);

  let report = await act.runTests(spec);
  let repairs = 0;

  // The whole point of the example. `report` and `repairs` are plain local
  // variables — no checkpointing, no state store. A worker that dies here comes
  // back to a replay that rebuilds both from the activity results already in
  // history, then resumes at the one attempt that was in flight.
  while (!report.passed && repairs < MAX_REPAIRS) {
    repairs++;
    await act.repairComponent({spec, failure: report.output, attempt: repairs});
    report = await act.runTests(spec);
  }

  // Out of budget. Returning the failure rather than throwing keeps this a
  // result the parent can report on — the migration did not break, it did not
  // converge, and those want telling apart.
  if (!report.passed)
    return {
      component: spec.name,
      passed: false,
      repairs,
      lastFailure: report.output,
    };

  await act.commitComponent(spec);
  return {component: spec.name, passed: true, repairs};
}

/**
 * The reason to have written the loop that way: one child per component, all
 * started in the same task and awaited together. Each child gets its own
 * history, its own retry budget, and its own failure — one component that never
 * goes green does not hold up the twenty that do, and `describe` can say which
 * attempt each one is on while they run.
 */
export async function migrateAll(
  specs: ComponentSpec[],
): Promise<MigrationResult[]> {
  return Promise.all(
    specs.map((spec) =>
      executeChild<MigrationResult>('migrateComponent', {
        args: [spec],
        // Deterministic, and drawn from the domain: asking twice for the same
        // component claims the same id, so it correlates to the migration
        // already running instead of putting a second agent on those files.
        workflowId: `migrate-${spec.name}`,
      }),
    ),
  );
}

export const workflows = {migrateComponent, migrateAll};

// ── the entrypoint, for when the stand-ins above are real ──────────────────
//
//   Tempo.startWorker({name: 'migrations', activities, workflows});
//
// Left as a comment because this file is an illustration: `createAgent` and
// `sh` have no implementations, so a worker started here would poll happily and
// fail every task it took.

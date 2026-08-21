/**
 * @fileoverview
 * ★ AUTHOR ENTRYPOINT — workflow code imports ONLY from here.
 *
 * This module re-exports exclusively the deterministic primitives from `core`.
 * Nothing here touches I/O, the clock, or randomness, which is the whole point:
 * the boundary checker (`tools/boundaries.ts`, run by `npm run lint` and by
 * spec/architecture.spec.ts) keys on this file to keep the determinism boundary
 * enforced rather than merely documented. If you find yourself wanting to add a
 * non-deterministic capability here, it belongs on the runtime/host side instead.
 *
 * ## `Tempo` is this module, namespace-imported
 *
 * Workflow code reads better with one prefix, and this is the module to put it
 * on:
 *
 * ```ts
 * import * as Tempo from 'workflow-engine/workflow';
 *
 * const charge = Tempo.createWorkflow({
 *   key: 'charge',
 *   async run({id}: {id: string}) {
 *     await Tempo.sleep(1000);
 *     return acts.capture(id);
 *   },
 * });
 * ```
 *
 * A namespace import rather than an exported `Tempo` object, for two reasons. It
 * is the only form the boundary checker accepts without being taught a second
 * path — the rule permits exactly one runtime import in a workflow module, and
 * it is this one. And an object would restate every export a second time, so the
 * next author-facing primitive would have to be added twice or silently miss the
 * namespace.
 *
 * **`startWorker` is deliberately not reachable this way.** It reads `argv`,
 * calls `os.hostname()` and opens sockets, so a workflow module importing it
 * would drag the worker runtime across the very line this file exists to hold.
 * It is a plain import in the worker artifact, which is a separate one-line
 * file: `import {startWorker} from 'workflow-engine'`.
 *
 * ## The boundary, and why it exists
 *
 * Durability is achieved by **replay**: to recover a workflow whose in-memory
 * state was lost, the engine re-runs the function from the top against recorded
 * history. For that reconstruction to be correct, replay must be reproducible —
 * the same history must always drive the function to the same point and produce
 * the same commands. Any non-determinism inside workflow code breaks this and the
 * recovered state is silently wrong. So the boundary is not a style preference;
 * it is the precondition that makes the whole event-sourcing scheme sound.
 *
 * It also buys the two properties the rest of the system is built on. The core is
 * a pure function of its input, so it is unit-testable against hand-written
 * histories with no infrastructure. And because replay commits no external
 * effects, running it twice is harmless — which is exactly what makes it safe for
 * two workers to race on the same execution and discard the loser's work.
 * Distribution is only tractable because of this line.
 *
 * ## Rules workflow code must obey
 *
 * - Do not read the wall clock (`Date.now()`, `new Date()`) — use `sleep` and
 *   recorded times.
 * - Do not use randomness.
 * - Do not do I/O directly — request it through an **activity**.
 * - Do not depend on mutable state outside the workflow's own context.
 * - Do not `await` anything the engine did not hand you (a raw `setTimeout`, a
 *   bare `fetch`). Only promises the engine resolves are safe, because only those
 *   resolve identically on replay.
 *
 * One more rule, which is about the *source* rather than about a single run:
 * **changing which commands a workflow issues is a change to the histories already
 * recorded against it.** Replay reproduces a run only while the code still asks for
 * what history holds, so adding, removing or reordering a primitive call is safe
 * only if no execution has passed that point. When one has, `patched` is how the
 * new branch is added without diverging them — it reads which side of the change an
 * execution is on out of its own history, so old and new can share one source. And
 * when it is missed, a replay that settles an execution while history still holds
 * work it never issued is stopped rather than published (`core/apply_event`).
 *
 * ## How the boundary is held today
 *
 * Two entrypoints (this file for workflow code, `index.ts` for hosts) plus a
 * strictly downward dependency direction (`protocol <- core <- runtime <-
 * entrypoints`; `core/` may import only `protocol/`). Both are checked
 * mechanically by `tools/boundaries.ts`, along with the ban on clock and
 * randomness inside `core/` and inside workflow modules. When deciding where a
 * new feature goes, ask "is this deterministic (history-in, commands-out) or
 * not?" The answer names the layer.
 */

import {registerActivityImpls} from './activity_registry';
import {
  normalizeActivityOptions,
  type ActivityOptionsInput,
} from './core/activity_options_input';
import {createActivityProxy, type ActivityProxy} from './core/workflow_api';

export {clearCarryover, getCarryover, setCarryover} from './core/carryover';
export {condition, type ConditionOptions} from './core/condition';
export {
  waitForApproval,
  type ApprovalDecision,
  type ApprovalRequest,
} from './patterns/approval';
export {byCursor, byId, type Differ, type DiffResult} from './patterns/diff';
export {CancelledFailure} from './core/errors';
export {
  pollForever,
  type PollForeverOptions,
  type PollStart,
} from './patterns/poller';
export {
  background,
  firstSignal,
  signalStream,
  type Branch,
  type StreamOptions,
} from './patterns/signal_stream';
export {
  clearHandler,
  defineSignal,
  setHandler,
  type SignalDef,
} from './core/signals';
export {
  continueAsNew,
  deprecatePatch,
  executeChild,
  patched,
  runActivity,
  signalWorkflow,
  sleep,
  startChild,
  startWorkflow,
  workflowInfo,
  type ChildHandle,
  type ChildOptions,
  type StartWorkflowExternalOptions,
  type WorkflowInfo,
} from './core/workflow_api';

export type {AnyWorkflowFn} from './workflow_descriptor';
export {
  createWorkflow,
  type WorkflowRef,
  type WorkflowRegistration,
} from './workflow_registry';

// author-facing option types (erased at runtime; safe on the deterministic surface)
export type {
  ActivityOptions,
  ParentClosePolicy,
  RetryPolicy,
  WorkflowDescriptor,
  WorkflowPropsSchema,
  JsonSchema,
} from './protocol';
export type {
  ActivityOptionsInput,
  RetryPolicyInput,
} from './core/activity_options_input';
export type {Duration} from './walltime';

export type {ActivityProxy};

/**
 * Declare the activities a workflow calls: types the proxy from the implementations,
 * and registers them so a worker that loads this module can serve them.
 *
 * ```ts
 * import * as payments from '../activities/payments';
 * const act = proxyActivities(payments, {retry: {maximumAttempts: 3}});
 *
 * export async function order(id: string): Promise<void> {
 *   await act.charge(id);
 * }
 * ```
 *
 * ## Why it takes the implementations
 *
 * **Declaring that a workflow will call an activity is what registers it.** There is
 * no list to maintain and no order to get wrong: the entrypoint imports its
 * workflows, loading them runs these calls, and the worker ends up with exactly the
 * activities its workflows asked for. `startWorker({activities})` still works and
 * still wins on a name collision, for a worker that would rather be explicit.
 *
 * Taking only a type — `proxyActivities<typeof payments>(options)` — would do the
 * typing and nothing else, leaving the implementations to reach the worker by a
 * second, unrelated route: a flat `activities` object at the entrypoint, maintained
 * by hand. That holds up for a small artifact and stops holding up for a large
 * workflow split across helper modules, where the entrypoint must name every
 * activities module any helper touches. Nothing checks that list, and an omission
 * surfaces as an execution parking on a retrying activity rather than as a
 * configuration error.
 *
 * ## Why this is on the deterministic surface at all
 *
 * It touches host state, which nothing else exported from here does. Two things keep
 * it honest. The registration happens **once, at module load**, not during a replay —
 * this is a declaration, and calling it inside a workflow function would be a misuse
 * the same way any module-scope side effect would be. And the proxy it returns is the
 * pure forwarder `core/workflow_api` builds; nothing about a workflow's execution
 * changes.
 *
 * The wrapper is here rather than in `core/` because `core/` may import only
 * `protocol/` and must stay a pure function of history. The registry is host state,
 * so it lives outside, and this file — the seam between author code and host — is
 * where the two meet.
 *
 * ## The one thing to be careful about
 *
 * Passing implementations means binding them, and a bound implementation can be
 * called directly:
 *
 * ```ts
 * await act.charge(id);      // correct — issues a command the engine records
 * await payments.charge(id); // real I/O inside replay, on every replay
 * ```
 *
 * The second line is why `tools/boundaries.ts` permits this import **only** in the
 * shape `import * as NAME` where `NAME` is used for nothing but `proxyActivities`.
 * Reach for the namespace anywhere else in a workflow module and lint fails.
 */
export function proxyActivities<A extends object>(
  impls: A,
  options: ActivityOptionsInput = {},
): ActivityProxy<A> {
  registerActivityImpls(impls);
  // Normalized here, once, at declaration: durations become the wire's
  // milliseconds before the proxy exists, so a bad string fails at module load —
  // loudly, in the worker that would have run this — never during a replay.
  return createActivityProxy<A>(normalizeActivityOptions(options));
}

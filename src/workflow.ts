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

export {
  runActivity,
  proxyActivities,
  sleep,
  executeChild,
  startChild,
  type ChildHandle,
  type ChildOptions,
  continueAsNew,
  workflowInfo,
  type WorkflowInfo,
} from './core/workflow_api';
export {
  defineSignal,
  setHandler,
  clearHandler,
  type SignalDef,
} from './core/signals';
export {
  signalStream,
  firstSignal,
  background,
  type StreamOptions,
  type Branch,
} from './core/signal_stream';
export { condition } from './core/condition';
export { CancelledFailure } from './core/errors';

// author-facing option types (erased at runtime; safe on the deterministic surface)
export type { ActivityOptions, RetryPolicy } from './protocol';

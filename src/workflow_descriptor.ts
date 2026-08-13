/**
 * @fileoverview
 * Attaching a `WorkflowDescriptor` to a workflow function, and reading it back.
 *
 * At `src/` root rather than in a layer, beside `activity_registry.ts`, and for the same
 * reason: it is glue between author code and the host. A workflow module calls
 * `defineWorkflow`; a worker reads the result. Neither `core/` nor `worker/` owns that.
 *
 * ## Why it wraps the function instead of naming it
 *
 * The alternative was a module-scope map — `describeWorkflows({greeter: {...}})`, which is
 * literally what `proxyActivities` does for activities. It was rejected for one reason: a
 * map is keyed by a string, and a string that has to match a function's registered name is
 * a thing that can be typo'd, and can silently drift when the function is renamed. Nothing
 * would report it; the workflow would simply have no description forever.
 *
 * Wrapping binds the description to the function's identity instead. There is no name to
 * keep in step, and a rename carries the description with it.
 *
 * ## What it costs
 *
 * It mutates the function it is given, which is worth being explicit about. The property
 * is non-enumerable, so it does not appear in `Object.keys`, spreads, or `JSON.stringify`,
 * and the descriptor is frozen so a reader cannot alter what other readers see. The
 * function is returned unchanged in every way an author can observe: same reference, same
 * signature, still directly callable in a unit test.
 *
 * That last property is the point of the whole shape. `startWorker({workflows: {greeter}})`
 * is unchanged, `registerWorkflow('greeter', greeter)` is unchanged, and a workflow with no
 * descriptor keeps working exactly as before.
 *
 * ## Describing one function twice
 *
 * The last call wins, and nothing complains. Throwing was considered and declined for the
 * reason `activity_registry` gives at length: these calls run at module load, where a throw
 * fires while modules are still evaluating and crashes the process on import rather than
 * reporting anything usable. There is no transport yet either, so a conflict has no
 * consequence to protect against — when there is one, the place to report it is wherever
 * descriptors are collected, by which point every module has loaded.
 */

import type {WorkflowDescriptor} from './protocol';

/**
 * Registered globally rather than as a module-local `Symbol()`.
 *
 * A module genuinely can evaluate twice — resolved through two paths, or present in both a
 * bundle and a `require` — and two local symbols would not match, so a descriptor written
 * by one copy would be invisible to a reader holding the other. `Symbol.for` is keyed by
 * string in a process-wide registry, so every copy agrees. Same reasoning as
 * `activity_registry`'s tolerance of double evaluation.
 */
const DESCRIPTOR = Symbol.for('tempo.workflowDescriptor');

/** Any workflow function. `any[]` rest params are required for assignability — see `core/workflow_api`. */
type AnyWorkflowFn = (...args: any[]) => Promise<unknown>;

/**
 * Describe a workflow where it is defined.
 *
 * ```ts
 * export const greeter = defineWorkflow(
 *   {
 *     title: 'Greet a customer',
 *     description: 'Sends the welcome email and records the touchpoint.',
 *     input: {type: 'array', prefixItems: [{type: 'string'}], minItems: 1},
 *   },
 *   async (name: string) => act.greet(name),
 * );
 * ```
 *
 * Returns **the same function**, so nothing downstream changes: register it, call it, test
 * it exactly as before. The description is additive, and a workflow without one is not a
 * lesser citizen — it simply lists under its registered name.
 */
export function defineWorkflow<F extends AnyWorkflowFn>(
  descriptor: WorkflowDescriptor,
  fn: F,
): F {
  Object.defineProperty(fn, DESCRIPTOR, {
    // Copied and frozen: the caller's object stays theirs to keep mutating if they
    // insist, and every reader sees the same thing regardless.
    value: Object.freeze({...descriptor}),
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return fn;
}

/**
 * What a function was described with, or `undefined` if it never was.
 *
 * Takes `unknown` because the caller is usually iterating a registry of things it has not
 * checked — `Object.entries(workflows)` — and a reader of descriptions should not be the
 * thing that throws on a surprising value.
 */
export function workflowDescriptor(
  fn: unknown,
): WorkflowDescriptor | undefined {
  if (typeof fn !== 'function') return undefined;
  const value = (fn as unknown as Record<symbol, unknown>)[DESCRIPTOR];
  return value === undefined ? undefined : (value as WorkflowDescriptor);
}

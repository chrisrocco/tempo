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
 * It mutates the `run` function it is handed, which is worth being explicit about. The
 * property is non-enumerable, so it does not appear in `Object.keys`, spreads, or
 * `JSON.stringify`, and the descriptor is frozen so a reader cannot alter what other
 * readers see. `run` is handed back unchanged in every way an author can observe: same
 * reference, same signature, still directly callable in a unit test.
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

/**
 * Any workflow function: **one optional props object, and nothing else.**
 *
 * A workflow is started from a form, an API call or a schedule, where the caller
 * has named fields rather than an argument order — so it takes one object and
 * `WorkflowDescriptor.props` describes its keys. Variadic workflows made that
 * describable shape optional, and a start form had to know a positional order
 * nobody had written down.
 *
 * ## What the type does and does not enforce
 *
 * The arity is real: a two-parameter function is not assignable here, so it is a
 * compile error at `createWorkflow` and `registerWorkflow`. Object-ness is
 * **convention**, not a constraint — `props?: object` would reject every real
 * workflow, because `strictFunctionTypes` makes parameters contravariant and
 * `object` is not assignable to `{name: string}`. That is the same reason
 * `ActivityFn` keeps `any`, argued in AGENTS.md.
 *
 * So `(name: string)` still compiles. It is wrong by the rule and right by the
 * compiler, and the honest thing is to say so rather than reach for a
 * conditional type that would fail obscurely at every call site.
 *
 * **Activities are deliberately not subject to this.** `acts.charge(id, amount)`
 * is an ordinary function call at a site that knows the order, not a form
 * somebody fills in.
 */
export type AnyWorkflowFn = (props?: any) => Promise<unknown>;

/** A workflow and everything it says about itself, in one object. */
export interface WorkflowDefinition<
  S extends AnyWorkflowFn,
> extends WorkflowDescriptor {
  /**
   * The workflow itself, taking the props described above as one object.
   *
   * Named `run` rather than `start` because `start` is taken, and taken by the
   * opposite side: `client.start` and `service.start` *dispatch* a workflow from
   * outside, and this is the body that then runs. Two meanings of one word
   * across one API is worse than a word that is merely less evocative.
   */
  run: S;
}

/**
 * Define a workflow and describe it in one place.
 *
 * ```ts
 * export const greeter = defineWorkflow({
 *   title: 'Greet a customer',
 *   description: 'Sends the welcome email and records the touchpoint.',
 *   props: {
 *     type: 'object',
 *     properties: {
 *       customerId: {type: 'string'},
 *       locale: {type: 'string', description: 'Defaults to the account language.'},
 *     },
 *     required: ['customerId'],
 *   },
 *   async run(props: {customerId: string; locale?: string}) {
 *     return act.greet(props.customerId);
 *   },
 * });
 * ```
 *
 * **Returns `run` itself**, so nothing downstream changes:
 * `startWorker({workflows: {greeter}})` registers it under `greeter`, the engine invokes
 * it exactly as it invokes any other workflow function, and a unit test still calls it
 * directly. The description rides along on a non-enumerable property and is invisible to
 * everything that does not ask for it.
 *
 * ## One object, with the function inside it
 *
 * The first shape took the description and the function as two arguments. Folding the
 * function in reads better at the definition site — everything about the workflow is one
 * literal, and the props sit next to the signature that consumes them — and it means
 * there is no argument order to get backwards.
 *
 * ## The props type is written once, in `run`
 *
 * TypeScript infers it from the method, so the object literal in `run(props: {...})` is
 * the only place the shape is written as a type. The `props` JSON Schema beside it is the
 * *runtime* description, and the two are related by convention rather than by the
 * compiler.
 *
 * That duplication is real, and is the price of taking no schema library: deriving one from
 * the other needs one, which would be a runtime dependency this package does not have — and one whose major versions would then skew against every consumer that had
 * its own copy.
 */
export function defineWorkflow<S extends AnyWorkflowFn>(
  definition: WorkflowDefinition<S>,
): S {
  const {run, ...descriptor} = definition;
  Object.defineProperty(run, DESCRIPTOR, {
    // Copied and frozen: the caller's object stays theirs to keep mutating if they
    // insist, and every reader sees the same thing regardless.
    value: Object.freeze({...descriptor}),
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return run;
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

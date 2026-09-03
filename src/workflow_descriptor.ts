/**
 * @fileoverview
 * Attaching a `WorkflowDescriptor` to a workflow function, and reading it back.
 *
 * At `src/` root rather than in a layer, beside `activity_registry.ts`, and for the same
 * reason: it is glue between author code and the host. `createWorkflow` writes; a worker
 * assembling its catalogue reads. Neither `core/` nor `worker/` owns that.
 *
 * ## Why the descriptor rides on the function
 *
 * The alternative was a module-scope map — `describeWorkflows({greeter: {...}})`, which is
 * literally what `proxyActivities` does for activities. A map is keyed by a string, and a
 * string that has to match a function is a thing that can be typo'd and can silently drift.
 * Nothing would report it; the workflow would simply have no description forever.
 *
 * Riding on the function binds the two together, so whatever holds the function holds the
 * description — which is what lets `startWorker({workflows})` and the registry both find it
 * without being told where to look.
 *
 * It mutates the function, which is worth being explicit about. The property is
 * non-enumerable, so it does not appear in `Object.keys`, spreads, or `JSON.stringify`, and
 * the descriptor is frozen so a reader cannot alter what other readers see. The function is
 * otherwise unchanged in every way an author can observe: same reference, same signature,
 * still directly callable in a unit test — which is what `WorkflowRef.impl` hands back.
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

/**
 * Attach a description to a workflow body, and hand the body straight back.
 *
 * Internal to `createWorkflow`, which is the only thing that writes one — the
 * key and the description arrive together there, so there is no second place a
 * workflow can be described and no way for two descriptions to race.
 *
 * ## The props type and the props document come from one definition
 *
 * `createWorkflow` takes the props as a schema (`t.object({...})`, from the
 * `schema/` internal library), renders it into the descriptor written here, and
 * infers `run`'s parameter from the same value — so the shape is authored once
 * and the runtime description cannot drift from the type.
 *
 * That is the only way to describe props now. A pre-rendered JSON Schema was
 * once accepted beside it, where the two halves were related by convention
 * rather than by the compiler — the document said one thing, `run(props:
 * {...})` said another, and nothing compared them. `workflow_registry.ts`
 * argues why that form is gone; what reaches this file is unchanged either way,
 * since a rendered document is what was always written here.
 */
export function describeWorkflow<S extends AnyWorkflowFn>(
  run: S,
  descriptor: WorkflowDescriptor,
): S {
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

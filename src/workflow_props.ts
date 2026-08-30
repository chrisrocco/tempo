/**
 * @fileoverview
 * What a workflow's declared props mean: the document a catalogue publishes,
 * and the parse its body runs before the first line of it.
 *
 * At `src/` root beside `workflow_descriptor.ts`, and for the same reason — it
 * is glue between author code and the host. `createWorkflow` is the only thing
 * that calls in here to build a workflow; this is where the declaration turns
 * into the two things the engine does with it, so neither the registry nor the
 * descriptor has to hold the argument for why. `describeProps` is the one
 * export an author sees, through `workflow.ts`.
 *
 * It also runs where almost nothing at `src/` root does — **inside a replay**,
 * on every activation — which is why `tools/boundaries.ts` names it in
 * `REPLAY_MODULES` and holds it to the same purity as `core/`.
 *
 * ## The workflow validates; the engine still does not
 *
 * A props schema is enforced **inside the workflow, before its body** —
 * `createWorkflow` wraps the body in the parse. That is the placement
 * `protocol/workflow_descriptor.ts` always named ("the workflow's own first
 * lines"), automated, so it changes nothing about what the server or the
 * protocol do: a start is accepted the way it always was, `props` cross the
 * wire unexamined, and the catalogue stays a description rather than a gate.
 *
 * The failure is therefore an **ordinary workflow failure**: the execution
 * exists, and settles failed on its first activation with the schema's own
 * flattened message. That is the cost, stated plainly — a caller learns its
 * props were wrong by watching the execution it started, not from the call that
 * started it.
 *
 * The alternative, rejecting the start at the server, buys the better error and
 * costs more than it is worth today. The server holds only the *rendered*
 * document, so it would need a JSON Schema interpreter — a thing the schema
 * library deliberately does not have, since its whole vocabulary is what can be
 * rendered rather than what can be read back. It would also make the catalogue
 * load-bearing for correctness: a workflow no live worker has reported, or one
 * two workers describe differently, has no schema the server can trust, and
 * "unvalidatable" would have to mean "rejected" or "accepted" — both wrong.
 * That door stays open; the parse here is what makes walking through it an
 * improvement to an error message rather than the feature itself.
 *
 * ## The schema is code the replay re-runs
 *
 * History records the props a caller sent, not the parsed value, so every
 * replay re-derives the body's input from the schema as it is written *now*.
 * Two consequences worth knowing before editing one:
 *
 * - **Tightening a live schema fails in-flight executions.** A rule that now
 *   rejects props already recorded turns their next activation into a failure,
 *   and `patched` cannot help — the parse runs before the body, where there is
 *   no branch to record. Widen while executions are in flight; tighten when
 *   none are.
 * - **Changing a `defaulted` value changes what a running execution sees**, on
 *   its next activation, mid-flight. If that value reaches a command, replay
 *   diverges from history and the engine stops the execution rather than
 *   publishing it (`core/apply_event`).
 *
 * Nothing here is non-deterministic by itself: the library is pure and
 * synchronous, and the same history drives the same parse to the same value.
 *
 * ## Describing without enforcing
 *
 * A declaration that hands over a *document* — `props: describeProps(Search)` —
 * describes exactly as before and is parsed by nothing, because what arrives is
 * a document rather than a schema. That is the escape hatch, and it is the same
 * distinction `createWorkflow` already made rather than a flag added beside it:
 * there is no `validate: false` to find, and no way to end up half-enforced.
 */

import {formatIssues, type Schema, type SchemaResult} from './libraries/schema';
import type {WorkflowPropsSchema} from './protocol';
import type {AnyWorkflowFn} from './workflow_descriptor';

/**
 * The author's body behind a parsing one, so `createWorkflow` can compare
 * *bodies* when two calls claim a name.
 *
 * `Symbol.for` rather than a module-local symbol, for the reason
 * `workflow_descriptor.ts` gives: a module can evaluate twice, and two local
 * symbols would not match.
 *
 * Without this, wrapping would invent conflicts. A module that evaluates twice
 * hands `createWorkflow` the same function twice — tolerated, deliberately —
 * but two wrappers around it are two different functions, and comparing those
 * would make an ordinary double evaluation refuse to start a worker.
 */
const BODY = Symbol.for('tempo.workflowBody');

/**
 * The schema behind a props declaration, or `undefined` when what was declared
 * is a rendered document.
 *
 * Told apart by the `validate` method rather than by a brand or an
 * `instanceof`: the port is an interface anything may implement, and a JSON
 * Schema document has no methods at all, so one function-valued key separates
 * them without either side declaring which it is.
 */
export function propsSchema(
  props: WorkflowPropsSchema | Schema,
): Schema | undefined {
  const schema = props as Schema;
  return typeof schema.validate === 'function' ? schema : undefined;
}

/**
 * The descriptor's `props`, from either form of declaration.
 *
 * A schema that renders nothing — `toJsonSchema` is the port's optional half —
 * leaves the descriptor with no props, which reads as "not described", exactly
 * like a workflow that said nothing. Same tolerance as
 * `connectors/catalogue.ts` shows an unrenderable operation schema, and for the
 * same reason: refusing to register would take a workflow that runs perfectly
 * well off its queue over missing documentation. It is still *enforced* — being
 * undescribable says nothing about being unparseable.
 */
export function renderProps(
  props: WorkflowPropsSchema | Schema,
): WorkflowPropsSchema | undefined {
  const schema = propsSchema(props);
  return schema ? describeProps(schema) : (props as WorkflowPropsSchema);
}

/**
 * A schema as the props document alone: what `createWorkflow` would have
 * published, with nothing left to parse with.
 *
 * Two callers, one shape. `props: describeProps(Search)` is **describe without
 * enforcing** — the form to reach for when a workflow has executions in flight
 * that a new schema would reject, or when the schema is a description of what
 * callers do rather than a rule they must meet. And it is how a
 * `WorkflowDescriptor` assembled by hand — a fixture, a harness, anything not
 * going through `createWorkflow` — gets a document without writing JSON Schema
 * out longhand.
 *
 * It exists because the rendering is not assignable on its own: a schema's
 * `toJsonSchema()` is a `JsonSchema`, whose `type` is any string, and
 * `WorkflowPropsSchema` narrows that to `'object'` to say what these props are.
 * Every caller would otherwise write the same cast, and one of them would cast
 * something that was not an object schema at all.
 */
export function describeProps(schema: Schema): WorkflowPropsSchema | undefined {
  return schema.toJsonSchema?.() as WorkflowPropsSchema | undefined;
}

/**
 * The body, behind the parse its schema asked for: props in, parsed props to
 * the author's function, a failure that names the workflow if they do not
 * match.
 *
 * The parsed value is what the body receives, which is where `t.defaulted`
 * earns its keep — a default is filled here, once per activation, rather than
 * with `?? 20` at each use — and where `t.object`'s tolerance shows: an
 * undeclared key is stripped rather than rejected, so a caller that sends a
 * field the workflow has not declared still runs.
 */
export function parsingBody<F extends AnyWorkflowFn>(
  name: string,
  schema: Schema,
  run: F,
): F {
  const body = async (props?: unknown): Promise<unknown> =>
    run(parse(name, schema, props));
  Object.defineProperty(body, BODY, {value: run, enumerable: false});
  return body as F;
}

/**
 * The author's function behind `fn`, when `fn` is a parsing body; `fn` itself
 * otherwise — see `BODY` for what it is for.
 */
export function workflowBody<F>(fn: F): F {
  const inner = (fn as unknown as Record<symbol, unknown>)[BODY];
  return typeof inner === 'function' ? (inner as F) : fn;
}

function parse(name: string, schema: Schema, props: unknown): unknown {
  const result = schema.validate(props);
  if (isPromise(result)) {
    throw new Error(
      `${name} declares an async props schema, which cannot be parsed inside a replay — ` +
        `props are parsed synchronously before the body runs, so validate() must return a result rather than a promise`,
    );
  }
  if (result.ok) return result.value;
  throw new Error(
    `${name} was started with props its schema rejects: ${formatIssues(result.issues)}`,
  );
}

function isPromise<Out>(
  result: SchemaResult<Out> | Promise<SchemaResult<Out>>,
): result is Promise<SchemaResult<Out>> {
  return typeof (result as Promise<SchemaResult<Out>>).then === 'function';
}

/**
 * @fileoverview
 * ★ SCHEMA ENTRYPOINT — one definition that validates, renders to JSON Schema,
 * and infers its own TypeScript types.
 *
 * ```ts
 * import {t, runSchema, type OutOf} from 'workflow-engine/schema';
 *
 * const Search = t.object({
 *   query: t.string({description: 'What to search for'}),
 *   limit: t.defaulted(t.integer({min: 1, max: 100}), 20),
 * });
 *
 * type Search = OutOf<typeof Search>; // {query: string; limit: number}
 * Search.jsonSchema; // hand to a form to render, or to a model as a tool schema
 *
 * const result = await runSchema(Search, raw);
 * if (!result.ok) return reject(result.message); // every issue, one string
 * result.value.limit; // 20 — filled at parse, not `?? 20` at the call site
 * ```
 *
 * `runSchema` **returns a result rather than throwing**, and is async because
 * the port allows a validator to be. A failure is an ordinary value with a
 * flattened message, which is what you want when the thing being validated came
 * from a model or a user rather than from your own code.
 *
 * A complete schema library, owned outright: `t` (`builder.ts`) is the
 * authoring surface, built on a **validator port** (`port.ts`), one interface
 * this repo owns. Around them: `runSchema` to run a validation and flatten
 * failures into one message, and `strictProblems` to check a raw value for keys
 * a rendered JSON Schema does not declare.
 *
 * **None of it knows this repo exists** — no engine vocabulary, no workflows,
 * no connectors, no imports at all. That is what makes it reusable on its own,
 * and it is a rule rather than a happy accident: the test for any change here
 * is `walltime/`'s, "would this API make sense published on its own?", and
 * `library-boundary` fails the first import that answers no. Reach for it
 * wherever a shape has to be described once and used three ways — an
 * agent's tool definitions, an API's request bodies, a form's fields, or a
 * workflow's props — which is what the engine's second consumer of it does.
 *
 * ## The vocabulary
 *
 * Deliberately small, and sized by one constraint: everything here must be
 * renderable as JSON Schema, so the vocabulary is exactly the language of
 * JSON-over-the-wire shapes.
 *
 * | Builder | Type | Notes |
 * | --- | --- | --- |
 * | `t.string(opts?)` | `string` | `pattern`, `minLength`, `maxLength`, `format` |
 * | `t.number` / `t.integer` | `number` | `min`, `max` |
 * | `t.boolean(opts?)` | `boolean` | |
 * | `t.literal(v)` | that value | renders as `const` |
 * | `t.enum('a', 'b', …)` | `'a' \| 'b'` | string unions |
 * | `t.array(inner)` | `Inner[]` | |
 * | `t.object({…})` | object | `required` derived from presence; strips unknowns |
 * | `t.record(value)` | `Record<string, …>` | renders as `additionalProperties` |
 * | `t.union(a, b, …)` | `A \| B` | first branch that validates wins |
 * | `t.nullable(inner)` | `T \| null` | |
 * | `t.optional(inner)` | `T \| undefined` | optional key; absent stays absent |
 * | `t.defaulted(inner, v)` | `T` | optional for callers, **present for handlers** |
 * | `t.unknown()` | `unknown` | accepts anything; renders unconstrained |
 *
 * Three behaviours worth knowing before you author with it:
 *
 * - **`description` renders.** Every builder takes one, and it survives into
 *   the JSON Schema — which is what a form shows as field help and what a model
 *   reads as the argument's meaning. Documentation is part of the schema, not
 *   beside it.
 * - **`t.defaulted` fills at parse.** Optional on the way in, guaranteed on the
 *   way out — `InferInput` and `InferOutput` carry exactly that difference — so
 *   a handler never writes `input.limit ?? 20`.
 * - **`t.object` strips unknown keys rather than rejecting.** A caller that
 *   sends a field you have not declared still parses, which is what lets a
 *   consumer survive a service adding one. When you need the opposite, ask for
 *   it explicitly — `strictProblems(Search.jsonSchema, raw)` names every
 *   undeclared key. Note it reads the *rendered* schema, not the builder, and
 *   that it belongs in a conformance test rather than on the hot path: the
 *   point is to turn a nightly run red, not to reject a caller.
 *
 * Transforms, closure refinements and coercion are **deliberately absent**. Each
 * would express a shape no JSON Schema can render, and a schema that cannot be
 * rendered cannot be shown to a person or handed to a model — which is half of
 * what this library is for.
 *
 * ## All the way in-house, deliberately — with the revisit seam kept
 *
 * This decision has moved twice, each time toward owning more. First Standard
 * Schema was the foundation, with a global per-vendor emitter registry for
 * JSON Schema. Then the port replaced the registry and Standard Schema became
 * one adapter (`standard()`) beside the first-party builder. Now the adapter
 * and the vendored spec are gone too: if the repo is building a schema
 * library, it builds it all the way, and `t` is the one authoring surface.
 * The port is what keeps that reversible — an external vendor, should one ever
 * earn its place, returns as an adapter onto this interface the way a new
 * store would arrive behind `server/ports/`, with nothing downstream
 * changing.
 *
 * ## The contract, and where it is enforced
 *
 * - **It imports nothing.** Not other layers, not Node builtins — living under
 *   `src/libraries/` opts it into the checker's `library-boundary` rule
 *   (`tools/boundaries.ts`), which pins every file here to this package. That
 *   is also why this path is absent from `BROWSER_SAFE_ENTRYPOINTS` while being
 *   safe in a browser, an edge runtime, or anywhere else: a rule that cannot
 *   fail is a rule about nothing, and `library-boundary` already fails the
 *   import that would make it unsafe.
 * - **The engine touches it only at named call sites.** The seam is asserted by
 *   `spec/libraries/schema/seam.spec.ts` (built on
 *   `spec/support/library_seam.ts`), which names every one: `connectors/`,
 *   where the library was extracted from, plus the two files that let a
 *   workflow describe its props with it — `workflow_registry.ts`, which renders
 *   an author's schema into the descriptor a catalogue publishes, and
 *   `workflow.ts`, which re-exports `t` because workflow code may import
 *   nothing else.
 * - **Consumers import this index**, the way they would import a package root —
 *   deep imports would make the seam a lie about the real coupling.
 *
 * ## What publishing it changed
 *
 * `workflow-engine/schema` is on the `exports` map, which moves this library
 * out of reach of the seam spec's original promise. That spec could say
 * "delete connectors and this together and the engine is as it was" while every
 * consumer was inside the repo; a published path is resolved by name from
 * outside, where no check here can see it. So the removal instruction now has
 * two halves, and only the first is mechanised.
 *
 * The alternative was to leave it unpublished and let a consumer copy the
 * directory, which is the same coupling with no way to fix a bug once. Between
 * a dependency that is visible and one that is invisible, this takes the
 * visible one — and accepts that the library is now load-bearing for people
 * this repo cannot enumerate.
 *
 * If it ever wants to be a package of its own, nothing here has to change:
 * every file is already import-free, and the extraction is a move plus a
 * `package.json`. What that would buy is a consumer that does not depend on the
 * engine to get a schema builder; what it would cost is a second release to
 * keep in step. Worth doing when someone wants the first without wanting tempo
 * at all, and not before.
 */

export type {
  InferInput,
  InferOutput,
  Schema,
  SchemaIssue,
  SchemaResult,
} from './port';
export type {JsonSchema} from './json_schema';
export {
  t,
  type InOf,
  type OutOf,
  type TDefaulted,
  type TOptional,
  type TSchema,
} from './builder';
export {runSchema, type Validated} from './validate';
export {strictProblems} from './strict';

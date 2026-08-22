/**
 * @fileoverview
 * ★ SCHEMA — an internally-owned library, deliberately held at arm's length.
 * Developer documentation for authoring with `t` lives with its consumer:
 * `src/connectors/README.md` (the "Schemas: t" section).
 *
 * A complete schema library, owned outright: `t` (`builder.ts`) is the
 * authoring surface — validation, JSON Schema rendering, and type inference in
 * one small vocabulary sized to what a dashboard can render — built on a
 * **validator port** (`port.ts`), one interface this repo owns. Around them:
 * `runSchema` to run a validation and flatten failures into one message, and
 * `strictProblems` to check a raw value for keys a rendered JSON Schema does
 * not declare. That is the whole surface, and none of it knows this repo
 * exists: no engine vocabulary, no workflows, no connectors. The test for any
 * change here is the same as `walltime/`'s: "would this API make sense
 * published on its own?"
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
 *   (`tools/boundaries.ts`), which pins every file here to this package.
 * - **The engine touches it only at named call sites.** The seam is asserted by
 *   `spec/libraries/schema/seam.spec.ts` (built on
 *   `spec/support/library_seam.ts`), which is also the removal instruction:
 *   today every call site is in `connectors/`, so deleting connectors and this
 *   library together leaves the engine exactly as it was.
 * - **Consumers import this index**, the way they would import a package root —
 *   deep imports would make the seam a lie about the real coupling.
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

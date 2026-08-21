/**
 * @fileoverview
 * ★ SCHEMA — an internally-owned library, deliberately held at arm's length.
 *
 * Speaking schema without naming a vendor, through a **validator port**
 * (`port.ts`): one interface this repo owns, with `validate`, an optional
 * `toJsonSchema`, and type inference carried on the generic parameters. Around
 * it: `t` (`builder.ts`) — the first-party builder and the default authoring
 * surface, implemented natively on the port and sized to what JSON Schema can
 * render; `standard()` — the adapter door, wrapping any Standard Schema vendor
 * (Zod ≥3.24, Valibot ≥1.0, ArkType ≥2) as a port for teams that want one;
 * `runSchema` to run a validation and flatten failures into one message; and
 * `strictProblems` to check a raw value for keys a rendered JSON Schema does
 * not declare. That is the whole surface, and none of it knows this repo
 * exists: no engine vocabulary, no workflows, no connectors. The test for any
 * change here is the same as `walltime/`'s: "would this API make sense
 * published on its own?"
 *
 * ## Ports over protocols, deliberately
 *
 * An earlier shape put Standard Schema at the foundation — operations took
 * `~standard` values directly, and JSON Schema came from a global per-vendor
 * emitter registry. The port inverts that: the repo defines what it needs
 * (validate, render, infer), vendors are adapted *in* at the edge, a
 * hand-rolled validator implements the port directly with no spec at all
 * (`spec/support/mini_schema.ts` is the reference), and rendering is a method
 * on the value instead of ambient registry state. Standard Schema remains
 * vendored (`standard_schema.ts`) because the adapter needs its types — but it
 * is one door, not the house.
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
export {standard} from './standard';
export type {StandardSchemaV1} from './standard_schema';
export {runSchema, type Validated} from './validate';
export {strictProblems} from './strict';

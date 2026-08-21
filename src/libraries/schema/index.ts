/**
 * @fileoverview
 * ★ SCHEMA — an internally-owned library, deliberately held at arm's length.
 *
 * Speaking schema without naming a vendor: validate anything that implements
 * Standard Schema (`~standard` — the vendored interface Zod ≥3.24, Valibot ≥1.0
 * and ArkType ≥2 all ship), carry JSON Schema as an open structural type with a
 * per-vendor emitter registry, and check strict conformance — undeclared keys —
 * against an emitted JSON Schema, because strictness is a vendor feature the
 * interface deliberately does not expose. That is the whole surface, and none
 * of it knows this repo exists: no engine vocabulary, no workflows, no
 * connectors. The test for any change here is the same as `walltime/`'s:
 * "would this API make sense published on its own?"
 *
 * ## The contract, and where it is enforced
 *
 * - **It imports nothing.** Not other layers, not Node builtins — living under
 *   `src/libraries/` opts it into the checker's `library-boundary` rule
 *   (`tools/boundaries.ts`), which pins every file here to this package.
 * - **The engine touches it only at named call sites.** The seam is asserted by
 *   `spec/libraries/schema/seam.spec.ts` (built on `spec/support/library_seam.ts`), which
 *   is also the removal instruction: today every call site is in
 *   `connectors/`, so deleting connectors and this directory together leaves
 *   the engine exactly as it was.
 * - **Consumers import this index**, the way they would import a package root —
 *   deep imports would make the seam a lie about the real coupling.
 *
 * Why a library and not part of `connectors/`, where it was first written:
 * nothing in these four modules is about connectors. A dashboard validating
 * form input, a config loader, the engine's own descriptor plumbing — any of
 * them could use this without dragging connector vocabulary along, and the
 * arm's-length shape is what keeps that price at zero until someone chooses to
 * pay it.
 */

export type {StandardSchemaV1} from './standard_schema';
export {
  emitJsonSchema,
  registerSchemaEmitter,
  type JsonSchema,
  type SchemaEmitter,
} from './json_schema';
export {runSchema, type Validated} from './validate';
export {strictProblems} from './strict';

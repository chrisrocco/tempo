/**
 * @fileoverview
 * The validator port: everything this repo requires of a schema value, as one
 * interface it owns — the same move `server/ports/` makes for storage and
 * queues, applied to validation.
 *
 * Three capabilities. Two are methods; the third cannot be, and saying why is
 * part of the contract:
 *
 * - **`validate`** — parse an unknown value into the schema's type, or report
 *   issues. May be async, because some vendors are.
 * - **`toJsonSchema`** — this schema as JSON Schema, for whatever renders or
 *   strict-checks (the catalogue, the certification harness). Optional: a
 *   schema that cannot render still validates, and every consumer of the
 *   rendering treats absence as "unrendered"/"unchecked", never as an error.
 * - **Type inference** — not a method, because types do not exist at runtime.
 *   The port's generic parameters carry them (`Out` is what `validate`
 *   produces; `In` is what callers may pass where the schema describes an
 *   input, looser than `Out` when a vendor fills defaults), and
 *   `InferOutput`/`InferInput` read them back. The optional `types` member is
 *   a phantom — never assigned, never read — that exists so both parameters
 *   stay structurally inferable.
 *
 * The first-party builder (`builder.ts`) implements this port natively and is
 * the authoring surface. The port stays a separate interface rather than being
 * folded into the builder because it is the revisit seam: an external schema
 * vendor, should one ever earn its place, arrives as an adapter onto this
 * interface — the way `server/ports/` would admit a new store — with nothing
 * downstream changing. Everything downstream of this file speaks only the
 * port.
 */

import type {JsonSchema} from './json_schema';

/** One validation failure, located when the vendor can say where. */
export interface SchemaIssue {
  readonly message: string;
  readonly path?: readonly (string | number)[];
}

export type SchemaResult<Out> =
  | {readonly ok: true; readonly value: Out}
  | {readonly ok: false; readonly issues: readonly SchemaIssue[]};

/** The validator port. `Out` is what validate produces; `In` what callers pass. */
export interface Schema<Out = unknown, In = Out> {
  validate(value: unknown): SchemaResult<Out> | Promise<SchemaResult<Out>>;
  toJsonSchema?(): JsonSchema | undefined;
  /** Phantom type carrier — see the fileoverview. Never present at runtime. */
  readonly types?: {readonly input: In; readonly output: Out};
}

/** What `validate` produces — the "inferTypes" of the port, spelled as a type. */
export type InferOutput<S extends Schema> =
  S extends Schema<infer Out, infer _In> ? Out : never;

/** What callers may pass where this schema describes an input. */
export type InferInput<S extends Schema> =
  S extends Schema<infer _Out, infer In> ? In : never;

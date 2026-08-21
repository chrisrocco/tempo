/**
 * @fileoverview
 * JSON Schema for the catalogue, without a schema-library dependency — the same
 * move tempo made for workflow metadata: a structural, open type that carries
 * whatever a real emitter produced, plus an emitter registry keyed by the
 * Standard Schema `vendor` string.
 *
 * The framework core never emits JSON Schema itself; it only asks whichever
 * emitter the consumer registered. A consumer using Zod 4 wires it in one line:
 *
 * ```ts
 * import {z} from 'zod';
 * registerSchemaEmitter('zod', (s) => z.toJSONSchema(s as never) as JsonSchema);
 * ```
 *
 * Valibot users register `@valibot/to-json-schema` under `'valibot'`, and so on.
 * A schema whose vendor has no registered emitter simply lists in the catalogue
 * without a rendered form — absence degrades, it does not throw.
 */

import type {StandardSchemaV1} from './standard_schema';

/**
 * A JSON Schema, as far as this framework needs to know one: structural and
 * open, mirroring tempo's `protocol/workflow_descriptor.ts`. Only the fields a
 * renderer reads are named; the index signature carries everything else through
 * untouched.
 */
export interface JsonSchema {
  type?: string;
  description?: string;
  [keyword: string]: unknown;
}

/** Turns one vendor's schemas into JSON Schema. Registered by the consumer. */
export type SchemaEmitter = (
  schema: StandardSchemaV1,
) => JsonSchema | undefined;

const emitters = new Map<string, SchemaEmitter>();

/** Register (or replace) the JSON Schema emitter for one vendor. */
export function registerSchemaEmitter(
  vendor: string,
  emit: SchemaEmitter,
): void {
  emitters.set(vendor, emit);
}

/**
 * Emit JSON Schema for a schema, if its vendor has a registered emitter.
 * `undefined` means "no emitter" — the catalogue treats that as un-rendered,
 * not as an error.
 */
export function emitJsonSchema(
  schema: StandardSchemaV1,
): JsonSchema | undefined {
  return emitters.get(schema['~standard'].vendor)?.(schema);
}

/**
 * @fileoverview
 * JSON Schema as far as this library needs to know it: a structural, open type
 * — the same move tempo's `protocol/workflow_descriptor.ts` makes for workflow
 * metadata. Only the fields a renderer reads are named; the index signature
 * carries everything else (`$schema`, `enum`, `format`, `allOf`) through
 * untouched, which is what lets a document emitted by any tool be passed
 * straight in. Inventing a closed type would mean tracking a spec this library
 * has no reason to implement.
 *
 * How a schema value provides its JSON Schema is the port's business
 * (`port.ts`: the optional `toJsonSchema` method) — a registry of per-vendor
 * emitters lived here once and is gone: ambient state, replaced by a method on
 * the value itself.
 */

/** A JSON Schema: structural and open. */
export interface JsonSchema {
  type?: string;
  description?: string;
  [keyword: string]: unknown;
}

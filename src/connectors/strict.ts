/**
 * @fileoverview
 * The strict half of schema truth: does a live response carry anything the
 * connector does not declare?
 *
 * Declared validation (`runSchema`) answers "is everything we claim present and
 * well-typed" — but most vendors' object schemas *strip* unknown keys rather
 * than reject them, so a service quietly growing its response would never fail
 * it. Strictness is a per-vendor, per-schema feature Standard Schema does not
 * expose, and the framework refuses to depend on one vendor's spelling of it.
 * So the certification harness checks the other direction structurally: walk
 * the raw response against the operation's **emitted JSON Schema** and report
 * every key the schema has no entry for.
 *
 * Used only by the live tier. Production parsing stays tolerant on purpose —
 * an additive upstream change degrades gracefully in workflows while the
 * nightly certification run turns red and names the field (see the RFC's
 * "strict in tests, tolerant in production" decision).
 *
 * Deliberately shallow about JSON Schema: it reads `properties`,
 * `additionalProperties`, and `items`, and passes through anything else —
 * the same open-world stance as `json_schema.ts`. A schema with no emitter
 * yields no strict check, which the harness reports as "unchecked", never as
 * "clean".
 */

import type {JsonSchema} from './json_schema';

/**
 * Paths in `value` that the schema does not account for — `[]` means strictly
 * conformant *as far as this schema can say*.
 *
 * An unknown key whose value is `undefined` is skipped: JSON serialization
 * drops it, so nothing downstream — history, goldens, a dashboard — can ever
 * observe it.
 */
export function strictProblems(
  schema: JsonSchema | undefined,
  value: unknown,
  path = '$',
): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const problems: string[] = [];

  const properties = schema['properties'];
  if (
    properties &&
    typeof properties === 'object' &&
    !Array.isArray(properties)
  ) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const declared = properties as Record<string, JsonSchema>;
      const additional = schema['additionalProperties'];
      const allowsUnknown =
        additional === true ||
        (typeof additional === 'object' && additional !== null);
      for (const [key, entry] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (entry === undefined) continue;
        const declaredSchema = declared[key];
        if (declaredSchema !== undefined) {
          problems.push(
            ...strictProblems(declaredSchema, entry, `${path}.${key}`),
          );
        } else if (!allowsUnknown) {
          problems.push(`${path}.${key}`);
        }
      }
    }
    return problems;
  }

  const items = schema['items'];
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        problems.push(
          ...strictProblems(items as JsonSchema, item, `${path}[${index}]`),
        ),
      );
    }
  }
  return problems;
}

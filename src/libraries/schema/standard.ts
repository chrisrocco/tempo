/**
 * @fileoverview
 * The Standard Schema adapter: any `~standard`-carrying schema (Zod ≥3.24,
 * Valibot ≥1.0, ArkType ≥2) as a validator port. This is deliberately the only
 * place the vendored spec interface is *executed* — everything downstream
 * speaks the port, and Standard Schema is one way in rather than the
 * foundation.
 *
 * Emission stays the caller's, because the one thing the spec deliberately
 * omits is JSON Schema. A Zod 4 consumer writes the pairing once:
 *
 * ```ts
 * const schema = <S extends z.ZodType>(s: S) =>
 *   standard(s, () => z.toJSONSchema(s) as JsonSchema);
 * ```
 *
 * and every schema in their connectors validates, infers, and renders through
 * that five-line helper. A vendor with no emitter simply omits the second
 * argument and lists unrendered.
 */

import type {JsonSchema} from './json_schema';
import type {Schema, SchemaIssue} from './port';
import type {StandardSchemaV1} from './standard_schema';

/** Wrap a Standard Schema as a validator port, optionally with its rendering. */
export function standard<S extends StandardSchemaV1>(
  schema: S,
  toJsonSchema?: () => JsonSchema | undefined,
): Schema<StandardSchemaV1.InferOutput<S>, StandardSchemaV1.InferInput<S>> {
  type Out = StandardSchemaV1.InferOutput<S>;
  const port: Schema<Out, StandardSchemaV1.InferInput<S>> = {
    async validate(value) {
      const result = await schema['~standard'].validate(value);
      if (result.issues === undefined) {
        return {ok: true, value: result.value as Out};
      }
      return {ok: false, issues: result.issues.map(toIssue)};
    },
  };
  if (toJsonSchema) return {...port, toJsonSchema};
  return port;
}

function toIssue(issue: StandardSchemaV1.Issue): SchemaIssue {
  const path = issue.path?.map((segment) => {
    const key = typeof segment === 'object' ? segment.key : segment;
    return typeof key === 'number' ? key : String(key);
  });
  return path ? {message: issue.message, path} : {message: issue.message};
}

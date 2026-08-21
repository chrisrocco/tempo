/**
 * @fileoverview
 * Running a Standard Schema validation and turning failures into the framework's
 * vocabulary. The spec allows `validate` to return a Promise, so everything here
 * is async; callers are host-side (activity wrappers, config resolution), never
 * workflow code.
 */

import type {StandardSchemaV1} from './standard_schema';

export type Validated<T> = {ok: true; value: T} | {ok: false; message: string};

export async function runSchema<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<Validated<StandardSchemaV1.InferOutput<S>>> {
  const result = await schema['~standard'].validate(value);
  if (result.issues === undefined) {
    return {
      ok: true,
      value: result.value as StandardSchemaV1.InferOutput<S>,
    };
  }
  return {ok: false, message: formatIssues(result.issues)};
}

function formatIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
  return issues
    .map((issue) => {
      const path = issue.path
        ?.map((p) => String(typeof p === 'object' ? p.key : p))
        .join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

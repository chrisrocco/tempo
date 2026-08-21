/**
 * @fileoverview
 * Running a port validation and flattening failures into one message. The port
 * allows `validate` to be async, so everything here is async; callers are
 * host-side (activity wrappers, config resolution, the certification harness),
 * never workflow code.
 */

import type {InferOutput, Schema, SchemaIssue} from './port';

export type Validated<T> = {ok: true; value: T} | {ok: false; message: string};

export async function runSchema<S extends Schema>(
  schema: S,
  value: unknown,
): Promise<Validated<InferOutput<S>>> {
  const result = await schema.validate(value);
  if (result.ok) return {ok: true, value: result.value as InferOutput<S>};
  return {ok: false, message: formatIssues(result.issues)};
}

function formatIssues(issues: readonly SchemaIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path?.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

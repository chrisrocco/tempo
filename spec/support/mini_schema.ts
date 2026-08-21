/**
 * @fileoverview
 * A deliberately tiny schema library implementing the validator port natively —
 * the proof that a hand-rolled validator plugs in with no Standard Schema, no
 * adapter, and no vendor at all: `validate` and `toJsonSchema` are just
 * methods, and inference rides the port's generic parameter. Nothing in `src/`
 * knows this exists.
 *
 * In a real deployment this file is replaced by `import {z} from 'zod'` plus
 * the one-per-repo pairing helper over the `standard()` adapter:
 *
 * ```ts
 * const schema = <S extends z.ZodType>(s: S) =>
 *   standard(s, () => z.toJSONSchema(s) as JsonSchema);
 * ```
 */

import type {
  JsonSchema,
  Schema,
  SchemaResult,
} from '../../src/libraries/schema';

export interface MiniSchema<T> extends Schema<T, T> {
  validate(value: unknown): SchemaResult<T>;
  toJsonSchema(): JsonSchema;
  readonly jsonSchema: JsonSchema;
  /** Set by `opt()`; `obj()` reads it to build `required`. */
  readonly optional?: boolean;
}

/** An `opt()` schema: `obj()` maps these to optional keys, type and runtime. */
export interface OptionalMiniSchema<T> extends MiniSchema<T> {
  readonly optional: true;
}

export type Infer<S> = S extends MiniSchema<infer T> ? T : never;

type Result<T> = SchemaResult<T>;

function make<T>(
  jsonSchema: JsonSchema,
  validate: (value: unknown) => Result<T>,
  optional = false,
): MiniSchema<T> {
  return {
    jsonSchema,
    optional,
    validate,
    toJsonSchema: () => jsonSchema,
  };
}

const issue = (message: string): {ok: false; issues: [{message: string}]} => ({
  ok: false,
  issues: [{message}],
});

export const str = (): MiniSchema<string> =>
  make({type: 'string'}, (v) =>
    typeof v === 'string' ? {ok: true, value: v} : issue('expected string'),
  );

export const num = (): MiniSchema<number> =>
  make({type: 'number'}, (v) =>
    typeof v === 'number' && Number.isFinite(v)
      ? {ok: true, value: v}
      : issue('expected number'),
  );

export const lit = <const L extends readonly string[]>(
  ...values: L
): MiniSchema<L[number]> =>
  make({type: 'string', enum: [...values]}, (v) =>
    typeof v === 'string' && values.includes(v)
      ? {ok: true, value: v as L[number]}
      : issue(`expected one of ${values.join(', ')}`),
  );

export const nul = <T>(inner: MiniSchema<T>): MiniSchema<T | null> =>
  make({...inner.jsonSchema, nullable: true}, (v) =>
    v === null
      ? {ok: true, value: null}
      : (inner.validate(v) as Result<T | null>),
  );

export const opt = <T>(
  inner: MiniSchema<T>,
): OptionalMiniSchema<T | undefined> =>
  make(
    inner.jsonSchema,
    (v) =>
      v === undefined
        ? {ok: true, value: undefined}
        : (inner.validate(v) as Result<T | undefined>),
    true,
  ) as OptionalMiniSchema<T | undefined>;

export const arr = <T>(inner: MiniSchema<T>): MiniSchema<T[]> =>
  make({type: 'array', items: inner.jsonSchema}, (v) => {
    if (!Array.isArray(v)) return issue('expected array');
    const out: T[] = [];
    for (const [i, item] of v.entries()) {
      const r = inner.validate(item);
      if (!r.ok) return issue(`[${i}]: ${r.issues[0]!.message}`);
      out.push(r.value);
    }
    return {ok: true, value: out};
  });

type ReqKeys<Shape> = {
  [K in keyof Shape as Shape[K] extends {optional: true} ? never : K]: Infer<
    Shape[K]
  >;
};
type OptKeys<Shape> = {
  [K in keyof Shape as Shape[K] extends {optional: true} ? K : never]?: Infer<
    Shape[K]
  >;
};
export type ObjOut<Shape> = ReqKeys<Shape> & OptKeys<Shape>;

/** Validates declared keys, strips undeclared ones (so env objects work). */
export const obj = <Shape extends Record<string, MiniSchema<unknown>>>(
  shape: Shape,
): MiniSchema<ObjOut<Shape>> => {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    properties[key] = field.jsonSchema;
    if (!field.optional) required.push(key);
  }
  return make({type: 'object', properties, required}, (v) => {
    if (typeof v !== 'object' || v === null) return issue('expected object');
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      const r = field.validate((v as Record<string, unknown>)[key]);
      if (!r.ok) return issue(`${key}: ${r.issues[0]!.message}`);
      out[key] = r.value;
    }
    return {ok: true, value: out as ObjOut<Shape>};
  });
};

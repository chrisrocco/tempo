/**
 * @fileoverview
 * A deliberately tiny schema library implementing Standard Schema v1 — the
 * proof that the framework is vendor-agnostic. Nothing in `src/` knows this
 * exists; it plugs in exactly the way Zod or Valibot would: schemas carry
 * `~standard`, and one emitter registration makes them render in the catalogue.
 *
 * In a real deployment this file is replaced by `import {z} from 'zod'` plus:
 *
 * ```ts
 * registerSchemaEmitter('zod', (s) => z.toJSONSchema(s as never) as JsonSchema);
 * ```
 */

import type {StandardSchemaV1} from '../../../src/connectors/standard_schema';
import {
  registerSchemaEmitter,
  type JsonSchema,
} from '../../../src/connectors/json_schema';

export interface MiniSchema<T> extends StandardSchemaV1<T, T> {
  readonly jsonSchema: JsonSchema;
  /** Set by `opt()`; `obj()` reads it to build `required`. */
  readonly optional?: boolean;
}

/** An `opt()` schema: `obj()` maps these to optional keys, type and runtime. */
export interface OptionalMiniSchema<T> extends MiniSchema<T> {
  readonly optional: true;
}

export type Infer<S> = S extends MiniSchema<infer T> ? T : never;

type Result<T> = StandardSchemaV1.Result<T>;

function make<T>(
  jsonSchema: JsonSchema,
  validate: (value: unknown) => Result<T>,
  optional = false,
): MiniSchema<T> {
  return {
    jsonSchema,
    optional,
    '~standard': {version: 1, vendor: 'mini', validate},
  };
}

const issue = (message: string): StandardSchemaV1.FailureResult => ({
  issues: [{message}],
});

export const str = (): MiniSchema<string> =>
  make({type: 'string'}, (v) =>
    typeof v === 'string' ? {value: v} : issue('expected string'),
  );

export const num = (): MiniSchema<number> =>
  make({type: 'number'}, (v) =>
    typeof v === 'number' && Number.isFinite(v)
      ? {value: v}
      : issue('expected number'),
  );

export const lit = <const L extends readonly string[]>(
  ...values: L
): MiniSchema<L[number]> =>
  make({type: 'string', enum: [...values]}, (v) =>
    typeof v === 'string' && values.includes(v)
      ? {value: v as L[number]}
      : issue(`expected one of ${values.join(', ')}`),
  );

export const nul = <T>(inner: MiniSchema<T>): MiniSchema<T | null> =>
  make({...inner.jsonSchema, nullable: true}, (v) =>
    v === null
      ? {value: null}
      : (inner['~standard'].validate(v) as Result<T | null>),
  );

export const opt = <T>(
  inner: MiniSchema<T>,
): OptionalMiniSchema<T | undefined> =>
  make(
    inner.jsonSchema,
    (v) =>
      v === undefined
        ? {value: undefined}
        : (inner['~standard'].validate(v) as Result<T | undefined>),
    true,
  ) as OptionalMiniSchema<T | undefined>;

export const arr = <T>(inner: MiniSchema<T>): MiniSchema<T[]> =>
  make({type: 'array', items: inner.jsonSchema}, (v) => {
    if (!Array.isArray(v)) return issue('expected array');
    const out: T[] = [];
    for (const [i, item] of v.entries()) {
      const r = inner['~standard'].validate(item) as Result<T>;
      if (r.issues) return issue(`[${i}]: ${r.issues[0]!.message}`);
      out.push(r.value);
    }
    return {value: out};
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
      const r = field['~standard'].validate(
        (v as Record<string, unknown>)[key],
      ) as Result<unknown>;
      if (r.issues) return issue(`${key}: ${r.issues[0]!.message}`);
      out[key] = r.value;
    }
    return {value: out as ObjOut<Shape>};
  });
};

// One line wires the vendor into the catalogue — same as Zod would need.
registerSchemaEmitter('mini', (s) => (s as MiniSchema<unknown>).jsonSchema);

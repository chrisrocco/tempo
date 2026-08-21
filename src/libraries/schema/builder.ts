/**
 * @fileoverview
 * `t` — the first-party schema builder: the default authoring surface for
 * connector schemas, implemented natively on the validator port.
 *
 * ## Deliberately small, and why that is not a compromise
 *
 * Every connector schema must render to JSON Schema for the catalogue, so the
 * schema language is already capped at what JSON Schema can say. The features
 * that make general-purpose schema libraries enormous — transforms,
 * refinements over closures, branded types, coercion pipelines — cannot render
 * to a form, so excluding them is the catalogue staying honest, not a missing
 * feature. What remains is the whole language of JSON-over-RPC shapes:
 * objects, arrays, scalars, enums, literals, unions, records; `optional`,
 * `nullable`, `defaulted`; and a `description` on everything, because the
 * dashboard renders it as field help and a first-party builder can put
 * documentation first.
 *
 * A shape this vocabulary cannot express is a shape the dashboard cannot
 * render — which is the prompt to grow the vocabulary deliberately, one
 * keyword at a time, not to reach for a vendor. (If a full vendor ever earns
 * its place, it returns as an adapter on the port; the seam is kept for
 * exactly that revisit.)
 *
 * ## Semantics
 *
 * - **Tolerant by default**: `t.object` validates declared keys and strips
 *   undeclared ones, so production parsing survives additive upstream change.
 *   The certification harness's strict tier (`strict.ts`) is where unknown
 *   keys become failures — same doctrine as everywhere else.
 * - **`defaulted` is where `In ≠ Out` earns its keep**: the field is optional
 *   for callers and guaranteed present for handlers, and the port's two type
 *   parameters carry exactly that. Object defaults are cloned per use, so a
 *   shared fallback cannot be mutated through one parse into the next.
 * - **Everything is synchronous and pure** — no clock, no host state — so a
 *   schema is safe to define anywhere, including module scope of a workflow
 *   module.
 */

import type {JsonSchema} from './json_schema';
import type {Schema, SchemaIssue, SchemaResult} from './port';

/** A builder schema: the port, plus its own rendering and a presence marker. */
export interface TSchema<Out = unknown, In = Out> extends Schema<Out, In> {
  validate(value: unknown): SchemaResult<Out>;
  toJsonSchema(): JsonSchema;
  readonly jsonSchema: JsonSchema;
  /** Read by `t.object` to decide required-ness; 'required' everywhere else. */
  readonly presence: 'required' | 'optional' | 'defaulted';
}

/** An `t.optional(...)` schema: an optional key, absent meaning absent. */
export interface TOptional<Out = unknown, In = Out> extends TSchema<Out, In> {
  readonly presence: 'optional';
}

/** A `t.defaulted(...)` schema: optional for callers, present for handlers. */
export interface TDefaulted<Out = unknown, In = Out> extends TSchema<Out, In> {
  readonly presence: 'defaulted';
}

type AnyT = TSchema<never, never> | TSchema<unknown, unknown>;

export type OutOf<S> = S extends TSchema<infer Out, infer _In> ? Out : never;
export type InOf<S> = S extends TSchema<infer _Out, infer In> ? In : never;

type Shape = Record<string, TSchema<never, never> | TSchema<unknown, unknown>>;

/** Optional and defaulted keys are optional on the way in… */
type ObjIn<Sh extends Shape> = {
  [
    K in keyof Sh as Sh[K] extends {presence: 'optional' | 'defaulted'}
      ? never
      : K
  ]: InOf<Sh[K]>;
} & {
  [
    K in keyof Sh as Sh[K] extends {presence: 'optional' | 'defaulted'}
      ? K
      : never
  ]?: InOf<Sh[K]>;
};

/** …but only optional keys stay optional on the way out — defaults are filled. */
type ObjOut<Sh extends Shape> = {
  [K in keyof Sh as Sh[K] extends {presence: 'optional'} ? never : K]: OutOf<
    Sh[K]
  >;
} & {
  [K in keyof Sh as Sh[K] extends {presence: 'optional'} ? K : never]?: OutOf<
    Sh[K]
  >;
};

// The failure branch only — typed as `SchemaResult<never>` it would poison
// inference of every builder's success type (the same trap, learned twice).
const fail = (
  message: string,
): {readonly ok: false; readonly issues: readonly SchemaIssue[]} => ({
  ok: false,
  issues: [{message}],
});

function make<Out, In = Out>(
  jsonSchema: JsonSchema,
  validate: (value: unknown) => SchemaResult<Out>,
  presence: TSchema<Out, In>['presence'] = 'required',
): TSchema<Out, In> {
  return {
    jsonSchema,
    presence,
    validate,
    toJsonSchema: () => jsonSchema,
  };
}

/** Options every builder takes; `description` renders as field help text. */
interface BaseOptions {
  description?: string;
}

interface StringOptions extends BaseOptions {
  pattern?: RegExp;
  minLength?: number;
  maxLength?: number;
  /** A JSON Schema `format` hint (`'date-time'`, `'email'`) — rendered, not validated. */
  format?: string;
}

interface NumberOptions extends BaseOptions {
  min?: number;
  max?: number;
}

function baseKeywords(type: string | undefined, opts: BaseOptions): JsonSchema {
  const out: JsonSchema = {};
  if (type !== undefined) out.type = type;
  if (opts.description !== undefined) out.description = opts.description;
  return out;
}

function numeric(
  type: 'number' | 'integer',
  opts: NumberOptions,
): TSchema<number> {
  const json = baseKeywords(type, opts);
  if (opts.min !== undefined) json['minimum'] = opts.min;
  if (opts.max !== undefined) json['maximum'] = opts.max;
  return make(json, (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v))
      return fail(`expected ${type}`);
    if (type === 'integer' && !Number.isInteger(v))
      return fail('expected integer');
    if (opts.min !== undefined && v < opts.min)
      return fail(`expected >= ${opts.min}`);
    if (opts.max !== undefined && v > opts.max)
      return fail(`expected <= ${opts.max}`);
    return {ok: true, value: v};
  });
}

export const t = {
  string(opts: StringOptions = {}): TSchema<string> {
    const json = baseKeywords('string', opts);
    if (opts.pattern) json['pattern'] = opts.pattern.source;
    if (opts.minLength !== undefined) json['minLength'] = opts.minLength;
    if (opts.maxLength !== undefined) json['maxLength'] = opts.maxLength;
    if (opts.format !== undefined) json['format'] = opts.format;
    return make(json, (v) => {
      if (typeof v !== 'string') return fail('expected string');
      if (opts.minLength !== undefined && v.length < opts.minLength)
        return fail(`expected at least ${opts.minLength} characters`);
      if (opts.maxLength !== undefined && v.length > opts.maxLength)
        return fail(`expected at most ${opts.maxLength} characters`);
      if (opts.pattern && !opts.pattern.test(v))
        return fail(`expected to match ${opts.pattern}`);
      return {ok: true, value: v};
    });
  },

  number(opts: NumberOptions = {}): TSchema<number> {
    return numeric('number', opts);
  },

  integer(opts: NumberOptions = {}): TSchema<number> {
    return numeric('integer', opts);
  },

  boolean(opts: BaseOptions = {}): TSchema<boolean> {
    return make(baseKeywords('boolean', opts), (v) =>
      typeof v === 'boolean' ? {ok: true, value: v} : fail('expected boolean'),
    );
  },

  literal<const V extends string | number | boolean>(
    value: V,
    opts: BaseOptions = {},
  ): TSchema<V> {
    const json = baseKeywords(undefined, opts);
    json['const'] = value;
    return make(json, (v) =>
      v === value ? {ok: true, value} : fail(`expected ${String(value)}`),
    );
  },

  enum<const V extends readonly [string, ...string[]]>(
    ...values: V
  ): TSchema<V[number]> {
    return make({type: 'string', enum: [...values]}, (v) =>
      typeof v === 'string' && (values as readonly string[]).includes(v)
        ? {ok: true, value: v as V[number]}
        : fail(`expected one of ${values.join(', ')}`),
    );
  },

  array<S extends AnyT>(
    inner: S,
    opts: BaseOptions = {},
  ): TSchema<OutOf<S>[], InOf<S>[]> {
    const json = baseKeywords('array', opts);
    json['items'] = inner.jsonSchema;
    return make(json, (v) => {
      if (!Array.isArray(v)) return fail('expected array');
      const out: OutOf<S>[] = [];
      for (const [i, item] of v.entries()) {
        const r = inner.validate(item);
        if (!r.ok) return fail(`[${i}]: ${r.issues[0]!.message}`);
        out.push(r.value as OutOf<S>);
      }
      return {ok: true, value: out};
    });
  },

  /** Validates declared keys, strips undeclared ones (tolerant by default). */
  object<Sh extends Shape>(
    shape: Sh,
    opts: BaseOptions = {},
  ): TSchema<ObjOut<Sh>, ObjIn<Sh>> {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, field] of Object.entries(shape)) {
      properties[key] = field.jsonSchema;
      // `defaulted` keys are announced as optional-with-default, which is
      // exactly what a form should render; only truly mandatory keys are
      // `required` in the published schema.
      if (field.presence === 'required') required.push(key);
    }
    const json = baseKeywords('object', opts);
    json['properties'] = properties;
    json['required'] = required;
    return make(json, (v) => {
      if (typeof v !== 'object' || v === null || Array.isArray(v))
        return fail('expected object');
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape)) {
        const r = field.validate((v as Record<string, unknown>)[key]);
        if (!r.ok) return fail(`${key}: ${r.issues[0]!.message}`);
        if (r.value !== undefined || field.presence === 'required') {
          out[key] = r.value;
        }
      }
      return {ok: true, value: out as ObjOut<Sh>};
    });
  },

  record<S extends AnyT>(
    value: S,
    opts: BaseOptions = {},
  ): TSchema<Record<string, OutOf<S>>, Record<string, InOf<S>>> {
    const json = baseKeywords('object', opts);
    json['additionalProperties'] = value.jsonSchema;
    return make(json, (v) => {
      if (typeof v !== 'object' || v === null || Array.isArray(v))
        return fail('expected object');
      const out: Record<string, OutOf<S>> = {};
      for (const [key, entry] of Object.entries(v as Record<string, unknown>)) {
        if (entry === undefined) continue;
        const r = value.validate(entry);
        if (!r.ok) return fail(`${key}: ${r.issues[0]!.message}`);
        out[key] = r.value as OutOf<S>;
      }
      return {ok: true, value: out};
    });
  },

  union<Ss extends readonly [AnyT, AnyT, ...AnyT[]]>(
    ...schemas: Ss
  ): TSchema<OutOf<Ss[number]>, InOf<Ss[number]>> {
    return make({anyOf: schemas.map((s) => s.jsonSchema)}, (v) => {
      for (const s of schemas) {
        const r = s.validate(v);
        if (r.ok) return {ok: true, value: r.value as OutOf<Ss[number]>};
      }
      return fail('expected a value matching one of the union branches');
    });
  },

  nullable<S extends AnyT>(inner: S): TSchema<OutOf<S> | null, InOf<S> | null> {
    return make({...inner.jsonSchema, nullable: true}, (v) =>
      v === null
        ? {ok: true, value: null}
        : (inner.validate(v) as SchemaResult<OutOf<S> | null>),
    );
  },

  /** An optional object key: absent stays absent (contrast `defaulted`). */
  optional<S extends AnyT>(
    inner: S,
  ): TOptional<OutOf<S> | undefined, InOf<S> | undefined> {
    return {
      ...make<OutOf<S> | undefined, InOf<S> | undefined>(
        inner.jsonSchema,
        (v) =>
          v === undefined
            ? {ok: true, value: undefined}
            : (inner.validate(v) as SchemaResult<OutOf<S> | undefined>),
      ),
      presence: 'optional',
    };
  },

  /**
   * Optional for callers, guaranteed for handlers — the port's `In ≠ Out` in
   * one word. Renders as an optional field carrying its `default`.
   */
  defaulted<S extends AnyT>(
    inner: S,
    fallback: OutOf<S>,
  ): TDefaulted<OutOf<S>, InOf<S> | undefined> {
    const filled = (): SchemaResult<OutOf<S>> => ({
      ok: true,
      // Cloned so one parse cannot mutate the fallback the next one reads.
      value: (typeof fallback === 'object' && fallback !== null
        ? (JSON.parse(JSON.stringify(fallback)) as OutOf<S>)
        : fallback) as OutOf<S>,
    });
    return {
      ...make<OutOf<S>, InOf<S> | undefined>(
        {...inner.jsonSchema, default: fallback},
        (v) =>
          v === undefined
            ? filled()
            : (inner.validate(v) as SchemaResult<OutOf<S>>),
      ),
      presence: 'defaulted',
    };
  },

  /** Anything. Renders as an unconstrained schema; validates everything. */
  unknown(opts: BaseOptions = {}): TSchema<unknown> {
    return make(baseKeywords(undefined, opts), (v) => ({ok: true, value: v}));
  },
};

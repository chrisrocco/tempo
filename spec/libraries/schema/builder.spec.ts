/**
 * @fileoverview
 * `t`, the first-party builder — validation semantics, presence, and rendering.
 *
 * The load-bearing suite is the objects one: `optional` vs `defaulted` is
 * where the port's two type parameters stop being theory — a defaulted field
 * is optional for callers (`InferInput`) and guaranteed for handlers
 * (`InferOutput`), and the `@ts-expect-error` cases pin that at the type level
 * the same way the expectations pin it at runtime.
 */

import {
  t,
  type InferInput,
  type InferOutput,
} from '../../../src/libraries/schema';

const ok = <T>(result: {ok: boolean; value?: T}): T => {
  expect(result.ok).toBe(true);
  return result.value as T;
};

const firstMessage = (result: {
  ok: boolean;
  issues?: readonly {message: string}[];
}): string => {
  expect(result.ok).toBe(false);
  return result.issues?.[0]?.message ?? '';
};

describe('schema builder — scalars, enums, unions', () => {
  it('validates string constraints and says which one failed', () => {
    const key = t.string({pattern: /^[A-Z]+-\d+$/, minLength: 3});
    expect(ok(key.validate('OPS-1'))).toBe('OPS-1');
    expect(firstMessage(key.validate('x'))).toContain('at least 3');
    expect(firstMessage(key.validate('nope-1'))).toContain('match');
    expect(firstMessage(key.validate(7))).toBe('expected string');
  });

  it('holds integers to integrality and bounds', () => {
    const seq = t.integer({min: 1});
    expect(ok(seq.validate(41))).toBe(41);
    expect(firstMessage(seq.validate(1.5))).toBe('expected integer');
    expect(firstMessage(seq.validate(0))).toBe('expected >= 1');
    expect(firstMessage(seq.validate(NaN))).toBe('expected integer');
  });

  it('enums, literals, and unions accept exactly what they name', () => {
    const status = t.enum('open', 'closed');
    expect(ok(status.validate('open'))).toBe('open');
    expect(firstMessage(status.validate('ajar'))).toContain('open, closed');

    const yes = t.literal('yes');
    expect(ok(yes.validate('yes'))).toBe('yes');
    expect(firstMessage(yes.validate('no'))).toBe('expected yes');

    const id = t.union(t.string(), t.number());
    expect(ok(id.validate('a'))).toBe('a');
    expect(ok(id.validate(7))).toBe(7);
    expect(firstMessage(id.validate(true))).toContain('union');
  });

  it('records validate every value; nullable admits null and nothing else', () => {
    const counts = t.record(t.number());
    expect(ok(counts.validate({a: 1, b: 2}))).toEqual({a: 1, b: 2});
    expect(firstMessage(counts.validate({a: 'x'}))).toContain('a:');

    const maybe = t.nullable(t.string());
    expect(ok(maybe.validate(null))).toBeNull();
    expect(firstMessage(maybe.validate(7))).toBe('expected string');
  });
});

describe('schema builder — objects, presence, and In ≠ Out', () => {
  const Issue = t.object({
    key: t.string(),
    labels: t.defaulted(t.array(t.string()), []),
    assignee: t.optional(t.string()),
  });

  it('strips undeclared keys — tolerant by default, strict is the harness tier', () => {
    const parsed = ok(Issue.validate({key: 'OPS-1', debug: 'oops'}));
    expect(parsed).toEqual({key: 'OPS-1', labels: []});
  });

  it('fills defaults: optional on the way in, present on the way out', () => {
    expect(ok(Issue.validate({key: 'OPS-1'})).labels).toEqual([]);
    expect(
      ok(Issue.validate({key: 'OPS-1', labels: ['incident']})).labels,
    ).toEqual(['incident']);
  });

  it('clones object defaults per parse, so one caller cannot poison the next', () => {
    const first = ok(Issue.validate({key: 'a'}));
    first.labels.push('mutated');
    expect(ok(Issue.validate({key: 'b'})).labels).toEqual([]);
  });

  it('leaves an absent optional key absent, not undefined-valued', () => {
    const parsed = ok(Issue.validate({key: 'OPS-1'}));
    expect('assignee' in parsed).toBe(false);
  });

  it('carries In ≠ Out through the port types', () => {
    // Callers may omit defaulted and optional keys…
    const input: InferInput<typeof Issue> = {key: 'OPS-1'};
    // …handlers always see the default filled in.
    const output: InferOutput<typeof Issue> = {key: 'OPS-1', labels: []};
    // @ts-expect-error — labels is required on the way out: the default filled it.
    const missing: InferOutput<typeof Issue> = {key: 'OPS-1'};
    expect([input, output, missing].length).toBe(3);
  });
});

describe('schema builder — rendering', () => {
  it('renders objects with required derived from presence, defaults carried', () => {
    const emitted = t
      .object({
        key: t.string({description: 'The issue key.'}),
        labels: t.defaulted(t.array(t.string()), []),
        assignee: t.optional(t.string()),
      })
      .toJsonSchema();
    expect(emitted['required']).toEqual(['key']);
    const properties = emitted['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties['key']).toEqual({
      type: 'string',
      description: 'The issue key.',
    });
    expect(properties['labels']?.['default']).toEqual([]);
  });

  it('renders the whole vocabulary: pattern, enum, const, anyOf, additionalProperties', () => {
    expect(t.string({pattern: /^A/}).toJsonSchema()['pattern']).toBe('^A');
    expect(t.enum('a', 'b').toJsonSchema()['enum']).toEqual(['a', 'b']);
    expect(t.literal(7).toJsonSchema()['const']).toBe(7);
    expect(
      (t.union(t.string(), t.number()).toJsonSchema()['anyOf'] as unknown[])
        .length,
    ).toBe(2);
    expect(
      t.record(t.boolean()).toJsonSchema()['additionalProperties'],
    ).toEqual({type: 'boolean'});
    expect(t.integer().toJsonSchema().type).toBe('integer');
  });
});

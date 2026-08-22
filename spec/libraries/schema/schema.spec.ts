/**
 * @fileoverview
 * The schema library's seam pieces: the validator port run through
 * `runSchema`, over hand-built port values as well as the first-party builder
 * (`builder.ts`, covered in depth by `builder.spec.ts`). The hand-built cases
 * are the point of the port made executable: anything with a `validate`
 * method is a schema here — the builder is the default implementation, not a
 * requirement.
 */

import {runSchema, t, type Schema} from '../../../src/libraries/schema';

describe('schema — runSchema over the validator port', () => {
  const issue = t.object({key: t.string(), votes: t.number()});

  it('returns the vendor-parsed value on success', async () => {
    const result = await runSchema(issue, {key: 'OPS-1', votes: 3, extra: 1});
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The builder strips undeclared keys, and runSchema hands back
      // whatever the port produced — tolerance is the schema's decision.
      expect(result.value).toEqual({key: 'OPS-1', votes: 3});
    }
  });

  it('formats failures with the issue path, when the port provides one', async () => {
    const pathy: Schema<never> = {
      validate: () => ({
        ok: false,
        issues: [{message: 'expected string', path: ['assignee', 'id']}],
      }),
    };
    const result = await runSchema(pathy, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('assignee.id: expected string');
  });

  it('awaits a port whose validate is async — the port allows it', async () => {
    const slow: Schema<number> = {
      validate: (value) => Promise.resolve({ok: true, value: Number(value)}),
    };
    const result = await runSchema(slow, '42');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });
});

describe('schema — the port implemented natively', () => {
  it('renders through the port method, no adapter and no vendor involved', () => {
    const emitted = t.object({key: t.string()}).toJsonSchema();
    expect(emitted['properties']).toEqual({key: {type: 'string'}});
    expect(emitted['required']).toEqual(['key']);
  });
});

/**
 * @fileoverview
 * The schema library's surface: the validator port run through `runSchema`,
 * and `standard()` — the one adapter — wrapping a hand-built Standard Schema
 * vendor. The first-party builder (`builder.ts`, covered in depth by
 * `builder.spec.ts`) implements the port natively with no spec at all, which
 * is the library's claim made executable: the port is the contract, and
 * Standard Schema is one door in, not the house.
 */

import {
  runSchema,
  standard,
  t,
  type Schema,
  type StandardSchemaV1,
} from '../../../src/libraries/schema';

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

describe('schema — the standard() adapter', () => {
  /** A hand-built Standard Schema vendor, standing in for Zod/Valibot. */
  const vendorNumber: StandardSchemaV1<unknown, number> = {
    '~standard': {
      version: 1,
      vendor: 'spec',
      validate: (value) =>
        typeof value === 'number'
          ? {value}
          : {
              issues: [
                {message: 'expected number', path: [{key: 'amount'}, 0]},
              ],
            },
    },
  };

  it('adapts ~standard validation to the port', async () => {
    const port = standard(vendorNumber);
    const ok = await runSchema(port, 7);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toBe(7);
  });

  it('converts spec issue paths — PathSegment objects included — to port paths', async () => {
    const bad = await runSchema(standard(vendorNumber), 'seven');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toBe('amount.0: expected number');
  });

  it('carries the rendering the caller pairs with it, and only then', () => {
    const rendered = standard(vendorNumber, () => ({type: 'number'}));
    expect(rendered.toJsonSchema?.()).toEqual({type: 'number'});

    const unrendered = standard(vendorNumber);
    // Absence degrades: consumers read `toJsonSchema?.()` and treat undefined
    // as "unrendered", never as an error.
    expect(unrendered.toJsonSchema?.()).toBeUndefined();
  });
});

describe('schema — the port implemented natively', () => {
  it('renders through the port method, no adapter and no vendor involved', () => {
    const emitted = t.object({key: t.string()}).toJsonSchema();
    expect(emitted['properties']).toEqual({key: {type: 'string'}});
    expect(emitted['required']).toEqual(['key']);
  });
});

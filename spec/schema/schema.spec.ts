/**
 * @fileoverview
 * The schema library's own surface: `runSchema` over any Standard Schema, and
 * the per-vendor JSON Schema emitter registry. Exercised through the `mini`
 * reference vendor (`spec/support/mini_schema.ts`) — a deliberately non-Zod
 * implementation, because the library's claim is that no vendor is special.
 */

import {emitJsonSchema, runSchema} from '../../src/schema';
import type {StandardSchemaV1} from '../../src/schema';
import {num, obj, str} from '../support/mini_schema';

describe('schema — runSchema over any Standard Schema', () => {
  const issue = obj({key: str(), votes: num()});

  it('returns the vendor-parsed value on success', async () => {
    const result = await runSchema(issue, {key: 'OPS-1', votes: 3, extra: 1});
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The mini vendor strips undeclared keys, and runSchema hands back
      // whatever the vendor produced — tolerance is the vendor's decision.
      expect(result.value).toEqual({key: 'OPS-1', votes: 3});
    }
  });

  it('formats failures with the issue path, when the vendor provides one', async () => {
    const pathy: StandardSchemaV1<never> = {
      '~standard': {
        version: 1,
        vendor: 'spec',
        validate: () => ({
          issues: [{message: 'expected string', path: ['assignee', 'id']}],
        }),
      },
    };
    const result = await runSchema(pathy, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('assignee.id: expected string');
  });

  it('awaits a vendor whose validate is async — the spec allows it', async () => {
    const slow: StandardSchemaV1<unknown, number> = {
      '~standard': {
        version: 1,
        vendor: 'spec',
        validate: (value) => Promise.resolve({value: Number(value)}),
      },
    };
    const result = await runSchema(slow, '42');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });
});

describe('schema — the vendor emitter registry', () => {
  it('emits JSON Schema through the vendor registered for the schema', () => {
    const emitted = emitJsonSchema(obj({key: str()}));
    expect(emitted?.['properties']).toEqual({key: {type: 'string'}});
    expect(emitted?.['required']).toEqual(['key']);
  });

  it('returns undefined for a vendor nobody registered — unrendered, not an error', () => {
    const foreign: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'nobody-registered-this',
        validate: (value) => ({value}),
      },
    };
    expect(emitJsonSchema(foreign)).toBeUndefined();
  });
});

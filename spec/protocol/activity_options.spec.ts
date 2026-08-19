/**
 * @fileoverview
 * The author-shape → wire-shape crossing for activity options. Small on purpose:
 * the duration grammar itself is proven in duration.spec.ts, so what is proven
 * here is the field mapping and the refuse-a-contradiction rule.
 */

import {normalizeActivityOptions} from '../../src/protocol';

describe('normalizeActivityOptions', () => {
  it('passes wire-shape options through unchanged', () => {
    expect(
      normalizeActivityOptions({
        retry: {maximumAttempts: 3, initialIntervalMs: 2_000},
        startToCloseTimeoutMs: 300_000,
        taskQueue: 'gpu',
      }),
    ).toEqual({
      retry: {maximumAttempts: 3, initialIntervalMs: 2_000},
      startToCloseTimeoutMs: 300_000,
      taskQueue: 'gpu',
    });
  });

  it('turns duration spellings into the wire’s millisecond fields', () => {
    expect(
      normalizeActivityOptions({
        retry: {
          maximumAttempts: 5,
          initialInterval: '2s',
          maximumInterval: '1 minute',
        },
        startToCloseTimeout: '5 minutes',
        heartbeatTimeout: '30s',
      }),
    ).toEqual({
      retry: {
        maximumAttempts: 5,
        initialIntervalMs: 2_000,
        maximumIntervalMs: 60_000,
      },
      startToCloseTimeoutMs: 300_000,
      heartbeatTimeoutMs: 30_000,
    });
  });

  it('refuses both spellings of one field rather than tie-breaking', () => {
    expect(() =>
      normalizeActivityOptions({
        startToCloseTimeout: '5 minutes',
        startToCloseTimeoutMs: 60_000,
      }),
    ).toThrowError(/startToCloseTimeout or startToCloseTimeoutMs, not both/);
  });

  it('emits no field the author did not set', () => {
    // `{}` and `{startToCloseTimeoutMs: undefined}` must come out identical —
    // downstream comparisons and serializations should never see a difference.
    expect(normalizeActivityOptions({})).toEqual({});
    expect(
      Object.keys(normalizeActivityOptions({retry: {maximumAttempts: 2}})),
    ).toEqual(['retry']);
  });
});

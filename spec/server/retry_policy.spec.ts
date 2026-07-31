/**
 * @fileoverview
 * Unit test for the retry policy: the pure decisions the server makes when an
 * activity fails. Exercised end-to-end (via proxyActivities) in the integration
 * suite; here we pin the arithmetic directly.
 */

import {
  maxAttempts,
  shouldRetry,
  backoffMs,
} from '../../src/server/retry_policy';

describe('retry_policy', () => {
  it('defaults to a single attempt when no policy is given', () => {
    expect(maxAttempts()).toBe(1);
    expect(maxAttempts({})).toBe(1);
    expect(shouldRetry(undefined, 1)).toBe(false);
  });

  it('retries up to maximumAttempts', () => {
    const retry = { maximumAttempts: 3 };
    expect(shouldRetry(retry, 1)).toBe(true);
    expect(shouldRetry(retry, 2)).toBe(true);
    expect(shouldRetry(retry, 3)).toBe(false);
  });

  it('treats a non-positive maximumAttempts as one attempt', () => {
    expect(maxAttempts({ maximumAttempts: 0 })).toBe(1);
    expect(maxAttempts({ maximumAttempts: -5 })).toBe(1);
  });

  it('has no backoff without a policy', () => {
    expect(backoffMs(undefined, 1)).toBe(0);
  });

  it('grows the interval exponentially, capped at maximumIntervalMs', () => {
    const retry = {
      maximumAttempts: 5,
      initialIntervalMs: 100,
      backoffCoefficient: 2,
      maximumIntervalMs: 350,
    };
    expect(backoffMs(retry, 1)).toBe(100); // 100 * 2^0
    expect(backoffMs(retry, 2)).toBe(200); // 100 * 2^1
    expect(backoffMs(retry, 3)).toBe(350); // 100 * 2^2 = 400, capped to 350
  });
});

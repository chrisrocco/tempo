// Retry decisions, read off the activity's `RetryPolicy`. Pure functions: given
// how many attempts have already been made, decide whether to try again and how
// long to wait first. The server (activity dispatch) owns this; the core never
// sees it. Extracted from `server_core` so the policy is unit-testable on its own.
import type { RetryPolicy } from '../protocol';

/** Total attempts to make. Defaults to 1 (no retry) when unset — see ActivityOptions. */
export function maxAttempts(retry?: RetryPolicy): number {
  const m = retry?.maximumAttempts;
  return m && m > 0 ? m : 1;
}

/** Given `attemptsMade` (>= 1) that all failed, should another attempt run? */
export function shouldRetry(retry: RetryPolicy | undefined, attemptsMade: number): boolean {
  return attemptsMade < maxAttempts(retry);
}

/** Backoff delay before the attempt that follows `attemptsMade` failures. */
export function backoffMs(retry: RetryPolicy | undefined, attemptsMade: number): number {
  if (!retry) return 0;
  const initial = retry.initialIntervalMs ?? 0;
  const coefficient = retry.backoffCoefficient ?? 2;
  const cap = retry.maximumIntervalMs ?? Number.POSITIVE_INFINITY;
  const raw = initial * coefficient ** (attemptsMade - 1);
  return Math.min(raw, cap);
}

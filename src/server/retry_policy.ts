/**
 * @fileoverview
 * When to try again, and how long to wait first — pure functions, unit-testable
 * away from the dispatch code that calls them. The server owns these decisions;
 * the core never sees them.
 *
 * Two kinds of retry live here, and they differ in whether giving up is an
 * option. An **activity** retries against the author's `RetryPolicy` and is
 * failed when attempts run out: it is I/O the server dispatched, and the workflow
 * can handle the failure. A **workflow task** never runs out. A task failure is
 * almost always a code bug, and workflow code is redeployable — retrying forever
 * with backoff keeps the execution alive until someone fixes it, where giving up
 * would destroy recoverable work. Hence a backoff schedule with no attempt limit
 * (see `server_core.failWorkflowTask`, which owns the policy).
 */

import type {RetryPolicy} from '../protocol';

/** First delay after a workflow task fails; doubles from there. */
const WORKFLOW_TASK_INITIAL_BACKOFF_MS = 100;
/** Ceiling on workflow-task backoff — a fixed retry cadence, not a giving-up point. */
const WORKFLOW_TASK_MAX_BACKOFF_MS = 30_000;

/** Total attempts to make. Defaults to 1 (no retry) when unset — see ActivityOptions. */
export function maxAttempts(retry?: RetryPolicy): number {
  const m = retry?.maximumAttempts;
  return m && m > 0 ? m : 1;
}

/** Given `attemptsMade` (>= 1) that all failed, should another attempt run? */
export function shouldRetry(
  retry: RetryPolicy | undefined,
  attemptsMade: number,
): boolean {
  return attemptsMade < maxAttempts(retry);
}

/**
 * How long to wait before redelivering a workflow task that has now failed
 * `failures` times. Exponential and capped; never returns "stop", because there
 * is no attempt limit on a workflow task by design.
 */
export function workflowTaskBackoffMs(failures: number): number {
  if (failures < 1) return 0;
  const raw = WORKFLOW_TASK_INITIAL_BACKOFF_MS * 2 ** (failures - 1);
  return Math.min(raw, WORKFLOW_TASK_MAX_BACKOFF_MS);
}

/** Backoff delay before the attempt that follows `attemptsMade` failures. */
export function backoffMs(
  retry: RetryPolicy | undefined,
  attemptsMade: number,
): number {
  if (!retry) return 0;
  const initial = retry.initialIntervalMs ?? 0;
  const coefficient = retry.backoffCoefficient ?? 2;
  const cap = retry.maximumIntervalMs ?? Number.POSITIVE_INFINITY;
  const raw = initial * coefficient ** (attemptsMade - 1);
  return Math.min(raw, cap);
}

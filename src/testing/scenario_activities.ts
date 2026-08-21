/**
 * @fileoverview
 * The activity implementations the scenario workflows call. Ordinary functions
 * that touch nothing: the point of a scenario is the *state the engine ends up
 * in*, not the work, so an activity here either returns immediately or throws
 * immediately.
 *
 * ## Why every name is prefixed
 *
 * `proxyActivities` registers what it types, into a registry that is global to
 * the process (`src/activity_registry.ts`). A consumer running `startScenario`
 * inside their own test process therefore gets these registrations too, and a
 * bare `fail` would collide with theirs — silently, and in whichever direction
 * module evaluation happened to run.
 *
 * `scenario_` is not a naming style, it is the collision avoidance. Renaming one
 * of these to something a consumer might plausibly also call an activity is how
 * this breaks.
 */

/** Returns its argument unchanged, so a completed execution has a visible result. */
export function scenario_succeed(value: unknown): unknown {
  return value;
}

/**
 * Throws every time.
 *
 * Used by two scenarios that want opposite things from it — `settled-mixed`
 * wants the execution to *finish* as failed, `retrying` wants it to stay running
 * with attempts climbing — and the difference is entirely in the retry policy the
 * caller proxies it with, not in anything here.
 */
export function scenario_fail(): never {
  throw new Error('this activity always fails, on purpose');
}

// ── the bug-fix agent's tools ────────────────────────────────────────────
// Fixtures with a story: each returns something a dashboard reader can follow
// as a narrative, because the scenario they serve exists to be *read*. Still
// instant, still touching nothing — see the fileoverview.

export function scenario_fetch_bug(bugId: string): {
  bugId: string;
  title: string;
  area: string;
} {
  return {
    bugId,
    title: 'Checkout double-charges when a payment retry races the webhook',
    area: 'payments/charge.ts',
  };
}

export function scenario_gather_context(source: string): string {
  return `notes from ${source}`;
}

/**
 * Fails its first call per execution, then succeeds — the fixture behind the
 * `activityFailed` + `activityRetryScheduled` + second `activityStarted` run
 * of events in the agent's history.
 *
 * Attempt counting is host-side module state because an activity has no view
 * of its own attempt number (`activity.ts` exports `heartbeat` and nothing
 * else). Keyed by the bug id, so concurrent agents don't share a fuse — but a
 * *second seed of the same id in one process* finds the fuse already blown and
 * succeeds first try. The scenario spec runs one harness, where this cannot
 * bite; a consumer reseeding in-process just gets a history without the retry
 * round.
 */
const searchAttempts = new Map<string, number>();
export function scenario_search_code(key: string): string {
  const attempt = (searchAttempts.get(key) ?? 0) + 1;
  searchAttempts.set(key, attempt);
  if (attempt === 1)
    throw new Error('code search index timed out — transient, on purpose');
  return 'stack trace points at the retry branch of charge()';
}

/**
 * Terminally down, so the agent that calls it (with no retries) shows a real
 * `activityFailed` it catches and proceeds past — a retried-then-successful
 * activity never writes one, because `activityFailed` is a completion, not an
 * attempt report.
 */
export function scenario_auto_repro(): never {
  throw new Error('repro bot has no capacity today');
}

export function scenario_test_hypothesis(input: {
  round: number;
  hypothesis: string;
  confirmed: boolean;
}): {hypothesis: string; confirmed: boolean; evidence: string} {
  return {
    hypothesis: input.hypothesis,
    confirmed: input.confirmed,
    evidence: input.confirmed
      ? 'reproduced in the harness: two charges, one order'
      : 'could not reproduce under this hypothesis',
  };
}

export function scenario_draft_fix(hypothesis: string): string {
  return `PR #4021 — guard the retry branch (${hypothesis})`;
}

export function scenario_resolve_comment(comment: unknown): string {
  return `resolved: ${String(comment)}`;
}

export function scenario_land_fix(pr: string): string {
  return `${pr} merged to main`;
}

export function scenario_set_ramp(pct: number): number {
  return pct;
}

export function scenario_cleanup(): string {
  return 'feature flag removed, branch deleted';
}

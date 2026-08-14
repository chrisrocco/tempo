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

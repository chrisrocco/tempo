/**
 * @fileoverview
 * Activity implementations register HERE and nowhere else — the activity worker
 * is the one tier that runs them. A plain name -> function map for now.
 */

/**
 * A registered activity. As with `WorkflowFn`, the `any[]` rest parameter is
 * required rather than lax: under `strictFunctionTypes` a concretely typed
 * activity is not assignable to `(...args: unknown[]) => …`, so a registry keyed
 * on that would accept nothing anyone actually writes.
 */
export type ActivityFn = (...args: any[]) => unknown | Promise<unknown>;

export type ActivityRegistry = Map<string, ActivityFn>;

export function createActivityRegistry(): ActivityRegistry {
  return new Map<string, ActivityFn>();
}

/**
 * @fileoverview
 * Activity implementations register HERE and nowhere else — the activity worker
 * is the one tier that runs them. A plain name -> function map for now.
 */

export type ActivityFn = (...args: any[]) => unknown | Promise<unknown>;

export type ActivityRegistry = Map<string, ActivityFn>;

export const createActivityRegistry = (): ActivityRegistry =>
  new Map<string, ActivityFn>();

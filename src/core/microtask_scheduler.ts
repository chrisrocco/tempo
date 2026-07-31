/**
 * @fileoverview
 * The one host-coupled yield in the deterministic core: `drainMicrotasks` lets
 * the workflow's own promise chains settle between history events.
 * `setImmediate` is a macrotask boundary that reliably flushes the microtask
 * queue.
 *
 * Why this is the acceptable exception to "the core has no host coupling": the
 * determinism rule forbids the core from reading anything that could differ
 * between the original run and a replay — the clock, randomness, I/O, shared
 * mutable state. Yielding to the host scheduler reads *nothing*. It only lets
 * promise callbacks that are already queued run to completion, and the order
 * they run in is fixed by the workflow's own code. Two replays of the same
 * history therefore drain to the same place. The coupling is to the host's
 * *scheduler*, not to any host-observable value, so replay stays reproducible.
 */

export function drainMicrotasks(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/**
 * @fileoverview
 * The one host-coupled yield in the deterministic core: `drainMicrotasks` lets
 * the workflow's own promise chains settle between history events. `setImmediate`
 * is a macrotask boundary that reliably flushes the microtask queue; the caveat
 * (why this is the acceptable exception to "no host coupling") lives in docs/concepts/replay-and-execution.md.
 */

export const drainMicrotasks = (): Promise<void> =>
  new Promise((r) => setImmediate(r));

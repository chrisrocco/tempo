/**
 * `hostname`, for a browser.
 *
 * The engine uses it once, in `worker/worker_loops.ts`, to build a worker's
 * default identity as `${pid}@${hostname}` — a string an operator reads in the
 * fleet view to go find the process. In a sandbox the process is the tab, so
 * the honest answer is to say so.
 */
export function hostname(): string {
  return 'browser';
}

export default {hostname};

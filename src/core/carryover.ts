/**
 * @fileoverview
 * State a workflow keeps across its own runs, reachable from anywhere in
 * workflow code without appearing in the workflow's signature.
 *
 * It exists for **helpers**. A poller needs a cursor — "the last item I saw" —
 * and that cursor has to survive continue-as-new, which resets history. The only
 * thing that survives a rollover today is the arguments, so a helper wanting
 * durable state has to make the caller carry it: `pollForever` would take a
 * cursor parameter, the user's workflow would take one too, and an
 * implementation detail of the helper would end up in the signature of every
 * workflow that used it. This is the same ambient context `sleep` and
 * `startChild` already reach through, used for the same reason.
 *
 * ## What belongs here
 *
 * Things that are **O(1)**: a cursor, a page token, a watermark, a small
 * counter. Carryover is written on every workflow task and copied into every new
 * run, so its size is paid continuously.
 *
 * What does not belong here is the tempting one: a set of every item ever
 * processed. That grows without bound, and the growth is invisible until a
 * long-lived workflow has a record measured in megabytes. Deduplication is
 * already solved elsewhere and better — an explicit child `workflowId` is a
 * claim the server correlates, so a repeated item starts no second child (see
 * `server_core`, `child.reused`). `MAX_CARRYOVER_BYTES` exists to make the abuse
 * fail loudly and early rather than degrade quietly.
 *
 * ## Determinism
 *
 * Reading and writing carryover is not a new source of nondeterminism. The value
 * a task starts from is durable — it comes in on the task — and the writes are
 * ordinary workflow code, replayed in the same order on every replay. Two
 * replays of the same history therefore end with the same carryover, which is
 * the property that lets it be reported and stored at the end of every task.
 */

import {getContext} from './context';

/**
 * Read a carryover value. `undefined` when nothing has written that key — a
 * fresh execution starts empty.
 *
 * The type parameter is an assertion, not a check: this value round-tripped
 * through storage and, in distributed mode, through JSON.
 */
export function getCarryover<T = unknown>(key: string): T | undefined {
  return getContext().carryover[key] as T | undefined;
}

/**
 * Write a carryover value. Visible to the rest of this task immediately, durable
 * once the task completes, and carried into the next run on continue-as-new.
 *
 * Values must survive JSON — they cross an RPC boundary and are persisted.
 *
 * **Suppressed during replay**, exactly like the commands next door. Every task
 * re-runs the workflow from its first line, so a write that applied on each pass
 * would apply once per *task* rather than once per point in the program: a
 * `setCarryover('n', getCarryover('n') + 1)` at the top of a workflow would count
 * tasks, and the total would depend on how the execution happened to be
 * scheduled rather than on its history. Suppressing replayed writes makes a write
 * happen once, where it appears, which is what the author wrote.
 */
export function setCarryover(key: string, value: unknown): void {
  const ctx = getContext();
  if (!ctx.isLive) return; // already applied and stored on the task that ran it
  ctx.carryover[key] = value;
}

/** Drop a key, so it is neither stored nor carried into the next run. */
export function clearCarryover(key: string): void {
  const ctx = getContext();
  if (!ctx.isLive) return;
  delete ctx.carryover[key];
}

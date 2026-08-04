/**
 * @fileoverview
 * State a workflow keeps across its own runs, reachable from anywhere in
 * workflow code without appearing in the workflow's signature.
 *
 * It exists for **helpers**. A poller needs a cursor — "the last item I saw" —
 * and that cursor has to survive continue-as-new, which resets history. The only
 * thing that survives a rollover otherwise is the arguments, so a helper wanting
 * durable state has to make the caller carry it: `pollForever` would take a
 * cursor parameter, the user's workflow would take one too, and an
 * implementation detail of the helper would end up in the signature of every
 * workflow that used it. This is the same ambient context `sleep` and
 * `startChild` already reach through, used for the same reason.
 *
 * ## Reads are per *run*, not per task
 *
 * `getCarryover` returns what the **run** started with, and it returns the same
 * thing for the whole run no matter how many tasks that takes. A write is for
 * the *next* run; it does not change what a later read in this run sees.
 *
 * That is the only shape that can be branched on safely, and the reason is
 * replay. Every workflow task re-runs the workflow from its first line. If a
 * read could return a value written by an earlier task, then the commands this
 * task issues — which activity arguments, how many children — would depend on
 * state that is not in history, and the replay would diverge from what history
 * records. The failure is not subtle when it happens (`nondeterminism at seq N`,
 * and the execution wedges) but it is very subtle to reason about beforehand, so
 * the API makes it unrepresentable instead.
 *
 * The practical rule: **a run reads the cursor it inherited, and leaves a new one
 * for its successor.** A helper that wants its write to take effect promptly
 * should continue as new — which a poller wants to do anyway, since adopting a
 * new cursor is exactly when its history stops being worth keeping.
 *
 * ## What belongs here
 *
 * Things that are **O(1)**: a cursor, a page token, a watermark, a small
 * counter. Carryover is copied into every new run, so its size is paid
 * repeatedly.
 *
 * What does not belong here is the tempting one: a set of every item ever
 * processed. That grows without bound, and the growth is invisible until a
 * long-lived workflow has a record measured in megabytes. Deduplication is
 * already solved elsewhere and better — an explicit child `workflowId` is a
 * claim the server correlates, so a repeated item starts no second child (see
 * `server_core`, `child.reused`). `MAX_CARRYOVER_BYTES` exists to make the abuse
 * fail loudly and early rather than degrade quietly.
 */

import {getContext} from './context';

/**
 * Read what this run started with. `undefined` when nothing has written that key
 * — a fresh execution starts empty.
 *
 * Constant for the whole run: a `setCarryover` earlier in this run does not
 * change what this returns. See the note on replay above.
 *
 * The type parameter is an assertion, not a check: this value round-tripped
 * through storage and, in distributed mode, through JSON.
 */
export function getCarryover<T = unknown>(key: string): T | undefined {
  return getContext().carryover[key] as T | undefined;
}

/**
 * Set what the *next* run starts with. Takes effect at the next
 * continue-as-new; `getCarryover` in this run keeps returning the inherited
 * value.
 *
 * Not suppressed during replay, and it does not need to be: the write is a
 * function of the run's seed and its history, so every replay of the same
 * history recomputes the same value.
 *
 * Values must survive JSON — they cross an RPC boundary and are persisted.
 */
export function setCarryover(key: string, value: unknown): void {
  getContext().carryoverNext[key] = value;
}

/** Drop a key, so the next run does not inherit it. */
export function clearCarryover(key: string): void {
  delete getContext().carryoverNext[key];
}

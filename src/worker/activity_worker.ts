/**
 * @fileoverview
 * Stateless activity worker: run the registered activity function and report
 * result or failure. This is the ONLY place I/O happens in the system. Locally
 * the server invokes it directly; in the distributed form `worker/worker_loops`
 * polls a leased task, calls it once, and reports the outcome.
 *
 * The server cannot reach into a running attempt — it can only decide when to
 * stop waiting. What it decides on is the author's choice, and the three
 * settings answer genuinely different questions:
 *
 * - **Nothing set (the default).** The lease expires on elapsed time alone and
 *   the task is redelivered, so an activity slower than `ACTIVITY_LEASE_MS` runs
 *   *concurrently* with the attempt already in flight, once per lease period
 *   until one finishes. Only the first completion reaches history
 *   (`server_core.reportActivityResult` drops the rest), but every side effect
 *   really happens. This is the at-least-once contract in
 *   `server/ports/task_queue` at its sharpest.
 * - **`startToCloseTimeoutMs`.** At the deadline the server fails the attempt and
 *   takes the task out of the queue, so no second worker picks it up. Right when
 *   there is a duration past which the work is not worth waiting for.
 * - **`heartbeatTimeoutMs` + `heartbeat()`.** The attempt says it is still
 *   working; each beat renews the lease and resets the deadline. Right for work
 *   whose duration is genuinely unbounded — an agent that may think for ten
 *   minutes — because it decouples "how long this takes" from "is anyone still
 *   doing it". A dead worker is then caught in one heartbeat interval rather
 *   than one lease.
 *
 * Under all three, an abandoned worker may still be running and may still
 * report; that late completion is dropped, because the seq already carries a
 * terminal event. And idempotent effects remain the author's responsibility — a
 * deadline bounds what the *engine* does, not what the activity already did.
 */

import type {ActivityResult, ActivityTask} from '../protocol';
import {withActivityContext} from './activity_context';
import type {ActivityRegistry} from './activity_registry';

export interface ActivityWorker {
  /**
   * Run one attempt. `sendHeartbeat` is how `heartbeat()` inside the activity
   * reaches the server; omit it and heartbeats are silently discarded, which is
   * what a direct unit-test call wants.
   */
  runTask(
    task: ActivityTask,
    sendHeartbeat?: (checkpoint?: unknown) => void,
  ): Promise<ActivityResult>;
}

export function createActivityWorker(
  registry: ActivityRegistry,
): ActivityWorker {
  return {
    async runTask(
      task: ActivityTask,
      sendHeartbeat: (checkpoint?: unknown) => void = () => {},
    ): Promise<ActivityResult> {
      const fn = registry.get(task.name);
      if (!fn) return {ok: false, error: `no activity ${task.name}`};
      return withActivityContext(
        sendHeartbeat,
        task.options.heartbeatTimeoutMs,
        async () => {
          try {
            return {ok: true, result: await fn(...task.args)};
          } catch (e) {
            // This is the only place in the system holding the thrown Error, so
            // it is the only place the stack can be taken from. Everything
            // downstream sees strings. A thrown non-Error has no message field —
            // reading one anyway recorded the literal text "undefined" — so it
            // is coerced whole: `throw 'a bare string'` fails as 'a bare string'.
            return {
              ok: false,
              error: e instanceof Error ? e.message : String(e),
              stack: e instanceof Error ? e.stack : undefined,
            };
          }
        },
      );
    },
  };
}

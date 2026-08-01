/**
 * @fileoverview
 * Stateless activity worker: run the registered activity function and report
 * result or failure. This is the ONLY place I/O happens in the system. Locally
 * the server invokes it directly; in the distributed form `worker/worker_loops`
 * polls a leased task, calls it once, and reports the outcome.
 *
 * **There is still no heartbeat**, so the server cannot tell a crashed worker
 * from a slow one, and cannot reach into an attempt that is still running. What
 * it can do is decide when to stop waiting, and that decision is now the author's
 * to make:
 *
 * - **`startToCloseTimeoutMs` unset (the default).** The lease expires on elapsed
 *   time alone and the task is redelivered, so an activity slower than
 *   `ACTIVITY_LEASE_MS` runs *concurrently* with the attempt already in flight,
 *   once per lease period until one finishes. Only the first completion reaches
 *   history (`server_core.reportActivityResult` drops the rest), but every side
 *   effect really happens. This is the at-least-once contract in
 *   `server/ports/task_queue` at its sharpest.
 * - **`startToCloseTimeoutMs` set.** At the deadline the server fails the attempt
 *   and takes the task out of the queue, so no second worker picks it up. The
 *   abandoned worker may still be running and may still report; that late
 *   completion is dropped, because the seq already carries a terminal event.
 *
 * Either way, idempotent effects remain the author's responsibility — a timeout
 * bounds what the *engine* does, not what the activity already did. Heartbeats
 * (which would let a long, honest attempt keep its claim) are still unbuilt; see
 * ROADMAP Phase 6.
 */

import type { ActivityResult, ActivityTask } from '../protocol';
import type { ActivityRegistry } from './activity_registry';

export interface ActivityWorker {
  runTask(task: ActivityTask): Promise<ActivityResult>;
}

export function createActivityWorker(
  registry: ActivityRegistry,
): ActivityWorker {
  return {
    async runTask(task: ActivityTask): Promise<ActivityResult> {
      const fn = registry.get(task.name);
      if (!fn) return { ok: false, error: `no activity ${task.name}` };
      try {
        return { ok: true, result: await fn(...task.args) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  };
}

/**
 * @fileoverview
 * Stateless activity worker: run the registered activity function and report
 * result or failure. This is the ONLY place I/O happens in the system. Locally
 * the server invokes it directly; in the distributed form `worker/worker_loops`
 * polls a leased task, calls it once, and reports the outcome.
 *
 * **There is no heartbeat, and no start-to-close timeout.** A lease expires on
 * elapsed time alone, so the queue cannot tell a crashed worker from a slow one:
 * an activity still running when its lease expires is redelivered and runs
 * *concurrently* with the attempt already in flight, once per lease period until
 * one of them finishes. Only the first completion reaches history (the server
 * drops the rest — see `server/server_core.reportActivityResult`), but the side
 * effects all really happen, which is the sharp edge behind the at-least-once
 * contract in `server/ports/task_queue`.
 *
 * Two consequences worth designing around: keep an activity's runtime well under
 * `ACTIVITY_LEASE_MS` (a single global on the server — there is no per-activity
 * lease), and make its effects idempotent. Heartbeats and per-activity timeouts
 * are the planned fix (ROADMAP, "finishing distribution"); `ActivityOptions`
 * reserves the names but implements neither.
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

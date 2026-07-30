/**
 * @fileoverview
 * Stateless activity worker: run the registered activity function and report
 * result or failure. This is the ONLY place I/O happens in the system. In the
 * distributed form it polls the task queue with a lease and heartbeats long runs
 * (Phase 5); here it is invoked directly by the server.
 */

import type { ActivityResult, ActivityTask } from '../protocol';
import type { ActivityRegistry } from './activity_registry';

export interface ActivityWorker {
  runTask(task: ActivityTask): Promise<ActivityResult>;
}

export function createActivityWorker(registry: ActivityRegistry): ActivityWorker {
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

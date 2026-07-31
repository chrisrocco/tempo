/**
 * @fileoverview
 * Stateless workflow worker: build a context from the supplied history, `replay`
 * the registered workflow function (this is where `core` runs), and return the
 * commands + terminal state. Workflow *types* register HERE.
 *
 * Everything the worker needs arrives in the task, so it holds no state between
 * tasks and any worker can serve any execution. That is what makes workers
 * horizontally scalable and their crashes survivable — a lost worker costs
 * latency, not correctness, because the state rebuilds from history.
 *
 * ## Cold path today; the warm path is the planned optimization
 *
 * Today every task is a **cold replay**: the worker has nothing in memory, so it
 * reconstructs "where were we" by running the workflow from line one and
 * re-feeding every recorded event in order before applying the new ones.
 *
 * The **sticky cache** (a Phase-5 optimization, not built) would keep the
 * suspended execution live on the worker between tasks, so the common case
 * applies only the new events to that live state and resumes from where it
 * stopped, with nothing replayed. Cold replay stays the fallback on a miss —
 * crash, eviction, redeploy, or a different worker picking up the task — which is
 * why every suspension point must remain reconstructible identically from
 * history whether or not the cache lands.
 */

import { createContext, replay, type WorkflowFn } from '../core';
import type { HistoryEvent, WorkflowTaskResult } from '../protocol';

export type WorkflowRegistry = Map<string, WorkflowFn>;

export interface WorkflowWorker {
  has(name: string): boolean;
  replayTask(
    name: string,
    args: unknown[],
    history: HistoryEvent[],
    continueAsNewSuggested: boolean,
  ): Promise<WorkflowTaskResult>;
}

export function createWorkflowRegistry(): WorkflowRegistry {
  return new Map<string, WorkflowFn>();
}

export function createWorkflowWorker(
  registry: WorkflowRegistry,
): WorkflowWorker {
  return {
    has(name: string): boolean {
      return registry.has(name);
    },
    async replayTask(
      name: string,
      args: unknown[],
      history: HistoryEvent[],
      continueAsNewSuggested: boolean,
    ): Promise<WorkflowTaskResult> {
      const fn = registry.get(name);
      // Report this as a failed task rather than throwing. A throw escapes to the
      // poll loop, which cannot complete the task, so the lease expires and the
      // task redelivers — forever, while the client waits on an execution that
      // never settles. Failing the execution is both terminal and diagnosable,
      // and mirrors how a missing *activity* is reported (activity_worker).
      if (!fn)
        return {
          done: false,
          result: undefined,
          failed: true,
          failure: new Error(`no workflow registered as ${name}`),
          commands: [],
        };
      const ctx = createContext(args, history, continueAsNewSuggested);
      await replay(ctx, fn);
      return {
        done: ctx.done,
        result: ctx.result,
        failed: ctx.failed,
        failure: ctx.failure,
        commands: ctx.commands,
      };
    },
  };
}

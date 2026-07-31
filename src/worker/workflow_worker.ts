/**
 * @fileoverview
 * Stateless workflow worker: build a context from the supplied history, `replay`
 * the registered workflow function (this is where `core` runs), and return the
 * commands + terminal state. Workflow *types* register HERE. The sticky cache of
 * warm executions is a Phase-5 optimization; today every task is a cold replay.
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

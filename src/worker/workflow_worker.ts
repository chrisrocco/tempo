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

export const createWorkflowRegistry = (): WorkflowRegistry => new Map<string, WorkflowFn>();

export function createWorkflowWorker(registry: WorkflowRegistry): WorkflowWorker {
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
      if (!fn) throw new Error(`no workflow registered as ${name}`);
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

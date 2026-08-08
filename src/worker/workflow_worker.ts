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

import {
  createContext,
  parkedConditions,
  replay,
  type WorkflowFn,
} from '../core';
import {
  MAX_CARRYOVER_BYTES,
  type Carryover,
  type HistoryEvent,
  type WorkflowTaskResult,
} from '../protocol';

export type WorkflowRegistry = Map<string, WorkflowFn>;

/**
 * Refuse a task whose carryover has outgrown the cap.
 *
 * Thrown rather than truncated, and thrown *here* rather than at the server: the
 * worker is where the offending code just ran, so this surfaces on the first
 * task that crosses the line, naming the biggest key. It becomes a workflow-task
 * failure, which is retried rather than fatal — so shipping a fix and rolling the
 * workers recovers the execution, and nothing durable has been written yet.
 */
function assertCarryoverFits(name: string, carryover: Carryover): void {
  const size = JSON.stringify(carryover).length;
  if (size <= MAX_CARRYOVER_BYTES) return;
  const biggest = Object.entries(carryover)
    .map(([key, value]) => ({key, size: JSON.stringify(value).length}))
    .sort((a, b) => b.size - a.size)[0];
  throw new Error(
    `workflow "${name}" carryover is ${size} bytes, over the ${MAX_CARRYOVER_BYTES} limit ` +
      `(largest key "${biggest?.key}" at ${biggest?.size}). Carryover is written on every ` +
      `task and copied into every run, so it must stay small — keep a cursor, not a ` +
      `collection. To avoid acting on an item twice, give its child an explicit workflowId.`,
  );
}

export interface WorkflowWorker {
  has(name: string): boolean;
  replayTask(
    name: string,
    args: unknown[],
    history: HistoryEvent[],
    continueAsNewSuggested: boolean,
    /**
     * Required, not optional-with-a-default: a default here type-checks at every
     * call site that forgets it and silently starts the workflow from empty
     * state, which is indistinguishable from a workflow that never wrote any.
     * Both in-tree callers were written that way before this was tightened.
     */
    carryover: Carryover,
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
      carryover: Carryover,
    ): Promise<WorkflowTaskResult> {
      const fn = registry.get(name);
      // Throw, so the poll loop reports this through `failWorkflowTask` and the
      // execution keeps running.
      //
      // This used to fail the *execution* instead, and that was right when it was
      // written: a throw escaped the loop, the task was never acked, and the
      // lease redelivered it forever while the client waited on something that
      // would never settle. Both premises have since changed. A task failure is
      // now reported, counted, backed off, and named in `tempo describe`; and
      // once tasks are routed by queue, an unregistered type usually means a
      // deploy that has not finished rolling rather than a typo — so recovering
      // when the right version arrives is worth far more than failing fast.
      //
      // A genuine typo now wedges rather than settling. That is the poison-task
      // policy applied consistently: retry and surface, never give up on the
      // author's behalf — see `server_core.failWorkflowTask`.
      if (!fn) throw new Error(`no workflow registered as ${name}`);
      const ctx = createContext(
        args,
        history,
        continueAsNewSuggested,
        carryover,
      );
      await replay(ctx, fn);
      assertCarryoverFits(name, ctx.carryoverNext);
      return {
        done: ctx.done,
        result: ctx.result,
        failed: ctx.failed,
        failure: ctx.failure,
        commands: ctx.commands,
        carryover: ctx.carryoverNext,
        // Read after the replay has settled, so this is what the workflow is
        // waiting on *now* rather than everywhere it waited along the way.
        parked: parkedConditions(ctx),
      };
    },
  };
}

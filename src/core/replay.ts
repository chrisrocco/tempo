/**
 * @fileoverview
 * The core loop: run the workflow function under the ALS context, then feed
 * recorded history back into it one event at a time, settling between each.
 *
 * ## Activation vs. replay (not the same word)
 *
 * An **activation** (workflow task) is one batch of new events applied to move a
 * workflow forward: a signal arrived, a timer fired, an activity completed.
 * **Replay** is rebuilding in-memory state that was lost, by re-running the
 * workflow function from the top against recorded history. A signal causes an
 * activation; it does *not* by itself cause a replay. An activation involves
 * replay only when the worker no longer holds the execution's live state (crash,
 * cache eviction, redeploy, a different worker picking up the task) — which,
 * absent a sticky cache, is every task today. Because any activation might land
 * cold, every suspension point must be reconstructible identically from history.
 *
 * ## What suppresses a command
 *
 * Each primitive call allocates a `seq`, registers a completion promise, and
 * pushes a command **unless history already holds an event at that seq**. A
 * marker or a completion is proof the command was dispatched and is durable, so
 * re-emitting it would double-dispatch; a seq history has never seen is work the
 * server has never done. The rule lives in `workflow_api.issue`; this loop does
 * not participate in it at all.
 *
 * That last part is the design, not an accident. There used to be an `isLive`
 * flag here, set as the last recorded event was taken, and commands were emitted
 * only past it — the **live edge**. It reads like the same rule and is not: it
 * answers a question about *position* that is really about *content*, and the two
 * agree only when the batch's final event is the one that unblocks the workflow.
 * Two ordinary situations break that, and they broke it in different places:
 *
 * - **A batch with a trailing event.** `ports/workflow_task_queue` coalesces a
 *   wake landing mid-task into exactly one more, so a signal arriving while an
 *   activity completion is in flight produces `[…, activityCompleted, signal]` —
 *   which any workflow with a signal-driven branch beside a main line generates
 *   continuously. Settling the earlier completion carries the workflow to a
 *   genuinely new command while the flag is still false.
 * - **A first task that already has history**, which is not about this loop at
 *   all. The flag started false whenever history was non-empty, and a signal
 *   landing between the start and the worker's first poll gives task one a
 *   history of `[signal]` — so the initial `settle` below reached the workflow's
 *   *first* command with the flag already false.
 *
 * Either way the command was recorded in `requested` and never pushed: the worker
 * responded without it, history never got its marker, and the next replay dropped
 * it for the same reason, forever. Nothing threw, the execution stayed `running`
 * with no task failures, and it was parked on work the server had no record of —
 * a permanent, silent wedge (issue #39). Keying on history instead is what makes
 * this loop's only job applying events.
 *
 * ## `settle`: drain + condition unblock
 *
 * After each event, drain the microtask queue and run the condition unblock pass
 * to a fixpoint — resolving one condition can run code that makes another true.
 * `settle` is the atomic "advance as far as possible on the information
 * currently available" step.
 *
 * ## Observe, don't await, the workflow's own promise
 *
 * A task must conclude while the workflow function is still suspended mid-flight
 * — most tasks do not finish the workflow, and its promise resolves only once, at
 * the very end. So the driver never awaits it; it **observes** it with
 * `.then(onDone, onFail)` that records the terminal outcome, and concludes the
 * task on **quiescence** (microtasks drained, code parked again). A workflow that
 * never awaits anything finishes within its first task through the same
 * machinery, with no special case.
 *
 * ## Determinism rules this relies on
 *
 * - Time comes from `sleep` and recorded fire-times, never `Date.now()`.
 * - `seq` allocation must be stable across replays, so any branch that changes
 *   how many commands are issued must itself be deterministic.
 * - `condition` predicates must be pure reads of workflow state — no clock, no
 *   activity calls inside them.
 */

import {applyEvent} from './apply_event';
import {tryUnblockConditions} from './condition';
import {als, type WorkflowContext, type WorkflowFn} from './context';
import {drainMicrotasks} from './microtask_scheduler';

// drain microtasks, then run the condition unblock pass to a fixpoint
export async function settle(ctx: WorkflowContext): Promise<void> {
  await drainMicrotasks();
  while (tryUnblockConditions(ctx)) {
    await drainMicrotasks();
  }
}

export async function replay(
  ctx: WorkflowContext,
  workflowFn: WorkflowFn,
): Promise<WorkflowContext> {
  const wf = als.run(ctx, () => workflowFn(...ctx.args));
  // Voided deliberately: this is the observe-don't-await pattern above. Awaiting
  // it would hang every task that does not finish the workflow, which is most.
  void wf.then(
    (r) => {
      ctx.done = true;
      ctx.result = r;
    },
    (e) => {
      ctx.failed = true;
      ctx.failure = e;
    },
  );
  await settle(ctx);
  while (!ctx.done && !ctx.failed && ctx.idx < ctx.events.length) {
    const ev = ctx.events[ctx.idx++];
    applyEvent(ctx, ev);
    await settle(ctx);
  }
  return ctx;
}

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
 * ## The live edge, and what actually suppresses a command
 *
 * Each primitive call allocates a `seq`, registers a completion promise, and
 * pushes a command **unless history already holds an event at that seq**. A
 * marker or a completion is proof the command was dispatched and is durable, so
 * re-emitting it would double-dispatch; anything history has no seq for is
 * genuinely new work. That rule lives in `workflow_api.issue`, which also owns
 * the two commands leaving no trace.
 *
 * `isLive` — set as the last recorded event is taken — reads like the same rule
 * and is not. It is a *positional* answer to a question about *content*, and the
 * two agree only when the batch's last event is the one that unblocks the
 * workflow. That holds when an activation applies exactly one new event, which
 * used to be the only shape the specs covered.
 *
 * It breaks the moment a batch has a trailing event, and that batch is ordinary:
 * `ports/workflow_task_queue` coalesces a wake landing mid-task into exactly one
 * more, so a signal arriving while an activity completion is in flight produces
 * `[…, activityCompleted, signal]` — which any workflow with a signal-driven
 * branch beside a main line generates continuously. Settling the earlier
 * completion carries the workflow to a genuinely new command while `isLive` is
 * still false. Keyed on the flag, that command was recorded in `requested` and
 * never pushed: the worker responded without it, history never got its marker, so
 * the next replay dropped it for the same reason, forever. Nothing threw, the
 * execution stayed `running` with no task failures, and it was parked on work the
 * server had no record of — a permanent, silent wedge (issue #39).
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
    // Kept for `cancelChild`, which history cannot answer for; every other
    // command is suppressed on its seq rather than on this flag.
    if (ctx.idx === ctx.events.length) ctx.isLive = true;
    applyEvent(ctx, ev);
    await settle(ctx);
  }
  return ctx;
}

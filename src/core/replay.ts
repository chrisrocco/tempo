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
 * ## The live edge
 *
 * Each primitive call allocates a `seq`, registers a completion promise, and
 * pushes a command **only if `isLive`**. While replaying recorded history the
 * commands are suppressed — they are already durable, so re-emitting them would
 * double-dispatch. The moment the last recorded event is consumed `isLive` flips
 * to true (the **live edge**) and further calls push genuinely new work. One flag
 * divides "catching up" from "making progress".
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
    if (ctx.idx === ctx.events.length) ctx.isLive = true;
    applyEvent(ctx, ev);
    await settle(ctx);
  }
  if (!ctx.done && !ctx.failed) emitUnrecorded(ctx);
  return ctx;
}

/**
 * Emit commands the workflow issued while catching up that history never
 * recorded — the correction to `isLive` being a proxy for the question that
 * actually matters.
 *
 * Suppressing during catch-up is right exactly when history holds the command's
 * marker, because then it is already durable and re-emitting would
 * double-dispatch. It is wrong when history does not, and that happens whenever
 * an activation carries **more than one** new event: an earlier completion can
 * advance the workflow to a genuinely new command while the flag is still false,
 * since the flag flips only as the last event is taken. The workflow-task queue
 * coalesces a wake landing mid-task into exactly one more task, so a signal
 * arriving while an activity completion is in flight produces that batch — which
 * makes this the ordinary shape for any workflow with a signal-consuming branch
 * beside a main line, not a corner case.
 *
 * Dropping the command wedged the execution with no diagnostic anywhere: the
 * workflow parked on a promise nothing would resolve, and because replay never
 * threw, the execution stayed `running` with no task failures recorded.
 *
 * Keyed on the marker rather than on the flag, because the marker is the durable
 * record of dispatch and the flag was only ever standing in for it.
 * `cancelChild` is excluded: it writes no marker on purpose, so for it "no
 * marker" cannot mean "never dispatched".
 */
function emitUnrecorded(ctx: WorkflowContext): void {
  const recorded = new Set<number>();
  for (const ev of ctx.events) {
    if ('seq' in ev && typeof ev.seq === 'number') recorded.add(ev.seq);
  }
  const emitted = new Set(ctx.commands.map((c) => c.seq));
  for (const [seq, command] of ctx.requested) {
    if (command.type === 'cancelChild') continue;
    if (recorded.has(seq) || emitted.has(seq)) continue;
    ctx.commands.push(command);
  }
  // Call order, which is what `seq` means — a recovered command belongs where
  // the workflow issued it, not appended after work that came later.
  ctx.commands.sort((a, b) => a.seq - b.seq);
}

// The core loop: run the workflow function under the ALS context, then feed
// recorded history back into it one event at a time, settling between each. When
// the last event is applied the context goes `isLive`, so any further commands
// the workflow emits are new work. `settle` drives microtasks + condition
// unblocking to a fixpoint. See docs/concepts/replay-and-execution.md.
import { als, type WorkflowContext, type WorkflowFn } from './context';
import { applyEvent } from './apply_event';
import { tryUnblockConditions } from './condition';
import { drainMicrotasks } from './microtask_scheduler';

// drain microtasks, then run the condition unblock pass to a fixpoint
export async function settle(ctx: WorkflowContext): Promise<void> {
  await drainMicrotasks();
  while (tryUnblockConditions(ctx)) {
    await drainMicrotasks();
  }
}

export async function replay(ctx: WorkflowContext, workflowFn: WorkflowFn): Promise<WorkflowContext> {
  const wf = als.run(ctx, () => workflowFn(...ctx.args));
  wf.then((r) => { ctx.done = true; ctx.result = r; },
          (e) => { ctx.failed = true; ctx.failure = e; });
  await settle(ctx);
  while (!ctx.done && !ctx.failed && ctx.idx < ctx.events.length) {
    const ev = ctx.events[ctx.idx++];
    if (ctx.idx === ctx.events.length) ctx.isLive = true;
    applyEvent(ctx, ev);
    await settle(ctx);
  }
  return ctx;
}

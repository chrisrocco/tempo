/**
 * @fileoverview
 * ★ ACTIVITY ENTRYPOINT — what activity code imports.
 *
 * The third kind of user code, alongside workflows (`workflow.ts`) and hosts
 * (`index.ts`). An activity is an ordinary async function and needs nothing from
 * here to work; this exists for the few things that only mean something *while an
 * activity is running*.
 *
 * The separation is the point rather than tidiness. `heartbeat()` exported from
 * the host entrypoint would invite calling it from a workflow, where it is
 * meaningless — workflow code is replayed, and a heartbeat is a statement about
 * wall-clock liveness, its checkpoint a statement about work already done.
 * Neither survives being replayed. Keeping it here says which side of the determinism
 * boundary it belongs to, the same way `workflow.ts` says what a workflow may
 * reach.
 *
 * Activities are, by contrast, deliberately unconstrained: this is where I/O
 * lives, so there is no purity rule to enforce and no equivalent of the
 * author-entrypoint check. Importing from here is a convenience, not a boundary.
 */

/**
 * `heartbeat()` says "still working"; `cancellationRequested()` and
 * `cancellationSignal()` say whether anyone still wants the answer. The second
 * pair is heard *through* the first: the server can only reply to an attempt
 * that speaks, so the cancellation flag flips on a heartbeat reply and never
 * otherwise. The shape for a long activity is therefore one loop with both in it:
 *
 * ```ts
 * import {cancellationRequested, cancellationSignal, heartbeat} from 'workflow-engine/activity';
 *
 * export async function agentTurn(prompt: string): Promise<string> {
 *   for (const step of plan(prompt)) {
 *     heartbeat();
 *     if (cancellationRequested()) throw new Error('stopped: execution cancelled');
 *     await callModel(step, {signal: cancellationSignal()});
 *   }
 *   return summary();
 * }
 * ```
 *
 * Once the flag is set nothing the attempt returns or throws is consumed: the
 * server has already recorded the activity as cancelled and will not retry it, so
 * the only thing left to decide is how quickly to get out. The same flag flips
 * when the server has given up on this attempt for any other reason — a deadline
 * passed, or the seq settled through a redelivered attempt — because the answer
 * is the same. Pair this with `heartbeatTimeoutMs` on the activity's options,
 * which sets the cadence both liveness and cancellation travel at. See
 * `worker/activity_context.ts` for the reasoning.
 */
export {
  cancellationRequested,
  cancellationSignal,
  heartbeat,
} from './worker/activity_context';

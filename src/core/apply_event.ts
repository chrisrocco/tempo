/**
 * @fileoverview
 * `applyEvent` routes one recorded history event back into the in-memory promise
 * it belongs to. Signals fan out to their handler (or buffer if none is
 * registered yet); every other event completes the parked promise keyed by its
 * `seq`. This is also where the engine checks that history and code still agree.
 *
 * ## Two divergence checks, catching different failures
 *
 * **A completion for an unknown seq** — nothing is parked on it — means history
 * has an operation the code no longer has. That check has always been here.
 *
 * **A marker that disagrees with the command issued at its seq** catches the case
 * the first one cannot see. Correlation is by `seq`, assigned in call order, so
 * two concurrent branches that merely *swap order* produce seqs that are both
 * parked and both resolve — each with the other's result. No error, a string where
 * a number was expected, and the first symptom arbitrarily far downstream. Markers
 * already record what was dispatched; comparing them against what the workflow
 * asked for at that seq turns that silent corruption into a stopped replay.
 *
 * Coverage is deliberately partial, and worth knowing precisely:
 *
 * | Command            | Marker                  | Checked                        |
 * | ------------------ | ----------------------- | ------------------------------ |
 * | `scheduleActivity` | `activityScheduled`     | type + **name**                |
 * | `startTimer`       | `timerStarted`          | type only (`fireAt` absolute)  |
 * | `startChild`       | `childStarted`          | type + **`detached`**          |
 * | `cancelChild`      | `childCancelRequested`  | type + **`targetSeq`**         |
 *
 * So a swap between two same-named activities with different arguments still
 * slips through; argument comparison is expensive on large payloads and risks
 * false positives on serialization differences, so it is deliberately out.
 *
 * `parentClosePolicy` is out too, and for a different reason worth separating
 * from that one. It *is* cheap to compare — but the marker is the copy that
 * governs (`server_core.closeChildren` reads history, never the replayed
 * command), so a policy that differs on this replay changes nothing about what
 * happens. Checking it would turn editing an option in the source into a
 * nondeterminism error on every in-flight execution, in exchange for catching a
 * divergence with no consequence. Contrast `detached`, which is checked because
 * it decides whether a completion is coming back.
 *
 * Every command now leaves a marker. `cancelChild` was the exception until issue
 * #50, on the grounds that its effect is already durable on the child — true, and
 * beside the point once replay began deciding suppression by asking whether
 * history holds a seq. A command with no marker cannot answer that question, which
 * is what left it silently droppable.
 *
 * **Absence is not divergence.** A marker whose seq the workflow never issued is
 * skipped rather than rejected. The check is about *disagreement*; treating
 * silence as a mismatch would fail correct workflows in the cancellation window,
 * where a run stops allocating seqs the moment `cancelRequested` is applied.
 */

import type {Command, HistoryEvent} from '../protocol';
import type {WorkflowContext} from './context';
import {CancelledFailure, NondeterminismError} from './errors';

/** How a command reads in an error message. */
function describeCommand(cmd: Command): string {
  if (cmd.type === 'scheduleActivity') return `scheduleActivity ${cmd.name}`;
  if (cmd.type === 'startChild')
    return `startChild${cmd.detached ? ' (detached)' : ''}`;
  if (cmd.type === 'cancelChild') return `cancelChild of seq ${cmd.targetSeq}`;
  return cmd.type;
}

/**
 * Compare a marker against the command recorded at its seq. Returns the mismatch
 * as a message, or undefined when they agree — the caller owns the throw so the
 * event's own description is built in one place.
 */
function markerMismatch(
  ev: HistoryEvent & {seq: number},
  cmd: Command,
): string | undefined {
  if (ev.type === 'activityScheduled') {
    if (cmd.type !== 'scheduleActivity' || cmd.name !== ev.name)
      return describeCommand(cmd);
    return undefined;
  }
  if (ev.type === 'timerStarted')
    return cmd.type === 'startTimer' ? undefined : describeCommand(cmd);
  if (ev.type === 'childCancelRequested') {
    // `targetSeq` is the whole content of a cancel, and it is a claim about the
    // workflow's own logic: which spawn this call meant. A different one on this
    // replay means that logic has moved, and the parent would cancel a child it
    // never meant to while the intended one runs on.
    if (cmd.type !== 'cancelChild' || cmd.targetSeq !== ev.targetSeq)
      return describeCommand(cmd);
    return undefined;
  }
  if (ev.type === 'childStarted') {
    if (cmd.type !== 'startChild' || cmd.detached !== ev.detached)
      return describeCommand(cmd);
    // An id the workflow chose is checkable in a way a derived one is not: it
    // came from the workflow's own logic, so a different one on this replay
    // means that logic has moved. Left unchecked the parent would go on awaiting
    // the child history names while believing it started another.
    if (cmd.workflowId !== undefined && cmd.workflowId !== ev.childId)
      return `startChild ${cmd.workflowId}`;
    return undefined;
  }
  return undefined;
}

/** How a marker reads in an error message. */
function describeMarker(ev: HistoryEvent): string {
  if (ev.type === 'activityScheduled') return `activityScheduled ${ev.name}`;
  if (ev.type === 'childStarted')
    return `childStarted ${ev.childId}${ev.detached ? ' (detached)' : ''}`;
  if (ev.type === 'childCancelRequested')
    return `childCancelRequested of seq ${ev.targetSeq}`;
  return ev.type;
}

export function applyEvent(ctx: WorkflowContext, ev: HistoryEvent): void {
  if (ev.type === 'signal') {
    const h = ctx.signalHandlers.get(ev.name);
    if (h) h(ev.payload);
    else ctx.bufferedSignals.push(ev);
    return;
  }
  if (
    ev.type === 'activityScheduled' ||
    ev.type === 'timerStarted' ||
    ev.type === 'childStarted' ||
    ev.type === 'childCancelRequested'
  ) {
    // Markers resolve nothing — their presence in history is what keeps replay
    // from re-dispatching the command. They are, however, the record of what was
    // dispatched, so this is the one chance to notice the code has moved.
    const cmd = ctx.requested.get(ev.seq);
    const mismatch = cmd && markerMismatch(ev, cmd);
    if (mismatch)
      throw new NondeterminismError({
        seq: ev.seq,
        expected: `issued ${mismatch}`,
        actual: describeMarker(ev),
      });
    return;
  }
  if (ev.type === 'cancelRequested') {
    // Cancellation propagates: mark the run cancelled and reject everything it is
    // currently awaiting with CancelledFailure. New operations reject on creation
    // (see workflow_api / condition). The workflow unwinds via normal try/catch.
    ctx.cancelled = true;
    const err = new CancelledFailure();
    for (const waiter of ctx.completions.values()) waiter.reject(err);
    ctx.completions.clear();
    for (const cond of ctx.blockedConditions.values()) cond.reject(err);
    ctx.blockedConditions.clear();
    return;
  }
  // ev is now a CompletionEvent — guaranteed to carry a seq
  const waiter = ctx.completions.get(ev.seq);
  if (!waiter)
    throw new NondeterminismError({
      seq: ev.seq,
      expected: 'is not awaiting that seq',
      actual: ev.type,
    });
  ctx.completions.delete(ev.seq);
  if (ev.type === 'activityFailed' || ev.type === 'childFailed')
    waiter.reject(failureError(ev));
  else if (ev.type === 'timerFired') waiter.resolve(undefined);
  else waiter.resolve(ev.result);
}

/**
 * Rebuild the error a failed activity or child hands back to workflow code.
 *
 * The recorded stack is assigned unconditionally — **including when there is
 * none**. The stack this Error is born with describes *replay*: frames inside
 * apply_event, in a different process from the failure, re-derived on every
 * re-run. That is worse than no stack at all, because it looks like one while
 * pointing at the engine rather than at the line that threw, and it would be
 * stored and printed as though it were the origin. So an origin without a stack
 * (a thrown non-Error) yields an error without one, which is the honest answer.
 *
 * Determinism is unaffected: the value comes out of history, so every replay
 * reconstructs the same error.
 */
function failureError(ev: {error: string; stack?: string}): Error {
  const error = new Error(ev.error);
  error.stack = ev.stack;
  return error;
}

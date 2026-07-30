/**
 * @fileoverview
 * `applyEvent` routes one recorded history event back into the in-memory promise
 * it belongs to. Signals fan out to their handler (or buffer if none is
 * registered yet); every other event completes the parked promise keyed by its
 * `seq`. A completion event for an unknown seq means history and code diverged —
 * that is the nondeterminism check.
 */

import type { HistoryEvent } from '../protocol';
import type { WorkflowContext } from './context';
import { CancelledFailure } from './errors';

export function applyEvent(ctx: WorkflowContext, ev: HistoryEvent): void {
  if (ev.type === 'signal') {
    const h = ctx.signalHandlers.get(ev.name);
    if (h) h(ev.payload);
    else ctx.bufferedSignals.push(ev);
    return;
  }
  if (ev.type === 'activityScheduled' || ev.type === 'timerStarted' || ev.type === 'childStarted') {
    // Markers only: the completion arrives later as its own event. Their presence
    // in history is what keeps replay from re-dispatching the command.
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
  if (!waiter) throw new Error(`nondeterminism: history event for unknown seq ${ev.seq}`);
  ctx.completions.delete(ev.seq);
  if (ev.type === 'activityFailed' || ev.type === 'childFailed') waiter.reject(new Error(ev.error));
  else if (ev.type === 'timerFired') waiter.resolve(undefined);
  else waiter.resolve(ev.result);
}

/**
 * @fileoverview
 * Signals are external inputs delivered into a running workflow. A signal arrives
 * as a history event with **no seq** — it is external, not tied to a command — and
 * `applyEvent` routes it to the registered handler. A handler registered via
 * `setHandler` drains any signals that arrived before it was registered (the
 * pre-registration buffer in `applyEvent`), so signal delivery is
 * order-independent with respect to handler setup. In practice a workflow
 * registers its handlers before its first await, so the buffer is a safety net.
 *
 * ## The handler-only-enqueues discipline
 *
 * Signal handlers should do the minimum — push onto a queue, set a flag. Doing
 * real work inside a handler (starting or cancelling children) invites races and
 * unfinished-handler problems at continue-as-new. Let the main loop drain the
 * queue and act:
 *
 *     const diff = defineSignal('diff');
 *     const queue: Diff[] = [];
 *     setHandler(diff, (d) => queue.push(d)); // handler only enqueues
 *     while (true) {
 *       await condition(() => queue.length > 0); // park until something changes
 *       const d = queue.shift()!;
 *       // ...reconcile...
 *     }
 *
 * This never misses an item because of the ordering guarantee: the signal that
 * pushes onto `queue` *is* the activation that triggers the condition unblock
 * pass, and the handler runs before the pass — so the condition reliably sees the
 * new item.
 */

import { getContext } from './context';

export interface SignalDef {
  name: string;
}

export function defineSignal(name: string): SignalDef {
  return { name };
}

export function setHandler(
  signalDef: SignalDef,
  fn: (payload: any) => void,
): void {
  const ctx = getContext();
  ctx.signalHandlers.set(signalDef.name, fn);
  const ready = ctx.bufferedSignals.filter((s) => s.name === signalDef.name);
  ctx.bufferedSignals = ctx.bufferedSignals.filter(
    (s) => s.name !== signalDef.name,
  );
  for (const s of ready) fn(s.payload);
}

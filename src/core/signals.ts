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
 * ## A signal is a name, on both sides of the wire
 *
 * `setHandler('go', …)` inside the workflow; `handle.signal('go', payload)`
 * outside it. There used to be a `defineSignal(name)` returning a `SignalDef`
 * wrapper, and it was deleted for buying nothing: it carried no payload type —
 * the payload is untyped JSON off the wire either way — so it was ceremony
 * around a string, and half the API accepted the bare string anyway. If typed
 * payloads are ever wanted, the mechanism is a *generic* definition that
 * `setHandler` and the senders both consume; a def that exists only to hold a
 * name is the shape that was tried and removed.
 *
 * ## The handler-only-enqueues discipline
 *
 * A handler runs synchronously inside `applyEvent`, so it has no coherent place to
 * suspend: it cannot await. It should therefore do the minimum — push onto a
 * queue, set a flag — and let ordinary control flow do the work. Starting real
 * work inside a handler produces a detached branch that is abandoned silently at
 * continue-as-new or completion.
 *
 * That constraint is essential. What is *not* essential is hand-rolling the
 * plumbing around it: **prefer `signalStream` from `patterns/signal_stream.ts`**,
 * which turns signal consumption into a `for await` loop whose body may await
 * activities freely. The manual form below is what it replaces, kept here because
 * the ordering guarantee it relies on is the same one the stream is built on:
 *
 *     const queue: Diff[] = [];
 *     setHandler('diff', (d: Diff) => queue.push(d));
 *     while (true) {
 *       await condition(() => queue.length > 0);
 *       const d = queue.shift()!;
 *     }
 *
 * It never misses an item because the signal that pushes onto `queue` *is* the
 * activation that triggers the condition unblock pass, and the handler runs
 * before the pass — so the condition reliably sees the new item.
 */

import {getContext} from './context';

/**
 * Register the handler for a signal, delivering anything that arrived before it
 * was set (see the buffering note below).
 *
 * `payload` is `any` rather than `unknown` so an author can write
 * `setHandler('approved', (id: string) => …)` without a cast: parameters are
 * contravariant, so `(id: string) => void` is not assignable to
 * `(payload: unknown) => void`. The payload genuinely is untyped — it crossed
 * the wire as JSON — and the handler's own signature is the assertion about its
 * shape.
 *
 * ## A second registration silently displaces the first
 *
 * One handler exists per name, so this overwrites and the displaced consumer
 * stops receiving. The symptom is a *hang* rather than an error: a workflow
 * parked on something that will never arrive, with nothing in history saying
 * why. `clearHandler` is how a consumer scoped to a block gives the name back.
 *
 * Whether this should throw instead is open. It would be consistent with
 * `clearHandler` existing at all, and a breaking change for anyone relying on
 * replace-in-place.
 */
export function setHandler(name: string, fn: (payload: any) => void): void {
  const ctx = getContext();
  ctx.signalHandlers.set(name, fn);
  const ready = ctx.bufferedSignals.filter((s) => s.name === name);
  ctx.bufferedSignals = ctx.bufferedSignals.filter((s) => s.name !== name);
  for (const s of ready) fn(s.payload);
}

/**
 * Remove a signal handler. Signals arriving afterwards go back to the
 * pre-registration buffer, so a later `setHandler` still receives them. This is
 * what lets a consumer be scoped to a block instead of to the whole workflow.
 */
export function clearHandler(name: string): void {
  getContext().signalHandlers.delete(name);
}

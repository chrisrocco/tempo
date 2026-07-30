// Signals are external inputs delivered into a running workflow. A handler
// registered via `setHandler` drains any signals that arrived before it was
// registered (the pre-registration buffer in `applyEvent`), so signal delivery
// is order-independent with respect to handler setup. See doc 03.
import { getContext } from './context';

export interface SignalDef { name: string }

export const defineSignal = (name: string): SignalDef => ({ name });

export function setHandler(signalDef: SignalDef, fn: (payload: any) => void): void {
  const ctx = getContext();
  ctx.signalHandlers.set(signalDef.name, fn);
  const ready = ctx.bufferedSignals.filter((s) => s.name === signalDef.name);
  ctx.bufferedSignals = ctx.bufferedSignals.filter((s) => s.name !== signalDef.name);
  for (const s of ready) fn(s.payload);
}

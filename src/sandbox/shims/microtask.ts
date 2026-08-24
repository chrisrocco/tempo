/**
 * `setImmediate`, for a browser, with the ordering the engine depends on.
 *
 * `core/microtask_scheduler.ts` is one line — `new Promise(r => setImmediate(r))`
 * — and `settle()` awaits it after every history event. Two properties matter:
 *
 * - **It must run after the microtask queue drains.** That is what makes
 *   `settle` mean "advance as far as possible on the information currently
 *   available"; a microtask-based shim would resolve *inside* the drain it is
 *   supposed to follow.
 * - **It must be fast.** `setTimeout(…, 0)` clamps to 4ms once nested a few
 *   deep, and a replay pays this per event — the bug-fix agent's 87-event
 *   history would stall for a third of a second on every task.
 *
 * `MessageChannel` satisfies both: a macrotask, posted and delivered in well
 * under a millisecond. Installed on `globalThis` because `setImmediate` is a
 * bare global in the engine rather than an import, so there is nothing to
 * alias.
 */
type ImmediateFn = (callback: () => void) => void;

/**
 * Assigned through a cast rather than a `declare global`: widening the global
 * `setImmediate` to possibly-undefined would make every honest call site in the
 * engine look unsafe to the compiler.
 */
const globals = globalThis as unknown as {setImmediate?: ImmediateFn};

/**
 * The browser's `MessageChannel`, described structurally.
 *
 * This file is browser code living in a package typechecked against Node's
 * types, where `MessagePort` is the worker-threads one and carries no
 * `onmessage`. Naming the two members actually used is more honest than
 * pulling the whole DOM lib into the engine's program for one shim.
 */
interface PostingPort {
  onmessage: (() => void) | null;
  postMessage(value: unknown): void;
}

export function installSetImmediate(): void {
  if (typeof globals.setImmediate === 'function') return;

  const pending: Array<() => void> = [];
  const channel = new MessageChannel() as unknown as {
    port1: PostingPort;
    port2: PostingPort;
  };
  channel.port1.onmessage = () => {
    // One callback per message, so a callback that queues another cannot
    // starve the loop the way draining the whole array would.
    pending.shift()?.();
  };

  globals.setImmediate = (callback: () => void): void => {
    pending.push(callback);
    channel.port2.postMessage(undefined);
  };
}

/**
 * `AsyncLocalStorage`, for a browser, correct under two constraints.
 *
 * The engine carries workflow context through ALS because an `await`
 * continuation must re-enter with the context that was active when it
 * suspended — the driver resolves parked promises from *outside* the
 * `als.run()` scope, and the workflow's resumed code still has to find its own
 * context. V8 tracks that natively; a browser has nothing equivalent.
 *
 * ## Why this does not restore
 *
 * The obvious shim — set the store, run, restore in a `finally` — fails
 * immediately, and it is worth writing down because it looks so right. An async
 * workflow function returns at its *first await*, so the `finally` runs while
 * the workflow is merely suspended, not finished. Every continuation the driver
 * later resolves then reads an empty store, and the first primitive it reaches
 * throws `workflow API called outside a workflow context`. That is not a
 * hypothetical: it is what the bug-fix agent did here, one line after its first
 * activity.
 *
 * So `run` sets and leaves. The store stays pointing at the last context
 * entered, which is correct exactly while **one replay is in flight at a time**
 * — the next `run` overwrites it, and nothing in between needs the old one.
 *
 * ## The two constraints
 *
 * 1. **One replay at a time.** `worker_loops` defaults `maxConcurrentTasks` to
 *    1, so the workflow loop awaits each task to quiescence before claiming the
 *    next. Raise that in a sandbox and two executions will silently read each
 *    other's context. This is the shim's real limit, and the reason it must not
 *    escape into a deployed worker.
 * 2. **One slot per instance.** The engine keeps two of these — workflow
 *    context and activity context — and their loops interleave, so a slot
 *    shared across instances lets a running activity clobber a parked
 *    workflow's context. Hence a field, not a static.
 *
 * The cost, stated plainly: a stale context outlives its replay, so calling a
 * workflow primitive from outside a workflow may quietly find the last one
 * instead of throwing. In a single-visitor sandbox that trade is worth it; in a
 * real worker it would be a correctness bug wearing a convenience's clothes.
 */
export class AsyncLocalStorage<T> {
  private current: T | undefined;

  run<R>(store: T, fn: () => R): R {
    this.current = store;
    return fn();
  }

  getStore(): T | undefined {
    return this.current;
  }

  /** Present because the engine's activity context constructs one; unused. */
  enterWith(store: T): void {
    this.current = store;
  }
}

export default {AsyncLocalStorage};

/**
 * @fileoverview
 * Signal consumption as ordinary control flow:
 *
 *     for await (const comment of signalStream('clComment', { until: submitted })) {
 *       await postReply(comment);          // the body may await freely
 *     }
 *
 * instead of a hand-rolled queue, a handler that pushes to it, a `condition` that
 * watches its length, and a drain loop. That manual pattern is the one place the
 * "a workflow is just a function" promise breaks down — it asks the author to
 * rebuild an inbox on top of an engine whose whole job is to be a replayable log
 * of events.
 *
 * ## This is a composition, not new engine mechanism
 *
 * Everything here is built on `setHandler` + `condition` + `clearHandler`. There
 * is no new context state, no new history event, and no command: **signals
 * allocate no `seq`**, so nothing in this module can perturb command numbering or
 * replay. It lives in `core/` because it is deterministic, and it is re-exported
 * from the author entrypoint.
 *
 * It works because of one property of `settle`: after every microtask drain the
 * condition unblock pass runs, looping to a fixpoint. So a flag set by *any*
 * promise callback — including the `until` promise settling — is visible to the
 * next pass, and a parked consumer wakes without the engine knowing about it.
 *
 * ## Registration is eager, on purpose
 *
 * A generator body does not run until its first `next()`. If `setHandler` lived
 * inside the generator, registration would be deferred until iteration began and
 * signals arriving in between would be silently dropped. So the plain function
 * registers; only the iteration is a generator.
 *
 * ## Who feeds the stream
 *
 * Anything that can signal: a client, or another workflow via `signalWorkflow`.
 * A stream cannot tell them apart and should not — the shape this was built for
 * is a child poller relaying items to a parent parked on `for await`, and the
 * consumer reads identically whether the producer is inside the engine or not.
 *
 * ## One consumer per signal, and nothing enforces it
 *
 * Only one handler exists per signal name, so two concurrent streams on the same
 * signal cannot both be served: the second silently displaces the first, which
 * then hangs rather than failing. See `setHandler`. Fan out inside a single
 * consumer, or consume the signal in one place and share the result through a
 * local variable.
 *
 * ## Two consumers with different lifetimes
 *
 * A lifetime consumer alongside a scoped one, communicating through ordinary
 * locals rather than a state object:
 *
 *     let directive = 'proceed';
 *     let finished = false;
 *
 *     const watcher = background(async () => {
 *       for await (const c of signalStream('bugComment', {
 *         until: condition(() => finished),          // a condition IS the stop signal
 *       })) {
 *         directive = await triage(c);
 *       }
 *     });
 *
 *     try {
 *       for (const stage of STAGES) {
 *         watcher.throwIfFailed();
 *         if (directive === 'abandon') break;
 *         await runStage(stage);
 *       }
 *     } finally {
 *       finished = true;
 *       await watcher.done;                          // drain before completing
 *     }
 *
 * Note `condition(() => finished)` used as `until`: a condition is already a
 * promise the main line can resolve, so bounding a stream needs no new primitive.
 */

import {condition} from '../core/condition';
import {clearHandler, setHandler} from '../core/signals';

/** How a `signalStream` starts and how it ends. */
export interface StreamOptions {
  /**
   * Ends the stream once it settles. Must be an **engine** promise — an activity,
   * a `sleep`, a `condition`. A raw host promise would make the end point depend
   * on wall-clock timing and diverge on replay.
   */
  until?: Promise<unknown>;
  /**
   * `'now'` (the default) ignores signals buffered before the call — right for a
   * consumer scoped to a window that has just opened. `'start'` includes them.
   */
  from?: 'now' | 'start';
}

/**
 * An async iterable of a signal's payloads.
 *
 * Signals arriving while the body is busy are held and delivered on the next
 * iteration, so nothing is lost and the body never runs concurrently with itself.
 * When `until` settles the backlog is drained *before* the stream ends — signals
 * that arrived during the window are never discarded by it closing. The handler
 * is released on every exit path: normal end, `break`, or cancellation unwinding
 * the branch.
 *
 * Note that creating a stream and never iterating it still holds the signal name;
 * the claim is released when iteration ends.
 */
export function signalStream<T = unknown>(
  name: string,
  opts: StreamOptions = {},
): AsyncIterable<T> {
  const queue: T[] = [];
  let ended = false;

  setHandler(name, (payload: T) => {
    queue.push(payload);
  });
  // `setHandler` flushes the pre-registration buffer into `queue`; for 'now' that
  // backlog predates the window this consumer cares about.
  if ((opts.from ?? 'now') === 'now') queue.length = 0;

  // Voided: the stream only needs the side effect of `until` settling.
  void opts.until?.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    },
  );

  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      try {
        while (true) {
          await condition(() => queue.length > 0 || ended);
          if (queue.length > 0) {
            yield queue.shift() as T;
            continue;
          }
          return; // ended, and the backlog is drained
        }
      } finally {
        clearHandler(name);
      }
    },
  };
}

/**
 * Resolves with the first signal to arrive after this call, then releases the
 * name. Registers eagerly, so it is safe to create before the window it observes
 * — which is the usual shape: build it, then pass it as another stream's `until`.
 */
export function firstSignal<T = unknown>(name: string): Promise<T> {
  let value: T | undefined;
  let received = false;
  setHandler(name, (payload: T) => {
    if (!received) {
      value = payload;
      received = true;
    }
  });

  return condition(() => received).then(() => {
    clearHandler(name);
    return value as T;
  });
}

/** A concurrent line of control started by `background`. */
export interface Branch {
  /**
   * Rethrow the branch's failure on the main line. Call it at checkpoints — a
   * branch that died should not let the workflow quietly succeed.
   */
  throwIfFailed(): void;
  /**
   * Settles when the branch finishes. Never rejects; failures are reported
   * through `throwIfFailed`, so awaiting this to drain in-flight work is safe.
   */
  done: Promise<void>;
}

/**
 * Run a second line of control concurrently with the main one — a lifetime signal
 * consumer, say, alongside a sequence of stages.
 *
 * A bare `void (async () => {…})()` swallows the branch's failure and lets the
 * workflow complete successfully with a dead branch; this captures it instead.
 * Branch scheduling is driven entirely by history, so the interleaving of the
 * commands two branches emit reproduces on replay.
 */
export function background(fn: () => Promise<unknown>): Branch {
  let error: unknown;
  let failed = false;
  const done = fn().then(
    () => undefined,
    (e: unknown) => {
      error = e;
      failed = true;
    },
  );
  return {
    throwIfFailed(): void {
      if (failed) throw error;
    },
    done,
  };
}

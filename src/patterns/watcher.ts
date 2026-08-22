/**
 * @fileoverview
 * The watcher: a poller child that delivers what it finds to its parent as
 * signals, consumed behind an async iterable. This is the composition of
 * `pollForever`, `signalWorkflow`, `startChild`, and `signalStream` that every
 * external-event consumer otherwise assembles by hand — and it is the assembly
 * that carries the sharp edges, not the parts: the child id must be
 * deterministic so a replayed start re-claims instead of double-spawning, the
 * cursor must ride carryover, the child's history must shed by rollover, and
 * "once per item" must fall out of recorded commands rather than hope.
 *
 * Split in two, on the same line `proxyActivities` sits on:
 *
 * - **This file is the deterministic half** — the child workflow's body
 *   (`watcherRun`) and the parent-side handle (`openWatcher`). Everything here
 *   is replay-safe and holds to `patterns/` purity.
 * - **`createWatcher` in `workflow.ts` is the seam** — it *registers* the poll
 *   activity and the child workflow at module load, which is host state and
 *   therefore not this layer's to touch.
 *
 * ## Delivery semantics
 *
 * Each item a differ reports as added is signalled to the parent exactly once
 * across the watcher's life: `pollForever` guarantees once-per-item reporting,
 * and `signalWorkflow` is a recorded command, suppressed on replay. Items ride
 * workflow history twice (the child's command, the parent's signal), so they
 * must be JSON-serializable — the same rule as every activity result. Removals
 * (`byId` differs report them) are not delivered; a watcher is a stream of
 * appearances. Reopen that when a caller has a real branch to write on one.
 *
 * ## A dead poller is loud, not deaf
 *
 * If the poll fails terminally — its retry budget exhausted on a persistent
 * problem — the child does not just die while its parent waits forever on a
 * signal that will never come. Its last act is one more signal: a failure
 * marker, delivered on the same signal name (the server dispatches a failing
 * activation's commands before settling it, so the marker always lands). The
 * parent-side handle recognizes it and throws `WatcherFailedError` from
 * `next()` / iteration, which turns "my subscription silently stopped" into an
 * ordinary catchable failure at the exact `await` that was depending on it.
 * Cancellation is not failure: `signalWorkflow` refuses new work after cancel,
 * so `stop()` and parent close never produce a spurious marker.
 *
 * ## One `as` per subscription
 *
 * The subscription name (`as`, defaulting to `'watch'`) is part of both the
 * child's workflow id and the signal name. Two `open`s with the same key and
 * `as` in one workflow do not make two subscriptions: the second child start is
 * a no-op claim, and the second `signalStream` **replaces** the first's handler
 * (see `core/signals`), starving the first iterator. One watch per `as`;
 * a workflow that needs two watches on one watcher names them.
 */

import {signalWorkflow, startChild, workflowInfo} from '../core/workflow_api';
import type {Differ} from './diff';
import {pollForever, type PollStart} from './poller';
import {signalStream} from './signal_stream';

/**
 * Thrown by a `WatcherHandle` when the poller child died on a terminal poll
 * failure. The message carries the child's own failure, so the parent sees
 * *why* the subscription ended, not just that it did.
 */
export class WatcherFailedError extends Error {
  /** The watcher's workflow name (its `createWatcher` key). */
  readonly watcher: string;

  constructor(watcher: string, message: string) {
    super(`watcher '${watcher}' failed: ${message}`);
    this.name = 'WatcherFailedError';
    this.watcher = watcher;
  }
}

/**
 * The failure marker a dying child sends as its last signal. Namespaced key so
 * no plausible item collides with it; JSON-safe because it rides history like
 * any other payload.
 */
interface WatcherFailureSignal {
  readonly __tempoWatcherFailed: {readonly message: string};
}

function isFailureSignal(value: unknown): value is WatcherFailureSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__tempoWatcherFailed' in value
  );
}

/**
 * The child's props: everything a watcher run needs, all JSON-safe, because a
 * rollover reseeds the run from exactly this.
 */
export interface WatcherProps {
  /** Where findings are delivered — the parent's workflowId. */
  parentId: string;
  /** The signal the parent listens on; carries `as`, so subscriptions don't collide. */
  signalName: string;
  /** Poll cadence in milliseconds. */
  everyMs: number;
  /** Where the first cycle starts — `PollStart`, with the differ state JSON-safe. */
  start: 'all' | 'new' | {state: unknown};
  /** Caller data forwarded to every poll, e.g. a server-side filter. */
  input?: unknown;
}

/** The parent's end of a watcher: an async iterable of what the child found. */
export interface WatcherHandle<T> extends AsyncIterable<T> {
  /**
   * Park until the next item. Throws `WatcherFailedError` if the poller child
   * died on a terminal poll failure — a subscription never just goes quiet.
   */
  next(): Promise<T>;
  /** Cancel the poller child. (Parent close also terminates it.) */
  stop(): void;
  /** For composing with `firstSignal` / `condition` directly. */
  readonly signalName: string;
}

/** What the parent may vary per watch; everything else is the watcher's identity. */
export interface WatchOptions<S, I> {
  /** Override the watcher's declared poll cadence, in milliseconds. */
  everyMs?: number;
  /** Defaults to `'new'`: the first poll is the baseline, only later items fire. */
  start?: PollStart<S>;
  /** Names this subscription when one workflow watches the same watcher twice. */
  as?: string;
  /** Forwarded to every poll — a filter the source can apply, an address, a scope. */
  input?: I;
}

/**
 * The child workflow's body, composed once per watcher definition: poll through
 * the differ forever, signalling each addition home. `poll` here is already the
 * *proxied activity* — the deterministic forwarder — never the implementation;
 * handing an implementation to workflow code is exactly the mistake the
 * `createWatcher` seam exists to prevent.
 */
export function watcherRun<T, S, Q>(
  poll: (query: Q, input: unknown) => Promise<readonly T[]>,
  differ: Differ<T, S, Q>,
): (props: WatcherProps) => Promise<never> {
  return async (props) => {
    try {
      return await pollForever<T, S, Q>({
        everyMs: props.everyMs,
        poll: (query) => poll(query, props.input),
        differ,
        startFrom:
          props.start === 'all' || props.start === 'new'
            ? props.start
            : {state: props.start.state as S},
        onAdded: (item) =>
          signalWorkflow(props.parentId, props.signalName, item),
      });
    } catch (e) {
      // The child's last act: tell the parent the subscription is over, and
      // why. `signalWorkflow` refuses new work after cancel, so a stopped or
      // parent-closed child sends nothing — only a genuine failure poisons the
      // stream. The command is dispatched before this failure settles the
      // child (the server applies a failing activation's commands first), so
      // the marker always lands.
      const failure: WatcherFailureSignal = {
        __tempoWatcherFailed: {
          message: e instanceof Error ? e.message : String(e),
        },
      };
      signalWorkflow(props.parentId, props.signalName, failure);
      throw e;
    }
  };
}

/**
 * Open a subscription from inside the parent workflow: claim the child under a
 * deterministic id and wrap its signal in a stream. The id claim is what makes
 * this replay-safe and crash-safe — a re-executed `open` attaches to the child
 * that already exists rather than spawning a second poller.
 */
export function openWatcher<T, S, I>(
  workflowName: string,
  defaultEveryMs: number,
  options: WatchOptions<S, I> = {},
): WatcherHandle<T> {
  const info = workflowInfo();
  const as = options.as ?? 'watch';
  const signalName = `watch:${workflowName}:${as}`;
  const start: WatcherProps['start'] =
    options.start === undefined
      ? 'new'
      : options.start === 'all' || options.start === 'new'
        ? options.start
        : {state: options.start.state};
  const child = startChild(workflowName, {
    workflowId: `${info.workflowId}/watch/${workflowName}/${as}`,
    parentClosePolicy: 'terminate',
    props: {
      parentId: info.workflowId,
      signalName,
      everyMs: options.everyMs ?? defaultEveryMs,
      start,
      input: options.input,
    } satisfies WatcherProps,
  });
  const raw = signalStream<T | WatcherFailureSignal>(signalName, {
    from: 'start',
  })[Symbol.asyncIterator]();
  // One guard between the wire and the caller: failure markers become throws,
  // everything else passes through. `next()` and `for await` share the one
  // generator, so consuming from either advances the same stream.
  const guarded = (async function* (): AsyncGenerator<T> {
    try {
      while (true) {
        const value = (await raw.next()).value;
        if (isFailureSignal(value)) {
          throw new WatcherFailedError(
            workflowName,
            value.__tempoWatcherFailed.message,
          );
        }
        yield value as T;
      }
    } finally {
      await raw.return?.(undefined as never); // release the signal handler
    }
  })();
  return {
    next: async () => (await guarded.next()).value as T,
    stop: () => child.cancel(),
    signalName,
    [Symbol.asyncIterator]: () => guarded,
  };
}

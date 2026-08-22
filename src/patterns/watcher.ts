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
  /** Park until the next item. */
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
  return (props) =>
    pollForever<T, S, Q>({
      everyMs: props.everyMs,
      poll: (query) => poll(query, props.input),
      differ,
      startFrom:
        props.start === 'all' || props.start === 'new'
          ? props.start
          : {state: props.start.state as S},
      onAdded: (item) => signalWorkflow(props.parentId, props.signalName, item),
    });
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
  const iterator = signalStream<T>(signalName, {from: 'start'})[
    Symbol.asyncIterator
  ]();
  return {
    next: async () => (await iterator.next()).value as T,
    stop: () => child.cancel(),
    signalName,
    [Symbol.asyncIterator]: () => iterator,
  };
}

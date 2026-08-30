/**
 * @fileoverview
 * ★ AUTHOR ENTRYPOINT — workflow code imports ONLY from here.
 *
 * This module re-exports the deterministic primitives from `core`, plus the two
 * pure libraries an author needs beside them — the schema builder `t` and
 * `Duration`. Nothing here touches I/O, the clock, or randomness, which is the
 * whole point: the boundary checker (`tools/boundaries.ts`, run by `npm run lint` and by
 * spec/architecture.spec.ts) keys on this file to keep the determinism boundary
 * enforced rather than merely documented. If you find yourself wanting to add a
 * non-deterministic capability here, it belongs on the runtime/host side instead.
 *
 * ## `Tempo` is this module, namespace-imported
 *
 * Workflow code reads better with one prefix, and this is the module to put it
 * on:
 *
 * ```ts
 * import * as Tempo from 'workflow-engine/workflow';
 *
 * const charge = Tempo.createWorkflow({
 *   key: 'charge',
 *   async run({id}: {id: string}) {
 *     await Tempo.sleep(1000);
 *     return acts.capture(id);
 *   },
 * });
 * ```
 *
 * A namespace import rather than an exported `Tempo` object, for two reasons. It
 * is the only form the boundary checker accepts without being taught a second
 * path — the rule permits exactly one runtime import in a workflow module, and
 * it is this one. And an object would restate every export a second time, so the
 * next author-facing primitive would have to be added twice or silently miss the
 * namespace.
 *
 * **`startWorker` is deliberately not reachable this way.** It reads `argv`,
 * calls `os.hostname()` and opens sockets, so a workflow module importing it
 * would drag the worker runtime across the very line this file exists to hold.
 * It is a plain import in the worker artifact, which is a separate one-line
 * file: `import {startWorker} from 'workflow-engine'`.
 *
 * ## The boundary, and why it exists
 *
 * Durability is achieved by **replay**: to recover a workflow whose in-memory
 * state was lost, the engine re-runs the function from the top against recorded
 * history. For that reconstruction to be correct, replay must be reproducible —
 * the same history must always drive the function to the same point and produce
 * the same commands. Any non-determinism inside workflow code breaks this and the
 * recovered state is silently wrong. So the boundary is not a style preference;
 * it is the precondition that makes the whole event-sourcing scheme sound.
 *
 * It also buys the two properties the rest of the system is built on. The core is
 * a pure function of its input, so it is unit-testable against hand-written
 * histories with no infrastructure. And because replay commits no external
 * effects, running it twice is harmless — which is exactly what makes it safe for
 * two workers to race on the same execution and discard the loser's work.
 * Distribution is only tractable because of this line.
 *
 * ## Rules workflow code must obey
 *
 * - Do not read the wall clock (`Date.now()`, `new Date()`) — use `sleep` and
 *   recorded times.
 * - Do not use randomness.
 * - Do not do I/O directly — request it through an **activity**.
 * - Do not depend on mutable state outside the workflow's own context.
 * - Do not `await` anything the engine did not hand you (a raw `setTimeout`, a
 *   bare `fetch`). Only promises the engine resolves are safe, because only those
 *   resolve identically on replay.
 *
 * One more rule, which is about the *source* rather than about a single run:
 * **changing which commands a workflow issues is a change to the histories already
 * recorded against it.** Replay reproduces a run only while the code still asks for
 * what history holds, so adding, removing or reordering a primitive call is safe
 * only if no execution has passed that point. When one has, `patched` is how the
 * new branch is added without diverging them — it reads which side of the change an
 * execution is on out of its own history, so old and new can share one source. And
 * when it is missed, a replay that settles an execution while history still holds
 * work it never issued is stopped rather than published (`core/apply_event`).
 *
 * ## How the boundary is held today
 *
 * Two entrypoints (this file for workflow code, `index.ts` for hosts) plus a
 * strictly downward dependency direction (`protocol <- core <- runtime <-
 * entrypoints`; `core/` may import only `protocol/`). Both are checked
 * mechanically by `tools/boundaries.ts`, along with the ban on clock and
 * randomness inside `core/` and inside workflow modules. When deciding where a
 * new feature goes, ask "is this deterministic (history-in, commands-out) or
 * not?" The answer names the layer.
 */

import {registerActivityImpls} from './activity_registry';
import {
  normalizeActivityOptions,
  type ActivityOptionsInput,
} from './core/activity_options_input';
import {createActivityProxy, type ActivityProxy} from './core/workflow_api';
import {durationToMs, type Duration} from './libraries/walltime';
import type {Differ} from './patterns/diff';
import type {PollStart} from './patterns/poller';
import {
  openWatcher,
  watcherRun,
  type WatcherHandle,
  type WatcherProps,
} from './patterns/watcher';
import type {AnyWorkflowFn} from './workflow_descriptor';
import {createWorkflow} from './workflow_registry';

export {clearCarryover, getCarryover, setCarryover} from './core/carryover';
export {condition, type ConditionOptions} from './core/condition';
export {
  waitForApproval,
  type ApprovalDecision,
  type ApprovalRequest,
} from './patterns/approval';
export {byCursor, byId, type Differ, type DiffResult} from './patterns/diff';
export {CancelledFailure} from './core/errors';
export {
  pollForever,
  type PollForeverOptions,
  type PollStart,
} from './patterns/poller';
export {
  background,
  firstSignal,
  signalStream,
  type Branch,
  type StreamOptions,
} from './patterns/signal_stream';
export {clearHandler, setHandler} from './core/signals';
export {
  continueAsNew,
  deprecatePatch,
  executeChild,
  patched,
  runActivity,
  signalWorkflow,
  sleep,
  startChild,
  startWorkflow,
  workflowInfo,
  type ChildHandle,
  type ChildOptions,
  type StartWorkflowExternalOptions,
  type WorkflowInfo,
} from './core/workflow_api';

export type {AnyWorkflowFn} from './workflow_descriptor';
export {
  createWorkflow,
  type SchemaWorkflowRegistration,
  type WorkflowDeclaration,
  type WorkflowRef,
  type WorkflowRegistration,
} from './workflow_registry';

/**
 * The schema builder, so a workflow module can describe its props where it
 * declares them — `createWorkflow({props: t.object({...})})` renders the
 * catalogue's document and types `run` from the one definition.
 *
 * Re-exported rather than imported directly because workflow code may import
 * only this module at runtime (`tools/boundaries.ts`), and `t` is safe on this
 * side of the boundary by construction: the library is pure and synchronous,
 * with no clock, no I/O and no host state, so evaluating a schema at module
 * scope of a workflow module is as deterministic as declaring a constant.
 * `workflow-engine/connectors` re-exports the same builder for the same reason.
 *
 * The full library — `runSchema`, `strictProblems`, the validator port — is
 * `workflow-engine/schema`. What is here is what a workflow module can use.
 */
export {t, type InOf, type OutOf, type TSchema} from './libraries/schema';

/**
 * A props schema as the document alone, for a `createWorkflow` that should
 * describe its props without enforcing them — see `workflow_props.ts`, which
 * owns both halves of what a declared schema means.
 */
export {describeProps} from './workflow_props';

// author-facing option types (erased at runtime; safe on the deterministic surface)
export type {
  ActivityOptions,
  ParentClosePolicy,
  RetryPolicy,
  WorkflowDescriptor,
  WorkflowPropsSchema,
  JsonSchema,
} from './protocol';
export type {
  ActivityOptionsInput,
  RetryPolicyInput,
} from './core/activity_options_input';
export type {Duration} from './libraries/walltime';

export type {ActivityProxy};

/**
 * Declare the activities a workflow calls: types the proxy from the implementations,
 * and registers them so a worker that loads this module can serve them.
 *
 * ```ts
 * import * as payments from '../activities/payments';
 * const act = proxyActivities(payments, {retry: {maximumAttempts: 3}});
 *
 * export async function order(id: string): Promise<void> {
 *   await act.charge(id);
 * }
 * ```
 *
 * ## Why it takes the implementations
 *
 * **Declaring that a workflow will call an activity is what registers it.** There is
 * no list to maintain and no order to get wrong: the entrypoint imports its
 * workflows, loading them runs these calls, and the worker ends up with exactly the
 * activities its workflows asked for. `startWorker({activities})` still works and
 * still wins on a name collision, for a worker that would rather be explicit.
 *
 * Taking only a type — `proxyActivities<typeof payments>(options)` — would do the
 * typing and nothing else, leaving the implementations to reach the worker by a
 * second, unrelated route: a flat `activities` object at the entrypoint, maintained
 * by hand. That holds up for a small artifact and stops holding up for a large
 * workflow split across helper modules, where the entrypoint must name every
 * activities module any helper touches. Nothing checks that list, and an omission
 * surfaces as an execution parking on a retrying activity rather than as a
 * configuration error.
 *
 * ## Why this is on the deterministic surface at all
 *
 * It touches host state, which nothing else exported from here does. Two things keep
 * it honest. The registration happens **once, at module load**, not during a replay —
 * this is a declaration, and calling it inside a workflow function would be a misuse
 * the same way any module-scope side effect would be. And the proxy it returns is the
 * pure forwarder `core/workflow_api` builds; nothing about a workflow's execution
 * changes.
 *
 * The wrapper is here rather than in `core/` because `core/` may import only
 * `protocol/` and must stay a pure function of history. The registry is host state,
 * so it lives outside, and this file — the seam between author code and host — is
 * where the two meet.
 *
 * ## The one thing to be careful about
 *
 * Passing implementations means binding them, and a bound implementation can be
 * called directly:
 *
 * ```ts
 * await act.charge(id);      // correct — issues a command the engine records
 * await payments.charge(id); // real I/O inside replay, on every replay
 * ```
 *
 * The second line is why `tools/boundaries.ts` permits this import **only** in the
 * shape `import * as NAME` where `NAME` is used for nothing but `proxyActivities`.
 * Reach for the namespace anywhere else in a workflow module and lint fails.
 */
export function proxyActivities<A extends object>(
  impls: A,
  options: ActivityOptionsInput = {},
): ActivityProxy<A> {
  registerActivityImpls(impls);
  // Normalized here, once, at declaration: durations become the wire's
  // milliseconds before the proxy exists, so a bad string fails at module load —
  // loudly, in the worker that would have run this — never during a replay.
  return createActivityProxy<A>(normalizeActivityOptions(options));
}

/**
 * The retry a watcher's poll gets unless its registration says otherwise. Not
 * the engine's spartan default (one attempt), because a poller that dies on
 * its first transient failure is a subscription that silently went deaf — a
 * watcher's poll should outlive a blip and fail only on a persistent problem.
 */
const WATCHER_POLL_DEFAULTS: ActivityOptionsInput = {
  retry: {
    maximumAttempts: 5,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
  },
  startToCloseTimeout: '30 seconds',
};

/** What a watcher is: a fetch, a notion of "new", and a cadence. */
export interface WatcherRegistration<T, S, Q, I> {
  /**
   * The wire name of the poller child workflow; the poll activity registers as
   * `${key}.poll`. Also the root of every subscription's child id and signal
   * name, so it must be unique across the worker, like any workflow key.
   */
  key: string;
  /**
   * The side-effecting fetch — an ordinary activity implementation. Receives
   * the differ's query (a cursor for `byCursor`, `undefined` for `byId`) and
   * the watch's `input`, so a source that can filter server-side gets to.
   */
  poll: (query: Q, input: I) => Promise<readonly T[]> | readonly T[];
  /** What counts as new — `byCursor` for streams, `byId` for entity feeds. */
  diff: Differ<T, S, Q>;
  /** Default poll cadence; a watch site may override. */
  every: Duration | number;
  /** Poll activity options. Defaults to `WATCHER_POLL_DEFAULTS`. */
  options?: ActivityOptionsInput;
}

/** Per-watch knobs; the watcher's identity (poll, diff, key) is fixed. */
export interface WatcherWatchOptions<S, I> {
  every?: Duration | number;
  /** Defaults to `'new'`: the first poll is the baseline, only later items fire. */
  start?: PollStart<S>;
  /** Names this subscription when one workflow watches the same watcher twice. */
  as?: string;
  /** Forwarded to every poll. Must be JSON-safe: it rides the child's props. */
  input?: I;
}

/** A declared watcher: `watch()` from workflow code; maps for explicit hosts. */
export interface WatcherRef<T, S, I> {
  readonly workflowName: string;
  readonly pollName: string;
  /**
   * Subscribe, from inside a workflow: claims the poller child under a
   * deterministic id and returns the async iterable of what it finds. Items
   * arriving while the workflow is busy are buffered in order.
   */
  watch(options?: WatcherWatchOptions<S, I>): WatcherHandle<T>;
  /**
   * The workflow and activity this watcher declared, for hosts that register
   * explicitly (`createLocalRuntime`, a worker that lists what it serves).
   * `startWorker` needs neither — declaring was registering.
   */
  registrations(): {
    workflows: Record<string, AnyWorkflowFn>;
    activities: Record<string, (args: never) => unknown>;
  };
}

/**
 * Declare a watcher: a poller child workflow that delivers what its `poll`
 * finds — one signal per new item — to whichever workflow opens it, consumed
 * behind an async iterable.
 *
 * ```ts
 * const issueClosed = createWatcher('gh.issueClosed', {
 *   poll: (since: number | undefined, repo: {owner: string; repo: string}) =>
 *     listClosedEvents(repo, since),
 *   diff: byCursor((e) => e.id),
 *   every: '30 seconds',
 * });
 *
 * // In a workflow:
 * const closed = issueClosed.watch({input: {owner: 'acme', repo: 'api'}});
 * const event = await closed.next(); // parks durably; wakes on the signal
 * closed.stop();
 * ```
 *
 * Like `proxyActivities` and `createWorkflow`, **declaring is registering**:
 * calling this at module scope registers the poll activity and the child
 * workflow on whatever worker loads the module. And like `proxyActivities`,
 * this is the seam where an implementation is handed across the determinism
 * boundary: `poll` is real I/O, bound here into an activity — the child's body
 * only ever sees the proxied forwarder (`patterns/watcher.ts` holds the
 * deterministic half and says what the composition guarantees).
 *
 * Two rules the wrapper cannot enforce for you: items must be
 * JSON-serializable (they ride history twice — the child's command and the
 * parent's signal), and one watch per `as` per workflow (a second open with
 * the same name replaces the first's signal handler and starves it).
 */
export function createWatcher<T, S, Q, I = undefined>(
  key: string,
  registration: Omit<WatcherRegistration<T, S, Q, I>, 'key'>,
): WatcherRef<T, S, I> {
  const {poll, diff, every, options} = registration;
  const pollName = `${key}.poll`;
  const pollImpl = (args: {query: Q; input: I}) => poll(args.query, args.input);
  const proxy = proxyActivities(
    {[pollName]: pollImpl},
    options ?? WATCHER_POLL_DEFAULTS,
  );
  const run = watcherRun<T, S, Q>(
    (query, input) =>
      proxy[pollName]({query, input: input as I}) as Promise<readonly T[]>,
    diff,
  );
  const child = createWorkflow({
    key,
    title: `${key} watcher`,
    description: `Polls and signals its parent one item at a time.`,
    run: (props: WatcherProps) => run(props),
  });
  const defaultEveryMs = toEveryMs(every);
  return {
    workflowName: key,
    pollName,
    watch: (watchOptions = {}) =>
      openWatcher<T, S, I>(key, defaultEveryMs, {
        ...(watchOptions.every !== undefined
          ? {everyMs: toEveryMs(watchOptions.every)}
          : {}),
        ...(watchOptions.start !== undefined
          ? {start: watchOptions.start}
          : {}),
        ...(watchOptions.as !== undefined ? {as: watchOptions.as} : {}),
        ...(watchOptions.input !== undefined
          ? {input: watchOptions.input}
          : {}),
      }),
    registrations: () => ({
      workflows: {[key]: child as AnyWorkflowFn},
      activities: {[pollName]: pollImpl as (args: never) => unknown},
    }),
  };
}

/** `every`, whichever spelling it arrived in, as the milliseconds props carry. */
function toEveryMs(every: Duration | number): number {
  return typeof every === 'number' ? every : durationToMs(every);
}

export type {WatcherHandle, WatcherProps} from './patterns/watcher';

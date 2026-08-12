/**
 * @fileoverview
 * The WorkflowContext is the mutable per-task state the deterministic engine
 * threads through a single replay: where we are in history, the command-id
 * counters, the parked promises, and the terminal result.
 *
 * `als` carries it into user workflow code without an explicit parameter —
 * workflow code calls a bare `runActivity(...)` and the primitive recovers the
 * context from AsyncLocalStorage. The subtle, load-bearing property: an `await`
 * continuation is bound to the context that was active **when the await
 * suspended**, not when the promise is later resolved. So when the engine
 * resolves a parked promise from *outside* the `als.run(...)` scope (in the
 * replay driver), the workflow's resumed code still re-enters with the right
 * context. That is why context is not threaded through every call — and why a
 * naive module-level global would break the instant two workflows interleave on
 * one worker.
 */

import {AsyncLocalStorage} from 'node:async_hooks';
import type {
  Carryover,
  Command,
  ExecutionParentView,
  HistoryEvent,
  SignalEvent,
} from '../protocol';

interface Waiter {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}
interface BlockedCondition {
  fn: () => boolean;
  resolve: () => void;
  reject: (e: unknown) => void;
  /**
   * Where `condition()` was called, captured unformatted.
   *
   * A pure diagnostic side-channel: it is never read by replay, never reaches a
   * command, and never influences a predicate — which is the only reason a
   * non-deterministic value is allowed anywhere near this context. See
   * `condition.ts` for why it is an `Error` rather than a string.
   *
   * Absent outside V8, where the capture API does not exist.
   */
  site?: Error;
}

/**
 * A registered workflow function. The `any[]` rest parameter is deliberate and
 * cannot be `unknown[]`: `strictFunctionTypes` makes parameters contravariant, so
 * an author's `(name: string) => Promise<string>` would not be assignable to a
 * registry of `(...args: unknown[]) => …`. Arguments arrive from history as
 * `unknown[]` and are checked by the workflow's own signature.
 */
export type WorkflowFn = (...args: any[]) => Promise<unknown>;

export interface WorkflowContext {
  args: unknown[];
  events: HistoryEvent[];
  idx: number;
  seq: number; // command id counter (activities, timers, children) — recorded in history
  condSeq: number; // condition id counter — NOT recorded; must not perturb command seqs
  /**
   * Every `seq` history already holds an event for — a marker
   * (`activityScheduled`, `timerStarted`, `childStarted`, `childCancelRequested`,
   * `workflowSignaled`) or a completion. Either one is proof that the command at that seq was
   * dispatched and made durable, so this is the set of commands replay must
   * **not** emit again. It is the whole of the suppression rule; see
   * `workflow_api.issue`.
   *
   * Derived from `events` once, up front, rather than accumulated as they are
   * applied. The question is whether history holds the seq *at all*, and a
   * workflow can reach a command before the event proving it durable has been
   * taken off the batch — which is exactly what the positional answer this
   * replaced got wrong (issue #39).
   */
  dispatchedSeqs: Set<number>;
  /**
   * The patch id recorded at each seq history holds a `patchRecorded` for — the
   * durable answers `patched` reads back.
   *
   * A refinement of `dispatchedSeqs`, not a replacement: that set answers "is this
   * seq spoken for", and this map answers "spoken for by *which* patch". `patched`
   * needs both, and needs them keyed by seq rather than by id, because the fact it
   * is recovering is which position in the command sequence the decision occupies.
   * `patch_recorded`'s own comment in `protocol/history_events.ts` owns why.
   *
   * Derived up front from `events`, alongside `dispatchedSeqs` and for the same
   * reason: a workflow can reach a `patched` call before the marker proving its
   * answer has been taken off the batch, and the answer must not depend on where
   * replay has got to.
   */
  patchesBySeq: Map<number, string>;
  commands: Command[];
  /**
   * Every command this replay issued, by seq — including the ones suppressed
   * because they are already durable. `commands` holds only what the server has
   * yet to see; this holds what the workflow *claims* about each seq, which is
   * what a marker is checked against (see `apply_event`).
   *
   * It grows with seq for the life of a run where `completions` shrinks as things
   * resolve. Bounded by history size and reset by continue-as-new, so acceptable
   * — but it is a real cost, not a free one.
   */
  requested: Map<number, Command>;
  completions: Map<number, Waiter>;
  blockedConditions: Map<number, BlockedCondition>;
  signalHandlers: Map<string, (payload: unknown) => void>;
  bufferedSignals: SignalEvent[];
  done: boolean;
  result: unknown;
  failed: boolean;
  failure: unknown;
  /** Set once a cancelRequested event is applied; new operations reject immediately. */
  cancelled: boolean;
  /** Server-provided hint: history has grown enough to consider continue-as-new. */
  continueAsNewSuggested: boolean;
  /**
   * Which execution started this one, when one did.
   *
   * A server-provided fact about the execution, in the same family as `args`:
   * fixed for its whole life, carried on the task, and read through
   * `workflowInfo`. It is what lets a child address its parent — `signalWorkflow`
   * takes an id, and a child otherwise has no way to learn one it was not handed
   * as an argument.
   *
   * Survives continue-as-new, unlike everything derived from history: a rollover
   * is a new run of the same execution, and its parentage does not change.
   */
  parent?: ExecutionParentView;
  /**
   * What this **run** started with. Constant for the whole run: every task of it
   * is built from the same value, so a read cannot vary between replays. That is
   * what lets workflow code branch on carryover without breaking determinism —
   * see `carryover.ts`.
   */
  carryover: Carryover;
  /**
   * What the *next* run should start with: this run's writes, applied on top of
   * the seed. Reported at the end of every task and adopted at continue-as-new.
   *
   * Separate from `carryover` because they are read at different times. Folding
   * them into one field is the bug this pair exists to prevent: a write would
   * become visible to a later task of the same run, the commands that task
   * issues would depend on it, and replay would diverge from history.
   */
  carryoverNext: Carryover;
}

// ── context propagation ────────────────────────────────────────────────
export const als = new AsyncLocalStorage<WorkflowContext>();

export function getContext(): WorkflowContext {
  const ctx = als.getStore();
  if (!ctx) throw new Error('workflow API called outside a workflow context');
  return ctx;
}

/**
 * The seqs history accounts for. Signals and `cancelRequested` are external and
 * carry none, so they contribute nothing — which is the point: they are the
 * events that can appear in a batch *after* the one that moves the workflow on.
 */
function seqsInHistory(events: HistoryEvent[]): Set<number> {
  const seqs = new Set<number>();
  for (const ev of events) if ('seq' in ev) seqs.add(ev.seq);
  return seqs;
}

/** The version decisions history already holds, by the seq each was made at. */
function patchesInHistory(events: HistoryEvent[]): Map<number, string> {
  const patches = new Map<number, string>();
  for (const ev of events)
    if (ev.type === 'patchRecorded') patches.set(ev.seq, ev.patchId);
  return patches;
}

/**
 * `parent` is optional where `carryover` is required, and the difference is what
 * a caller that forgets it gets. A missing carryover starts the workflow from
 * empty state, which is indistinguishable from a workflow that wrote none —
 * silent. A missing parent makes `workflowInfo().parent` undefined, which any
 * code that needs it must already handle, because a root execution has none.
 */
export function createContext(
  args: unknown[],
  events: HistoryEvent[],
  continueAsNewSuggested = false,
  carryover: Carryover = {},
  parent?: ExecutionParentView,
): WorkflowContext {
  return {
    args,
    events,
    // Both copied, not aliased: the task's carryover belongs to the caller, and
    // a replay that mutated it in place would leave the caller's copy holding
    // the *result* of the replay it was supposed to be the input to.
    carryover: {...carryover},
    carryoverNext: {...carryover},
    idx: 0,
    seq: 0,
    condSeq: 0,
    dispatchedSeqs: seqsInHistory(events),
    patchesBySeq: patchesInHistory(events),
    commands: [],
    requested: new Map(),
    completions: new Map(),
    blockedConditions: new Map(),
    signalHandlers: new Map(),
    bufferedSignals: [],
    done: false,
    result: undefined,
    failed: false,
    failure: undefined,
    cancelled: false,
    continueAsNewSuggested,
    parent,
  };
}

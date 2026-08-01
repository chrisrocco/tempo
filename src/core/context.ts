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

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Command, HistoryEvent, SignalEvent } from '../protocol';

interface Waiter {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}
interface BlockedCondition {
  fn: () => boolean;
  resolve: () => void;
  reject: (e: unknown) => void;
}

export type WorkflowFn = (...args: any[]) => Promise<unknown>;

export interface WorkflowContext {
  args: unknown[];
  events: HistoryEvent[];
  idx: number;
  seq: number; // command id counter (activities, timers, children) — recorded in history
  condSeq: number; // condition id counter — NOT recorded; must not perturb command seqs
  isLive: boolean;
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
}

// ── context propagation ────────────────────────────────────────────────
export const als = new AsyncLocalStorage<WorkflowContext>();

export function getContext(): WorkflowContext {
  const ctx = als.getStore();
  if (!ctx) throw new Error('workflow API called outside a workflow context');
  return ctx;
}

export function createContext(
  args: unknown[],
  events: HistoryEvent[],
  continueAsNewSuggested = false,
): WorkflowContext {
  return {
    args,
    events,
    idx: 0,
    seq: 0,
    condSeq: 0,
    isLive: events.length === 0,
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
  };
}

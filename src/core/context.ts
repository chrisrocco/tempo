/**
 * @fileoverview
 * The WorkflowContext is the mutable per-task state the deterministic engine
 * threads through a single replay: where we are in history, the command-id
 * counters, the parked promises, and the terminal result. `als` carries it into
 * user workflow code without an explicit parameter (see docs/concepts/replay-and-execution.md, the ALS caveat).
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

export const getContext = (): WorkflowContext => {
  const ctx = als.getStore();
  if (!ctx) throw new Error('workflow API called outside a workflow context');
  return ctx;
};

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

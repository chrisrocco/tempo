// The port the server persists executions through. In-memory today (the map from
// the old runtime, promoted to an interface); a database with real optimistic
// concurrency is the Phase-4 swap. `version` is carried now for interface
// stability, but under single-process `pump` serialization it never actually
// conflicts — enforcing it as the distributed replacement for `pump` is Phase 5.
import type { ExecutionStatus, HistoryEvent } from '../../protocol';

/** One execution's durable state: its identity, history, and terminal outcome. */
export interface ExecutionRecord {
  workflowId: string;
  /** Increments on each continue-as-new; the workflowId stays stable across runs. */
  runId: number;
  name: string;
  args: unknown[];
  history: HistoryEvent[];
  version: number;
  status: ExecutionStatus;
  result?: unknown;
  failure?: unknown;
}

export interface HistoryStore {
  /** Register a fresh execution. Throws if the id already exists. */
  create(workflowId: string, name: string, args: unknown[]): void;
  /** The live record, or undefined if unknown. */
  get(workflowId: string): ExecutionRecord | undefined;
  /**
   * Append events, conditional on `expectedVersion` matching the current version
   * (optimistic concurrency). Returns the new version; throws on mismatch.
   */
  append(workflowId: string, events: HistoryEvent[], expectedVersion: number): number;
  /** Record the terminal outcome once a workflow task settles the execution. */
  setStatus(
    workflowId: string,
    status: ExecutionStatus,
    outcome?: { result?: unknown; failure?: unknown },
  ): void;
  /**
   * Continue-as-new: close the current run and begin a fresh one on the SAME
   * workflowId — empty history seeded with `args`, bumped runId, version reset,
   * status stays 'running'. Not a real close, so the result waiter is untouched.
   */
  resetForContinueAsNew(workflowId: string, args: unknown[]): void;
}

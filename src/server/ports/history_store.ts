// The port the server persists executions through. Async, so a filesystem/db
// adapter (Phase 4) slots in unchanged. `append` is atomic per call and the
// adapter owns the version bump — under a single writer (drives serialized by
// pump, external writes serialized by the adapter) that is sufficient. `version`
// is retained on the record for the Phase-5 optimistic-CAS check, which is where
// concurrent workers make it meaningful.
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

/** Thrown by `appendIfVersion` when the execution has moved on — a lost lease race. */
export class VersionConflictError extends Error {
  constructor(workflowId: string, expected: number, actual: number) {
    super(`version conflict on ${workflowId}: expected ${expected}, have ${actual}`);
    this.name = 'VersionConflictError';
    Object.setPrototypeOf(this, VersionConflictError.prototype);
  }
}

export interface HistoryStore {
  /** Register a fresh execution. Rejects if the id already exists. */
  create(workflowId: string, name: string, args: unknown[]): Promise<void>;
  /** A snapshot of the record, or undefined if unknown. */
  get(workflowId: string): Promise<ExecutionRecord | undefined>;
  /** Every execution — used by the resume driver on boot to re-drive running ones. */
  list(): Promise<ExecutionRecord[]>;
  /** Append events atomically and bump the version. Rejects if the id is unknown. */
  append(workflowId: string, events: HistoryEvent[]): Promise<void>;
  /**
   * Append conditional on `expectedVersion` matching the current version
   * (optimistic concurrency) — throws VersionConflictError otherwise. The
   * distributed replacement for the single-writer assumption: two workers racing
   * the same task both hold the same expected version, and only the first append
   * lands (doc 06). Safe to reject the loser because replay commits no effects.
   */
  appendIfVersion(workflowId: string, events: HistoryEvent[], expectedVersion: number): Promise<void>;
  /** Record the terminal outcome once a workflow task settles the execution. */
  setStatus(
    workflowId: string,
    status: ExecutionStatus,
    outcome?: { result?: unknown; failure?: unknown },
  ): Promise<void>;
  /**
   * Continue-as-new: close the current run and begin a fresh one on the SAME
   * workflowId — empty history seeded with `args`, bumped runId, version reset,
   * status stays 'running'. Not a real close, so the result waiter is untouched.
   */
  resetForContinueAsNew(workflowId: string, args: unknown[]): Promise<void>;
}

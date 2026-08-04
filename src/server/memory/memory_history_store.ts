/**
 * @fileoverview
 * In-memory HistoryStore: a Map of execution records. This is the old runtime's
 * `executions` map, promoted behind the async port. The methods are async to
 * satisfy the interface, but their bodies are synchronous (Map access), so each
 * is atomic — a filesystem/db adapter is the Phase-4 swap and serializes its own
 * writes. Powers LocalService and the fast test path.
 */

import {
  DEFAULT_TASK_QUEUE,
  type Carryover,
  type ExecutionStatus,
  type HistoryEvent,
} from '../../protocol';
import type {ExecutionRecord, HistoryStore} from '../ports/history_store';
import {VersionConflictError} from '../ports/history_store';

export class MemoryHistoryStore implements HistoryStore {
  private readonly records = new Map<string, ExecutionRecord>();

  async create(
    workflowId: string,
    name: string,
    args: unknown[],
    taskQueue: string = DEFAULT_TASK_QUEUE,
  ): Promise<void> {
    if (this.records.has(workflowId))
      throw new Error(`execution ${workflowId} already exists`);
    this.records.set(workflowId, {
      workflowId,
      runId: 0,
      name,
      args,
      taskQueue,
      createdAt: Date.now(),
      history: [],
      version: 0,
      status: 'running',
      carryover: {},
      taskFailures: 0,
      activityAttempts: {},
    });
  }

  async get(workflowId: string): Promise<ExecutionRecord | undefined> {
    return this.records.get(workflowId);
  }

  async list(): Promise<ExecutionRecord[]> {
    return [...this.records.values()];
  }

  async append(workflowId: string, events: HistoryEvent[]): Promise<void> {
    const rec = this.records.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.history.push(...events);
    rec.version += 1;
  }

  async appendIfVersion(
    workflowId: string,
    events: HistoryEvent[],
    expectedVersion: number,
  ): Promise<void> {
    const rec = this.records.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    if (rec.version !== expectedVersion)
      throw new VersionConflictError(workflowId, expectedVersion, rec.version);
    rec.history.push(...events);
    rec.version += 1;
  }

  // Note the absent `version` bump: a task failure is not history, and bumping
  // would make a racing worker's successful completion lose the CAS.
  async recordTaskFailure(workflowId: string, reason: string): Promise<number> {
    const rec = this.records.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.taskFailures += 1;
    rec.lastTaskFailure = reason;
    return rec.taskFailures;
  }

  async clearTaskFailures(workflowId: string): Promise<void> {
    const rec = this.records.get(workflowId);
    if (!rec || rec.taskFailures === 0) return;
    rec.taskFailures = 0;
    rec.lastTaskFailure = undefined;
  }

  async recordActivityAttempt(
    workflowId: string,
    seq: number,
  ): Promise<number> {
    const rec = this.records.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    const attempts = (rec.activityAttempts[seq] ?? 0) + 1;
    rec.activityAttempts[seq] = attempts;
    return attempts;
  }

  async clearActivityAttempts(workflowId: string, seq: number): Promise<void> {
    const rec = this.records.get(workflowId);
    if (!rec) return;
    delete rec.activityAttempts[seq];
  }

  async setCarryover(workflowId: string, carryover: Carryover): Promise<void> {
    const rec = this.records.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.carryover = {...carryover};
  }

  async setStatus(
    workflowId: string,
    status: ExecutionStatus,
    outcome?: {result?: unknown; failure?: unknown; failureStack?: string},
  ): Promise<void> {
    const rec = this.records.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.status = status;
    if (outcome && 'result' in outcome) rec.result = outcome.result;
    if (outcome && 'failure' in outcome) rec.failure = outcome.failure;
    if (outcome && 'failureStack' in outcome)
      rec.failureStack = outcome.failureStack;
  }

  async resetForContinueAsNew(
    workflowId: string,
    args: unknown[],
  ): Promise<void> {
    const rec = this.records.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.history = [];
    rec.args = args;
    rec.version = 0;
    rec.runId += 1;
    // status stays 'running'; result/failure remain unset — this is not a close.
    // `carryover` is deliberately untouched: surviving this reset is the entire
    // point of it. Clearing it here would silently break every helper that keeps
    // a cursor, and the symptom would be a poller starting over from nothing.
  }
}

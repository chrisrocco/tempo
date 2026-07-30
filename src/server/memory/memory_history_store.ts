/**
 * @fileoverview
 * In-memory HistoryStore: a Map of execution records. This is the old runtime's
 * `executions` map, promoted behind the async port. The methods are async to
 * satisfy the interface, but their bodies are synchronous (Map access), so each
 * is atomic — a filesystem/db adapter is the Phase-4 swap and serializes its own
 * writes. Powers LocalService and the fast test path.
 */

import type { ExecutionStatus, HistoryEvent } from '../../protocol';
import type { ExecutionRecord, HistoryStore } from '../ports/history_store';
import { VersionConflictError } from '../ports/history_store';

export class MemoryHistoryStore implements HistoryStore {
  private readonly records = new Map<string, ExecutionRecord>();

  async create(workflowId: string, name: string, args: unknown[]): Promise<void> {
    if (this.records.has(workflowId)) throw new Error(`execution ${workflowId} already exists`);
    this.records.set(workflowId, {
      workflowId, runId: 0, name, args, history: [], version: 0, status: 'running',
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

  async appendIfVersion(workflowId: string, events: HistoryEvent[], expectedVersion: number): Promise<void> {
    const rec = this.records.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    if (rec.version !== expectedVersion) throw new VersionConflictError(workflowId, expectedVersion, rec.version);
    rec.history.push(...events);
    rec.version += 1;
  }

  async setStatus(
    workflowId: string,
    status: ExecutionStatus,
    outcome?: { result?: unknown; failure?: unknown },
  ): Promise<void> {
    const rec = this.records.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.status = status;
    if (outcome && 'result' in outcome) rec.result = outcome.result;
    if (outcome && 'failure' in outcome) rec.failure = outcome.failure;
  }

  async resetForContinueAsNew(workflowId: string, args: unknown[]): Promise<void> {
    const rec = this.records.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.history = [];
    rec.args = args;
    rec.version = 0;
    rec.runId += 1;
    // status stays 'running'; result/failure remain unset — this is not a close.
  }
}

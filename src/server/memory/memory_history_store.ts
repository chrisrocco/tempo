// In-memory HistoryStore: a Map of execution records. This is the old runtime's
// `executions` map, promoted behind the port. Powers LocalService and the fast
// test path; the durable adapter is the Phase-4 swap.
import type { ExecutionStatus, HistoryEvent } from '../../protocol';
import type { ExecutionRecord, HistoryStore } from '../ports/history_store';

export class MemoryHistoryStore implements HistoryStore {
  private readonly records = new Map<string, ExecutionRecord>();

  create(workflowId: string, name: string, args: unknown[]): void {
    if (this.records.has(workflowId)) throw new Error(`execution ${workflowId} already exists`);
    this.records.set(workflowId, {
      workflowId, runId: 0, name, args, history: [], version: 0, status: 'running',
    });
  }

  get(workflowId: string): ExecutionRecord | undefined {
    return this.records.get(workflowId);
  }

  append(workflowId: string, events: HistoryEvent[], expectedVersion: number): number {
    const rec = this.records.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    if (rec.version !== expectedVersion) {
      throw new Error(`version conflict on ${workflowId}: expected ${expectedVersion}, have ${rec.version}`);
    }
    rec.history.push(...events);
    rec.version += 1;
    return rec.version;
  }

  setStatus(
    workflowId: string,
    status: ExecutionStatus,
    outcome?: { result?: unknown; failure?: unknown },
  ): void {
    const rec = this.records.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.status = status;
    if (outcome && 'result' in outcome) rec.result = outcome.result;
    if (outcome && 'failure' in outcome) rec.failure = outcome.failure;
  }

  resetForContinueAsNew(workflowId: string, args: unknown[]): void {
    const rec = this.records.get(workflowId);
    if (!rec) throw new Error(`no execution ${workflowId}`);
    rec.history = [];
    rec.args = args;
    rec.version = 0;
    rec.runId += 1;
    // status stays 'running'; result/failure remain unset — this is not a close.
  }
}

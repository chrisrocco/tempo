/**
 * @fileoverview
 * The client: turns the flat `WorkflowService` surface into ergonomic handles
 * (start -> a handle with result()/status()/signal()). Written once against the
 * service seam, so it is identical for local and remote. The `SignalDef`
 * convenience (accepting a defined signal or a bare name) lives here rather than
 * in `protocol`, keeping the wire contract free of any `core` dependency.
 */

import type { ExecutionStatus, WorkflowService } from '../protocol';
import type { SignalDef } from '../core';

export interface WorkflowHandle<T = unknown> {
  workflowId: string;
  result(): Promise<T>;
  status(): ExecutionStatus;
  signal(signalDef: SignalDef | string, payload?: unknown): void;
  /**
   * Ask the workflow to unwind. Cooperative: it is delivered through replay, so
   * the workflow catches `CancelledFailure` and can clean up — and so it cannot
   * reach an execution whose replay is itself failing. Use `terminate` for that.
   */
  cancel(): void;
  /**
   * End the execution outright, running no workflow code. `result()` rejects with
   * the reason. The blunt instrument, for when cancel cannot land.
   */
  terminate(reason?: string): void;
}

export interface Client {
  start<T = unknown>(
    name: string,
    args?: unknown[],
    opts?: { workflowId?: string },
  ): WorkflowHandle<T>;
  /** A handle to an existing execution (e.g. one picked up by resume). */
  getHandle<T = unknown>(workflowId: string): WorkflowHandle<T>;
}

export function createClient(service: WorkflowService): Client {
  function handle<T>(workflowId: string): WorkflowHandle<T> {
    return {
      workflowId,
      result: () => service.getResult(workflowId) as Promise<T>,
      status: () => service.getStatus(workflowId),
      signal: (signalDef, payload) =>
        service.signal(
          workflowId,
          typeof signalDef === 'string' ? signalDef : signalDef.name,
          payload,
        ),
      cancel: () => service.cancel(workflowId),
      terminate: (reason = 'terminated by operator') =>
        service.terminate(workflowId, reason),
    };
  }

  return {
    start<T = unknown>(
      name: string,
      args: unknown[] = [],
      opts: { workflowId?: string } = {},
    ): WorkflowHandle<T> {
      const { workflowId } = service.start(name, args, opts);
      return handle<T>(workflowId);
    },
    getHandle<T = unknown>(workflowId: string): WorkflowHandle<T> {
      return handle<T>(workflowId);
    },
  };
}

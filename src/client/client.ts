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
  cancel(): void;
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
  const handle = <T>(workflowId: string): WorkflowHandle<T> => ({
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
  });

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

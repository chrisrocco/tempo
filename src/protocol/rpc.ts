/**
 * @fileoverview
 * The networked transport's wire format: one request envelope per service method,
 * and a generic response envelope. This is what `RemoteService` (client) sends and
 * the RPC server dispatches to a server host. Pure data, like the rest of protocol.
 */

import type {
  DescribeOptions,
  ExecutionFilter,
  ActivityResult,
  ExecutionStatus,
  StartWorkflowOptions,
  WorkflowTaskResult,
} from './service';
import type {TaskToken} from './task_token';

/** The client-visible outcome of an execution — how a failure crosses the wire (as a message). */
export interface WorkflowOutcome {
  status: ExecutionStatus;
  result?: unknown;
  failure?: string;
  /** The stack behind `failure`, so a waiting client can print more than a message. */
  failureStack?: string;
}

export type RpcRequest =
  | {
      method: 'start';
      name: string;
      args: unknown[];
      opts: StartWorkflowOptions;
    }
  | {
      method: 'signal';
      workflowId: string;
      signalName: string;
      payload: unknown;
    }
  | {method: 'cancel'; workflowId: string}
  | {method: 'terminate'; workflowId: string; reason: string}
  | {method: 'reset'; workflowId: string; keep: number}
  | {method: 'getOutcome'; workflowId: string}
  | {
      method: 'describeExecution';
      workflowId: string;
      options?: DescribeOptions;
    }
  | {method: 'listExecutions'; filter?: ExecutionFilter}
  | {method: 'listQueues'}
  | {method: 'groupExecutions'}
  | {method: 'pollWorkflowTask'; taskQueue?: string}
  | {
      method: 'completeWorkflowTask';
      token: TaskToken;
      result: WorkflowTaskResult;
    }
  | {method: 'failWorkflowTask'; token: TaskToken; reason: string}
  | {method: 'heartbeatActivityTask'; token: TaskToken}
  | {method: 'pollActivityTask'; taskQueue?: string}
  | {
      method: 'completeActivityTask';
      token: TaskToken;
      result: ActivityResult;
    };

export type RpcResponse =
  {ok: true; value: unknown} | {ok: false; error: string};

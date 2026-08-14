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
  WorkflowReportRequest,
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
  | {method: 'listWorkflows'}
  | {method: 'reportWorkflows'; report: WorkflowReportRequest}
  | {method: 'groupExecutions'}
  // Liveness plus what is already in memory. Reaching a server is what the
  // reply proves; see `ServerHealth` for why there is no `ok` field in it.
  | {method: 'health'}
  // `identity` names the polling worker; see `WorkerInfo`. Absent from a client
  // that does not identify itself, which still gets tasks.
  | {
      method: 'pollWorkflowTask';
      taskQueue?: string;
      identity?: string;
      servesHash?: string;
    }
  | {
      method: 'completeWorkflowTask';
      token: TaskToken;
      result: WorkflowTaskResult;
    }
  | {method: 'failWorkflowTask'; token: TaskToken; reason: string}
  | {method: 'heartbeatActivityTask'; token: TaskToken}
  | {
      method: 'pollActivityTask';
      taskQueue?: string;
      identity?: string;
      servesHash?: string;
    }
  | {
      method: 'completeActivityTask';
      token: TaskToken;
      result: ActivityResult;
    };

export type RpcResponse =
  {ok: true; value: unknown} | {ok: false; error: string};

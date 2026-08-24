/**
 * @fileoverview
 * The RPC method switch, with no transport attached.
 *
 * Separated from `rpc_server.ts` because the switch is the *protocol* and HTTP
 * is only one way to carry it. An in-process caller — a browser hosting the
 * whole engine in a Web Worker, a test reaching past the socket — dispatches
 * the same `RpcRequest` against the same `ServerHost` and gets the same answer,
 * rather than hand-copying a switch that would then drift. Two clients must not
 * answer the same question differently; this is the file that makes that
 * structural rather than aspirational.
 *
 * Nothing here touches Node: no builtins, no sockets. `rpc_server.ts` owns the
 * HTTP envelope — reading the body, shaping `RpcResponse`, status codes.
 */

import type {RpcRequest} from '../protocol';
import type {ServerHost} from './server_host';

/**
 * The compile-time half of the switch below: `request` narrows to `never` once
 * every method is handled, so adding a case to `RpcRequest` without handling it
 * here is a type error rather than a silent `null` on the wire. The throw is the
 * runtime half, for a client sending a method this server does not know.
 */
function assertNever(request: never): never {
  throw new Error(
    `unknown RPC method: ${JSON.stringify((request as {method?: unknown}).method)}`,
  );
}

export async function dispatch(
  host: ServerHost,
  request: RpcRequest,
): Promise<unknown> {
  switch (request.method) {
    case 'start':
      return host.start(request.name, request.props, request.opts);
    case 'signal':
      return host.signal(
        request.workflowId,
        request.signalName,
        request.payload,
      );
    case 'cancel':
      return host.cancel(request.workflowId);
    case 'terminate':
      return host.terminate(request.workflowId, request.reason);
    case 'reset':
      return host.reset(request.workflowId, request.keep);
    case 'getOutcome':
      return host.getOutcome(request.workflowId);
    case 'describeExecution':
      // undefined (unknown id) must cross as JSON null, like a polled task.
      return (
        (await host.describeExecution(request.workflowId, request.options)) ??
        null
      );
    case 'listExecutions':
      return host.listExecutions(request.filter);
    case 'listWorkflows':
      return host.listWorkflows();
    case 'reportWorkflows':
      return host.reportWorkflows(request.report);
    case 'listQueues':
      return host.listQueues();
    case 'groupExecutions':
      return host.groupExecutions();
    case 'health':
      return host.health();
    case 'pollWorkflowTask':
      return (
        (await host.pollWorkflowTask({
          taskQueue: request.taskQueue,
          identity: request.identity,
          servesHash: request.servesHash,
        })) ?? null
      );
    case 'completeWorkflowTask':
      return host.completeWorkflowTask(request.token, request.result);
    case 'failWorkflowTask':
      return host.failWorkflowTask(request.token, request.reason);
    case 'pollActivityTask':
      return (
        (await host.pollActivityTask({
          taskQueue: request.taskQueue,
          identity: request.identity,
          servesHash: request.servesHash,
        })) ?? null
      );
    case 'completeActivityTask':
      return host.completeActivityTask(request.token, request.result);
    case 'heartbeatActivityTask':
      return host.heartbeatActivityTask(request.token, request.checkpoint);
    default:
      return assertNever(request);
  }
}

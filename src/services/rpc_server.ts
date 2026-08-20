/**
 * @fileoverview
 * The HTTP+JSON transport, server side: one POST endpoint that decodes an
 * RpcRequest, dispatches it to a ServerHost, and returns an RpcResponse. A
 * polled task that came back `undefined` is sent as JSON `null` (undefined is not
 * valid JSON); the client maps it back. `bin/server-main` wraps this in a process.
 *
 * **One endpoint, and nothing else.** An operator UI is a client like any other:
 * it reaches this over the same RPC, and that is the only interface it needs.
 * Serving one from here instead would put a TypeScript transpiler, an import-map
 * generator, and a static file server inside the engine, for the benefit of a
 * browser app that imports the engine back.
 *
 * **There is no auth and no TLS on this transport** — it is plain HTTP+JSON.
 * `bin/server-main` binds loopback for that reason. Expose it only on loopback or
 * a trusted private network; never put the port on the public internet. Anything
 * that can reach this port can terminate any execution.
 */

import * as http from 'node:http';
import type {RpcRequest, RpcResponse} from '../protocol';
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

async function dispatch(
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

export function createRpcServer(host: ServerHost): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      let response: RpcResponse;
      try {
        const value = await dispatch(host, JSON.parse(body) as RpcRequest);
        response = {ok: true, value: value ?? null};
      } catch (e) {
        response = {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(response));
    });
  });
}

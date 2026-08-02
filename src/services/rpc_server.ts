/**
 * @fileoverview
 * The HTTP+JSON transport, server side: one POST endpoint that decodes an
 * RpcRequest, dispatches it to a ServerHost, and returns an RpcResponse. A
 * polled task that came back `undefined` is sent as JSON `null` (undefined is not
 * valid JSON); the client maps it back. `bin/server-main` wraps this in a process.
 *
 * **There is no auth and no TLS on this transport** — it is plain HTTP+JSON.
 * `bin/server-main` binds loopback for that reason. Expose it only on loopback or
 * a trusted private network; never put the port on the public internet.
 */

import * as http from 'node:http';
import type { RpcRequest, RpcResponse } from '../protocol';
import type { ServerHost } from './server_host';

/**
 * The compile-time half of the switch below: `request` narrows to `never` once
 * every method is handled, so adding a case to `RpcRequest` without handling it
 * here is a type error rather than a silent `null` on the wire. The throw is the
 * runtime half, for a client sending a method this server does not know.
 */
function assertNever(request: never): never {
  throw new Error(
    `unknown RPC method: ${JSON.stringify((request as { method?: unknown }).method)}`,
  );
}

async function dispatch(
  host: ServerHost,
  request: RpcRequest,
): Promise<unknown> {
  switch (request.method) {
    case 'start':
      return host.start(request.name, request.args, request.opts);
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
    case 'getOutcome':
      return host.getOutcome(request.workflowId);
    case 'describeExecution':
      // undefined (unknown id) must cross as JSON null, like a polled task.
      return (await host.describeExecution(request.workflowId)) ?? null;
    case 'listExecutions':
      return host.listExecutions();
    case 'pollWorkflowTask':
      return (await host.pollWorkflowTask()) ?? null;
    case 'completeWorkflowTask':
      return host.completeWorkflowTask(request.token, request.result);
    case 'failWorkflowTask':
      return host.failWorkflowTask(request.token, request.reason);
    case 'pollActivityTask':
      return (await host.pollActivityTask()) ?? null;
    case 'completeActivityTask':
      return host.completeActivityTask(request.token, request.result);
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
        response = { ok: true, value: value ?? null };
      } catch (e) {
        response = {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });
}

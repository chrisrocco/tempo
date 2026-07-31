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
    case 'getOutcome':
      return host.getOutcome(request.workflowId);
    case 'pollWorkflowTask':
      return (await host.pollWorkflowTask()) ?? null;
    case 'completeWorkflowTask':
      return host.completeWorkflowTask(request.token, request.result);
    case 'pollActivityTask':
      return (await host.pollActivityTask()) ?? null;
    case 'completeActivityTask':
      return host.completeActivityTask(request.token, request.result);
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

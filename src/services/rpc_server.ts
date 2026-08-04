/**
 * @fileoverview
 * The HTTP+JSON transport, server side: one POST endpoint that decodes an
 * RpcRequest, dispatches it to a ServerHost, and returns an RpcResponse. A
 * polled task that came back `undefined` is sent as JSON `null` (undefined is not
 * valid JSON); the client maps it back. `bin/server-main` wraps this in a process.
 *
 * It also serves the dashboard at `/ui`, when given a place to serve it from —
 * see `ui_server.ts`. Deliberately the same listener: same origin means the
 * browser can call the RPC with no CORS, and an operator has one port to reach
 * rather than two to keep in step.
 *
 * **There is no auth and no TLS on this transport** — it is plain HTTP+JSON.
 * `bin/server-main` binds loopback for that reason. Expose it only on loopback or
 * a trusted private network; never put the port on the public internet. Serving
 * a UI does not change that and makes it easier to forget: the dashboard can
 * terminate executions, so anything that can load it can too.
 */

import * as http from 'node:http';
import type {RpcRequest, RpcResponse} from '../protocol';
import type {ServerHost} from './server_host';
import {createUiServer, type UiServerOptions} from './ui_server';

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
      return (
        (await host.describeExecution(request.workflowId, request.options)) ??
        null
      );
    case 'listExecutions':
      return host.listExecutions(request.filter);
    case 'listQueues':
      return host.listQueues();
    case 'pollWorkflowTask':
      return (await host.pollWorkflowTask(request.taskQueue)) ?? null;
    case 'completeWorkflowTask':
      return host.completeWorkflowTask(request.token, request.result);
    case 'failWorkflowTask':
      return host.failWorkflowTask(request.token, request.reason);
    case 'pollActivityTask':
      return (await host.pollActivityTask(request.taskQueue)) ?? null;
    case 'completeActivityTask':
      return host.completeActivityTask(request.token, request.result);
    case 'heartbeatActivityTask':
      return host.heartbeatActivityTask(request.token);
    default:
      return assertNever(request);
  }
}

export interface RpcServerOptions {
  /**
   * Serve the dashboard from here. Omitted means no `/ui` — the server stays
   * exactly what it was, which is what the integration specs and any
   * headless deployment want.
   */
  ui?: UiServerOptions;
}

export function createRpcServer(
  host: ServerHost,
  options: RpcServerOptions = {},
): http.Server {
  const ui = options.ui ? createUiServer(options.ui) : undefined;

  return http.createServer((req, res) => {
    // The UI is GET-only and answered before the body is read: an RPC request
    // is a POST with a JSON body, and waiting for a body that a browser
    // navigation will never send would hang the page load.
    if (ui && req.method === 'GET') {
      const served = ui.handle(req.url ?? '/', {
        send: (status, headers, payload) => {
          res.writeHead(status, headers);
          res.end(payload);
        },
      });
      if (served) return;
    }

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

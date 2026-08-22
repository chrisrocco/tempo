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
 * The method switch itself lives in `dispatch.ts`, transport-free, so an
 * in-process host can serve the same protocol without a socket. This file is
 * the HTTP envelope around it.
 *
 * **There is no auth and no TLS on this transport** — it is plain HTTP+JSON.
 * `bin/server-main` binds loopback for that reason. Expose it only on loopback or
 * a trusted private network; never put the port on the public internet. Anything
 * that can reach this port can terminate any execution.
 */

import * as http from 'node:http';
import type {RpcRequest, RpcResponse} from '../protocol';
import {dispatch} from './dispatch';
import type {ServerHost} from './server_host';

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

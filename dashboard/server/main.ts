/**
 * @fileoverview
 * The dashboard process: serve the app, forward its RPC calls, and say where it
 * is listening.
 *
 * Deliberately its own process rather than a mode of the engine's. `tempo up`
 * is already a supervisor of a server and a worker, so a third child is the
 * shape it already has — and keeping it separate is what lets the engine ship
 * with no runtime dependencies at all.
 *
 * ## Routing, which is two rules
 *
 * `POST /` is an RPC call and goes upstream. Everything else is a file. That
 * split is why the browser code needed no changes when the dashboard stopped
 * being served by the engine: the app already posted to `/`, and `/` is still
 * where its RPC lives — it just terminates here now and continues on.
 *
 * ## Configuration
 *
 * | env           | default                 | what it is                  |
 * | ------------- | ----------------------- | --------------------------- |
 * | `PORT`        | 0 (any free port)       | what this listens on        |
 * | `HOST`        | 127.0.0.1               | the interface it binds      |
 * | `ENGINE_URL`  | http://127.0.0.1:7233   | the engine's RPC endpoint   |
 *
 * The default bind is loopback because this can terminate executions and
 * nothing here asks who is calling. See the note in `rpc_proxy.ts`.
 *
 * `LISTENING <port> <host>` is printed on a line of its own so a supervisor can
 * wait for readiness rather than guess at it — the same contract the engine's
 * own entrypoint uses.
 */

import * as http from 'node:http';
import * as path from 'node:path';
import {createStaticServer} from './static_server';
import {proxyRpc} from './rpc_proxy';

const DEFAULT_ENGINE_URL = 'http://127.0.0.1:7233';

// `__dirname`, which is this file's own directory — so `npm start -w
// @tempo/dashboard` works from anywhere in the tree, and so does a process
// spawned with any working directory.
//
// It used to be `process.argv[1]`, which is the *entry* script rather than this
// module: correct only while this file is the entry, and silently wrong the
// first time something imported it. That reading of argv was a workaround for
// `import.meta` being banned (tools/style.ts) with no `__dirname` to fall back
// on. The package is CommonJS now, so there is one.
const packageRoot = path.resolve(__dirname, '..');

// The build output, not the sources: `app/` holds TypeScript the browser never
// sees. `npm run build -w @tempo/dashboard` puts `index.html` and the bundle
// here, and a server started without that having run answers 404 for the
// bundle — which is a clearer failure than one that refuses to start.
const appRoot = path.join(packageRoot, 'dist');
const engineUrl = process.env['ENGINE_URL'] ?? DEFAULT_ENGINE_URL;
const port = Number(process.env['PORT'] ?? 0);
const host = process.env['HOST'] ?? '127.0.0.1';

const files = createStaticServer({appRoot});

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    // Fire-and-forget: `proxyRpc` reports its own failures into the response
    // and never rejects, so there is nothing here to await or handle.
    void proxyRpc(req, res, engineUrl);
    return;
  }

  const served = files.handle(req.url ?? '/', {
    send: (status, headers, body) => {
      res.writeHead(status, headers);
      res.end(body);
    },
  });
  if (!served) {
    res.writeHead(404, {'content-type': 'text/html; charset=utf-8'});
    res.end('not found');
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  process.stdout.write(`LISTENING ${bound} ${host}\n`);
  process.stdout.write(`dashboard: http://${host}:${bound}\n`);
  process.stdout.write(`dashboard: engine at ${engineUrl}\n`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

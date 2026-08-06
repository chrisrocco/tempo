/**
 * @fileoverview
 * Handing the dashboard's built code to a browser. Reads files, sets a content
 * type, refuses anything that escapes the root — and nothing else.
 *
 * ## What is deliberately absent
 *
 * This module used to compile TypeScript per request with `ts.transpileModule`,
 * generate an import map from installed packages, and resolve two flavours of
 * missing extension. All of that existed to stand in for a build step, and it
 * put **the TypeScript compiler in the dashboard's runtime dependencies** — a
 * server that cannot start without a compiler it never needed at runtime.
 *
 * The build now happens ahead of time (`npm run build -w @tempo/dashboard`),
 * which deletes the lot: no compiler import, no import map, no vendored package
 * route, no extension guessing. The browser gets one bundled module.
 *
 * That also removes the last obstacle to building this under a real build
 * system, where "compile at request time" is not a thing that can be expressed.
 *
 * ## The build is external, and stays external
 *
 * Nothing here shells out to a bundler, even in development. A server that
 * rebuilds on demand would be a code path that only exists locally, and it is
 * exactly the path a build system would never run — so it would drift from the
 * one that matters. One behaviour: serve what was built.
 *
 * ## Path containment
 *
 * Everything served is read from disk by a path derived from the URL, which is
 * the classic way to hand out `/etc/passwd`. `resolveWithin` is the only
 * function that turns a URL into a path, it resolves before it compares, and it
 * refuses anything that escapes its root.
 */

import {readFileSync} from 'node:fs';
import * as path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8', // source maps, for debugging
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Resolve `relative` under `root`, or return undefined if it escapes.
 *
 * The check is on the **resolved** path, not the requested one: `..%2f..` and
 * friends only become obvious after normalization, and comparing before that is
 * how traversal bugs survive review. The trailing separator matters too —
 * without it, `/srv/ui-secrets` would pass a `startsWith('/srv/ui')` test.
 */
export function resolveWithin(
  root: string,
  relative: string,
): string | undefined {
  const base = path.resolve(root);
  const target = path.resolve(base, `.${path.posix.sep}${relative}`);
  if (target !== base && !target.startsWith(base + path.sep)) return undefined;
  return target;
}

export interface StaticServerOptions {
  /**
   * What to serve. Holds `index.html` and the build output beside it — so a
   * missing build is a 404 on the bundle rather than a server that will not
   * start, which is the more diagnosable failure.
   */
  appRoot: string;
}

export interface StaticServer {
  /**
   * Serve `url` if it names something this owns, reporting whether it did.
   * Returning a boolean rather than writing a 404 lets the caller keep owning
   * what an unclaimed request means — which is how the RPC proxy gets a look.
   */
  handle(url: string, respond: Responder): boolean;
}

/** What `handle` needs from an HTTP response, so it can be tested without one. */
export interface Responder {
  send(status: number, headers: Record<string, string>, body: string): void;
}

export function createStaticServer(options: StaticServerOptions): StaticServer {
  return {
    handle(url, respond) {
      const [pathname = '/'] = url.split('?');
      const relative =
        pathname === '/' || pathname === '/index.html'
          ? 'index.html'
          : pathname;

      const resolved = resolveWithin(options.appRoot, relative);
      if (!resolved) {
        respond.send(403, {'content-type': MIME['.html']!}, 'forbidden');
        return true;
      }

      let body: string;
      try {
        body = readFileSync(resolved, 'utf8');
      } catch {
        respond.send(404, {'content-type': MIME['.html']!}, 'not found');
        return true;
      }

      const type = MIME[path.extname(resolved)] ?? 'application/octet-stream';
      // No caching headers: this is a development and internal-operations tool,
      // and a stale dashboard that disagrees with the server it is watching is
      // worse than a request that costs a few milliseconds.
      respond.send(
        200,
        {'content-type': type, 'cache-control': 'no-store'},
        body,
      );
      return true;
    },
  };
}

/**
 * @fileoverview
 * Serving the dashboard's built code: what it answers, and — more importantly —
 * what it refuses.
 *
 * This spec used to be much larger, and most of what it covered is gone with
 * the code: per-request transpilation, a generated import map, a vendored
 * package route, and two flavours of missing-extension resolution. All of that
 * substituted for a build step. The build is real now, so the server reads
 * files and nothing else.
 *
 * What remains is the part worth keeping honest whatever the server does:
 * **everything here is read from disk by a path derived from a URL, on a
 * listener with no authentication.** The containment tests are the ones that
 * matter; the rest is a content type and a cache header.
 */

import 'jasmine';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {
  createStaticServer,
  resolveWithin,
  type StaticServer,
} from '../../dashboard/server/static_server';

/** What `handle` wrote, captured instead of sent. */
interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function serve(server: StaticServer, url: string): Captured | undefined {
  let captured: Captured | undefined;
  const handled = server.handle(url, {
    send: (status, headers, body) => {
      captured = {status, headers, body};
    },
  });
  // A handler that claims a URL must answer it; one that declines must not.
  expect(handled).toBe(captured !== undefined);
  return captured;
}

describe('resolveWithin', () => {
  const root = path.resolve('/srv/ui');

  it('resolves a path inside the root', () => {
    expect(resolveWithin(root, 'app.js')).toBe(path.join(root, 'app.js'));
  });

  it('refuses a path that climbs out', () => {
    expect(resolveWithin(root, '../package.json')).toBeUndefined();
    expect(resolveWithin(root, 'a/../../../etc/passwd')).toBeUndefined();
  });

  /**
   * The prefix check has to compare on a separator boundary. Without it a root
   * of `/srv/ui` would happily serve `/srv/ui-secrets/keys`, which starts with
   * the same characters and is a different directory.
   */
  it('refuses a sibling directory that merely shares the prefix', () => {
    expect(resolveWithin(root, '../ui-secrets/keys')).toBeUndefined();
  });
});

describe('the dashboard file server', () => {
  let server: StaticServer;
  let appRoot: string;

  beforeAll(() => {
    appRoot = mkdtempSync(path.join(tmpdir(), 'tempo-dist-'));
    writeFileSync(
      path.join(appRoot, 'index.html'),
      '<title>tempo</title><script type="module" src="/app.js"></script>',
    );
    writeFileSync(path.join(appRoot, 'app.js'), 'export const a = 1;');
    writeFileSync(path.join(appRoot, 'app.js.map'), '{"version":3}');
    mkdirSync(path.join(appRoot, 'nested'), {recursive: true});
    writeFileSync(
      path.join(appRoot, 'nested', 'deep.js'),
      'export const b = 2;',
    );

    server = createStaticServer({appRoot});
  });

  it('serves the shell at the root', () => {
    const response = serve(server, '/')!;

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<title>tempo</title>');
  });

  it('serves the same shell for an explicit index.html', () => {
    expect(serve(server, '/index.html')!.body).toContain(
      '<title>tempo</title>',
    );
  });

  it('serves the bundle as JavaScript', () => {
    const response = serve(server, '/app.js')!;

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/javascript');
    expect(response.body).toContain('export const a = 1');
  });

  /**
   * Bundled code is unreadable without one, and a browser only asks for it when
   * devtools are open — so a wrong content type here stays invisible until the
   * moment someone is already debugging something else.
   */
  it('serves a source map as JSON', () => {
    const response = serve(server, '/app.js.map')!;

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('serves a nested file', () => {
    expect(serve(server, '/nested/deep.js')!.body).toContain('export const b');
  });

  it('ignores a query string when resolving', () => {
    expect(serve(server, '/app.js?v=2')!.status).toBe(200);
  });

  it('refuses a path that climbs out of its root', () => {
    for (const url of [
      '/../package.json',
      '/../../etc/passwd',
      '/nested/../../x',
    ])
      expect(serve(server, url)!.status).withContext(url).toBe(403);
  });

  /**
   * The likeliest real 404 is a bundle that was never built. It has to read as
   * a missing file rather than as a server that failed to start, because the
   * two are diagnosed completely differently.
   */
  it('reports a missing file as missing', () => {
    expect(serve(server, '/nope.js')!.status).toBe(404);
  });

  // A dashboard that disagrees with the server it is watching is worse than one
  // that costs an extra request.
  it('tells the browser not to cache anything', () => {
    expect(serve(server, '/')!.headers['cache-control']).toBe('no-store');
    expect(serve(server, '/app.js')!.headers['cache-control']).toBe('no-store');
  });
});

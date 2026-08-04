/**
 * @fileoverview
 * Serving the dashboard's own code: what it answers, and — more importantly, what
 * it refuses.
 *
 * The extension tests exist because the live wiring failed in exactly those
 * ways. A module imported as `./client.js` — which is what type-checked
 * TypeScript must say, since the rule is that you name the *emitted* file —
 * 404'd, because only `client.ts` exists on disk. And the engine's own modules
 * name their siblings with no extension at all, which a browser cannot resolve.
 * Neither produced a useful error in the browser: the symptom was a custom
 * element that silently never upgraded.
 *
 * The path-containment tests are the ones to keep honest. Everything here is
 * read from disk by a path derived from a URL, on a server with no auth.
 */

import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  buildImportMap,
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
    expect(resolveWithin(root, 'app.ts')).toBe(path.join(root, 'app.ts'));
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

describe('buildImportMap', () => {
  const map = buildImportMap(path.resolve('node_modules')).imports;

  it('maps the bare specifier to the package entry point', () => {
    expect(map['lit']).toMatch(/^\/vendor\/lit\/.+\.js$/);
  });

  // Directives and decorators are imported by subpath — `lit-html/directives/…`
  // — which a bare mapping alone does not cover.
  it('maps a trailing-slash prefix for subpath imports', () => {
    expect(map['lit-html/']).toBe('/vendor/lit-html/');
  });

  /**
   * `lit` is the only declared dependency, but it re-exports from three more
   * packages that reach for a fourth. A map naming only what package.json says
   * would leave the browser unable to resolve `lit`'s own internals.
   */
  it('covers what lit reaches for, not just lit', () => {
    for (const name of [
      'lit-html',
      'lit-element',
      '@lit/reactive-element',
      '@lit-labs/ssr-dom-shim',
    ])
      expect(map[name]).withContext(name).toBeDefined();
  });
});

describe('the dashboard file server', () => {
  let server: StaticServer;
  let appRoot: string;

  beforeAll(() => {
    appRoot = mkdtempSync(path.join(tmpdir(), 'tempo-app-'));
    writeFileSync(
      path.join(appRoot, 'index.html'),
      '<title>tempo</title><!--IMPORT_MAP--><tempo-app></tempo-app>',
    );
    writeFileSync(
      path.join(appRoot, 'client.ts'),
      'export const answer: number = 42;',
    );
    mkdirSync(path.join(appRoot, 'nested'), {recursive: true});
    writeFileSync(
      path.join(appRoot, 'nested', 'real.js'),
      'export const a = 1;',
    );

    server = createStaticServer({
      appRoot,
      nodeModules: path.resolve('node_modules'),
    });
  });

  it('serves the shell at the root, with the import map substituted in', () => {
    const response = serve(server, '/')!;

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<script type="importmap">');
    expect(response.body).toContain('/vendor/lit/');
    expect(response.body).not.toContain('<!--IMPORT_MAP-->');
  });

  it('transpiles TypeScript on the way out', () => {
    const response = serve(server, '/client.ts')!;

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/javascript');
    expect(response.body).toContain('export const answer = 42');
    expect(response.body).not.toContain(': number'); // types are gone
  });

  /**
   * The first live failure. Type-checked TypeScript must import `./client.js`,
   * because the rule is that you name the *emitted* file — so the browser asks
   * for a name that does not exist on disk.
   */
  it('serves client.ts for a request for client.js', () => {
    const response = serve(server, '/client.js')!;

    expect(response.status).toBe(200);
    expect(response.body).toContain('export const answer = 42');
  });

  it('prefers a real .js over the .ts fallback', () => {
    expect(serve(server, '/nested/real.js')!.body).toContain(
      'export const a = 1',
    );
  });

  /**
   * The engine's own modules are written for a bundler-style resolver and name
   * their siblings without an extension, which a browser cannot resolve at all.
   * Serving the protocol barrel means answering those.
   */
  it('resolves an extensionless specifier to the TypeScript beside it', () => {
    writeFileSync(
      path.join(appRoot, 'sibling.ts'),
      'export const sibling = 1;',
    );

    expect(serve(server, '/sibling')!.status).toBe(200);
    expect(serve(server, '/sibling')!.body).toContain('export const sibling');
  });

  /**
   * The engine reaches the browser as a vendored dependency now, not through a
   * path escape into a sibling directory. `isStuck` is a value rather than a
   * type, so the module is genuinely fetched.
   */
  it('serves the engine protocol as a vendored package', () => {
    const response = serve(
      server,
      '/vendor/workflow-engine/src/protocol/index.ts',
    )!;

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/javascript');
  });

  it('names the engine protocol in the import map', () => {
    const {imports} = buildImportMap(path.resolve('node_modules'));

    expect(imports['workflow-engine/protocol']).toBe(
      '/vendor/workflow-engine/src/protocol/index.ts',
    );
  });

  it('refuses a path that climbs out of its root', () => {
    for (const url of [
      '/../package.json',
      '/../../etc/passwd',
      '/vendor/../package.json',
    ])
      expect(serve(server, url)!.status).withContext(url).toBe(403);
  });

  it('reports a missing file as missing', () => {
    expect(serve(server, '/nope.js')!.status).toBe(404);
  });

  // A dashboard that disagrees with the server it is watching is worse than one
  // that costs an extra request.
  it('tells the browser not to cache anything', () => {
    expect(serve(server, '/')!.headers['cache-control']).toBe('no-store');
    expect(serve(server, '/client.js')!.headers['cache-control']).toBe(
      'no-store',
    );
  });
});

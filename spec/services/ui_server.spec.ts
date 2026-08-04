/**
 * @fileoverview
 * Serving the dashboard: what `/ui` answers, and — more importantly — what it
 * refuses.
 *
 * Two of these tests exist because the live wiring failed in exactly that way
 * the first time it ran. A module imported as `./client.js` (which is what
 * type-checked TypeScript must say) 404'd because only `client.ts` exists on
 * disk; and a module imported from `../src/protocol/service.js` fell through to
 * the RPC endpoint, which answered a script request with `{"ok":false}` and HTTP
 * 200. Neither produced a useful error in the browser — the symptom was a custom
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
  createUiServer,
  resolveWithin,
  type UiServer,
} from '../../src/services/ui_server';

/** What `handle` wrote, captured instead of sent. */
interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function serve(server: UiServer, url: string): Captured | undefined {
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
    expect(map['lit']).toMatch(/^\/ui\/vendor\/lit\/.+\.js$/);
  });

  // Directives and decorators are imported by subpath — `lit-html/directives/…`
  // — which a bare mapping alone does not cover.
  it('maps a trailing-slash prefix for subpath imports', () => {
    expect(map['lit-html/']).toBe('/ui/vendor/lit-html/');
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

describe('the /ui server', () => {
  let server: UiServer;
  let uiRoot: string;

  beforeAll(() => {
    uiRoot = mkdtempSync(path.join(tmpdir(), 'tempo-ui-'));
    writeFileSync(
      path.join(uiRoot, 'index.html'),
      '<title>tempo</title><!--IMPORT_MAP--><tempo-app></tempo-app>',
    );
    writeFileSync(
      path.join(uiRoot, 'client.ts'),
      'export const answer: number = 42;',
    );
    mkdirSync(path.join(uiRoot, 'nested'), {recursive: true});
    writeFileSync(
      path.join(uiRoot, 'nested', 'real.js'),
      'export const a = 1;',
    );

    server = createUiServer({
      uiRoot,
      nodeModules: path.resolve('node_modules'),
      srcRoot: path.resolve('src'),
    });
  });

  it('declines anything that is not the UI, so the RPC keeps the rest', () => {
    expect(serve(server, '/')).toBeUndefined();
    expect(serve(server, '/uifoo')).toBeUndefined();
  });

  it('serves the shell at /ui, with the import map substituted in', () => {
    const response = serve(server, '/ui')!;

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<script type="importmap">');
    expect(response.body).toContain('/ui/vendor/lit/');
    expect(response.body).not.toContain('<!--IMPORT_MAP-->');
  });

  it('transpiles TypeScript on the way out', () => {
    const response = serve(server, '/ui/client.ts')!;

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
    const response = serve(server, '/ui/client.js')!;

    expect(response.status).toBe(200);
    expect(response.body).toContain('export const answer = 42');
  });

  it('prefers a real .js over the .ts fallback', () => {
    expect(serve(server, '/ui/nested/real.js')!.body).toContain(
      'export const a = 1',
    );
  });

  /**
   * The second live failure. The dashboard imports `isStuck` — a value, not a
   * type — so the module is genuinely fetched, at the path the source names.
   * Unclaimed, it fell through to the RPC endpoint and came back as JSON with a
   * 200, which the browser reported as a syntax error in an unrelated file.
   */
  it('serves shared engine modules at the path the source imports them by', () => {
    const response = serve(server, '/src/protocol/service.js')!;

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/javascript');
    expect(response.body).toContain('isStuck');
  });

  it('refuses a path that climbs out of its root', () => {
    for (const url of [
      '/ui/../package.json',
      '/ui/../../etc/passwd',
      '/src/../package.json',
    ])
      expect(serve(server, url)!.status).withContext(url).toBe(403);
  });

  it('reports a missing file as missing', () => {
    expect(serve(server, '/ui/nope.js')!.status).toBe(404);
  });

  // A dashboard that disagrees with the server it is watching is worse than one
  // that costs an extra request.
  it('tells the browser not to cache anything', () => {
    expect(serve(server, '/ui')!.headers['cache-control']).toBe('no-store');
    expect(serve(server, '/ui/client.js')!.headers['cache-control']).toBe(
      'no-store',
    );
  });
});

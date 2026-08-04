/**
 * @fileoverview
 * Serving the dashboard off the same server that answers the RPC — the `/ui`
 * half of `createRpcServer`.
 *
 * Same origin is the whole point of the arrangement. The browser talks to the
 * RPC at `/` and loads its code from `/ui`, so there is no CORS to configure, no
 * second port to open, and no separate thing to deploy. `tempo up` already
 * starts a server; now that server has a UI.
 *
 * ## No bundler, and what stands in for one
 *
 * There is no build step in this repo and adding one is a decision nobody has
 * made (see AGENTS.md). Two things fill the gap:
 *
 * 1. **Transpile on request.** Browser code is TypeScript, and `ts.transpileModule`
 *    turns one file into one ES module on the way out. `typescript` is already a
 *    dependency and `tools/style.ts` already uses the compiler API, so this costs
 *    nothing new. It is per-file and syntax-only — no type checking, no bundling,
 *    no resolution — which is what makes it fast enough to do per request.
 *    `npm run typecheck` still covers the same files properly.
 * 2. **An import map.** Bare specifiers like `import {LitElement} from 'lit'`
 *    are what a bundler normally resolves. The browser can do it natively given
 *    a map, and `buildImportMap` generates one from what is actually installed
 *    rather than from a hardcoded list that would drift.
 *
 * The map needs more entries than the one dependency suggests: `lit` re-exports
 * from `lit-html`, `lit-element`, and `@lit/reactive-element`, and those reach
 * for `@lit-labs/ssr-dom-shim` in turn. Each package needs both a bare mapping
 * (`lit`) and a trailing-slash prefix (`lit/`), because directives are imported
 * by subpath — `lit-html/directives/repeat.js` and friends.
 *
 * ## Path containment
 *
 * Everything served is read from disk by a path derived from the URL, which is
 * the classic way to hand out `/etc/passwd`. `resolveWithin` is the only
 * function that turns a URL into a path, it resolves before it compares, and it
 * refuses anything that escapes its root. Both roots are explicit and neither is
 * the repo.
 */

import {existsSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Where the browser reaches each of these, and where it comes from on disk. */
const VENDOR_PACKAGES = [
  'lit',
  'lit-html',
  'lit-element',
  '@lit/reactive-element',
  '@lit-labs/ssr-dom-shim',
];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8', // transpiled on the way out
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

/**
 * The import map the browser needs in order to resolve bare specifiers.
 *
 * Generated from each package's own `main`, so a Lit upgrade that moves its
 * entry point does not silently serve a 404. Every package gets two entries: the
 * bare name for `import 'lit'`, and a trailing-slash prefix for the subpath
 * imports that directives and decorators use.
 */
export function buildImportMap(nodeModules: string): {
  imports: Record<string, string>;
} {
  const imports: Record<string, string> = {};
  for (const name of VENDOR_PACKAGES) {
    const manifest = path.join(nodeModules, name, 'package.json');
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      main?: string;
      module?: string;
    };
    const entry = pkg.module ?? pkg.main ?? 'index.js';
    imports[name] = `/ui/vendor/${name}/${entry}`;
    imports[`${name}/`] = `/ui/vendor/${name}/`;
  }
  return {imports};
}

/**
 * A request for `./client.js` where only `client.ts` exists resolves to the
 * TypeScript.
 *
 * This is not a convenience — it is what makes the source *correct* TypeScript.
 * ESM requires a real extension on relative imports, and TypeScript's rule is
 * that you write the extension of the **emitted** file, so `./client.js` is what
 * a type-checked project must say even though nothing by that name exists on
 * disk. Without this the browser asks for a file the compiler told the author to
 * name, and gets a 404 — which is exactly how this was found.
 *
 * Only used as a fallback, so a real `.js` sitting beside a `.ts` still wins.
 */
function withTsFallback(file: string): string {
  if (!file.endsWith('.js')) return file;
  const asTs = `${file.slice(0, -'.js'.length)}.ts`;
  return existsSync(file) || !existsSync(asTs) ? file : asTs;
}

/** Transpiled output, keyed by path, invalidated when the file changes. */
interface CacheEntry {
  mtimeMs: number;
  js: string;
}

export interface UiServerOptions {
  /** The dashboard's browser sources. */
  uiRoot: string;
  /** Where the vendored packages are read from. */
  nodeModules: string;
  /**
   * The engine's own `src/`, served at `/src/`.
   *
   * The dashboard imports `ExecutionDetail` and `isStuck` from `protocol/`
   * rather than restating them — which is the one real advantage this UI has
   * over a generic tool, since a field added to a projection becomes a type
   * error here instead of `undefined` at runtime. Type-only imports vanish in
   * transpilation, but `isStuck` is a *value*, so the browser really does ask
   * for the module.
   *
   * It has to be `/src/` rather than something under `/ui/` because the browser
   * resolves `../src/protocol/service.js` against the importing module's URL,
   * and that is the same path the TypeScript source must name for the project to
   * type-check. Serving it anywhere else would mean the source and the wire
   * disagreeing about where a module lives.
   */
  srcRoot: string;
}

export interface UiServer {
  /**
   * Serve `url` if it belongs to the UI, reporting whether it did. Returning a
   * boolean rather than writing a 404 lets the caller keep owning what a
   * non-UI request means.
   */
  handle(url: string, respond: UiResponder): boolean;
}

/** What `handle` needs from an HTTP response, so it can be tested without one. */
export interface UiResponder {
  send(status: number, headers: Record<string, string>, body: string): void;
}

export function createUiServer(options: UiServerOptions): UiServer {
  const transpiled = new Map<string, CacheEntry>();

  /**
   * TypeScript in, ES module out. Syntax only: `isolatedModules` semantics, no
   * type resolution, and therefore no knowledge of other files — which is why it
   * is fast enough to run per request and why `npm run typecheck` is still the
   * thing that actually checks the code.
   */
  function toJs(file: string): string {
    const {mtimeMs} = statSync(file);
    const hit = transpiled.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.js;
    const {outputText} = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        // Kept off deliberately: the dashboard uses Lit's static-properties form
        // rather than decorators, so nothing here needs them, and leaving them
        // unsupported keeps the served output a straight transcription of the
        // source. See planning/sprints/06-dashboard.md.
        experimentalDecorators: false,
      },
      fileName: file,
    });
    transpiled.set(file, {mtimeMs, js: outputText});
    return outputText;
  }

  function serveFile(
    root: string,
    relative: string,
    respond: UiResponder,
  ): boolean {
    const resolved = resolveWithin(root, relative);
    if (!resolved) {
      respond.send(403, {'content-type': MIME['.html']!}, 'forbidden');
      return true;
    }
    const file = withTsFallback(resolved);
    let body: string;
    try {
      body = file.endsWith('.ts') ? toJs(file) : readFileSync(file, 'utf8');
    } catch {
      respond.send(404, {'content-type': MIME['.html']!}, 'not found');
      return true;
    }
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    // No caching headers: this is a development and internal-operations tool,
    // and a stale dashboard that disagrees with the server is worse than a
    // request that costs a few milliseconds.
    respond.send(
      200,
      {'content-type': type, 'cache-control': 'no-store'},
      body,
    );
    return true;
  }

  return {
    handle(url, respond) {
      const [pathname] = url.split('?');

      // Shared modules the dashboard imports by their real source path. Claimed
      // before the `/ui` check because they do not live under it — see
      // `srcRoot`. Without this the request falls through to the RPC endpoint,
      // which answers a module request with `{"ok":false}` and HTTP 200, and the
      // browser reports a syntax error somewhere unrelated.
      if (pathname!.startsWith('/src/'))
        return serveFile(
          options.srcRoot,
          pathname!.slice('/src/'.length),
          respond,
        );

      if (pathname !== '/ui' && !pathname!.startsWith('/ui/')) return false;

      // `/ui` and `/ui/` both mean the app shell.
      const relative = pathname === '/ui' ? '/' : pathname!.slice('/ui'.length);

      if (relative === '/' || relative === '/index.html') {
        const shell = resolveWithin(options.uiRoot, 'index.html');
        const map = JSON.stringify(
          buildImportMap(options.nodeModules),
          null,
          2,
        );
        const html = readFileSync(shell!, 'utf8').replace(
          '<!--IMPORT_MAP-->',
          `<script type="importmap">\n${map}\n</script>`,
        );
        respond.send(
          200,
          {'content-type': MIME['.html']!, 'cache-control': 'no-store'},
          html,
        );
        return true;
      }

      if (relative.startsWith('/vendor/'))
        return serveFile(
          options.nodeModules,
          relative.slice('/vendor/'.length),
          respond,
        );

      return serveFile(options.uiRoot, relative, respond);
    },
  };
}

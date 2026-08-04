/**
 * @fileoverview
 * Handing the dashboard's own code to a browser: the static half of the
 * dashboard server.
 *
 * This used to live inside the engine, as the `/ui` half of its RPC listener.
 * It does not belong there — a workflow engine has no business owning a
 * TypeScript transpiler, an import-map generator, or a static file server — and
 * the arrangement made the engine depend on the thing that depends on it. The
 * dashboard now serves itself, and the engine has never heard of it.
 *
 * ## No bundler, and what stands in for one
 *
 * There is no build step in this repo and adding one is a decision nobody has
 * made. Two things fill the gap:
 *
 * 1. **Transpile on request.** Browser code is TypeScript, and
 *    `ts.transpileModule` turns one file into one ES module on the way out. It
 *    is per-file and syntax-only — no type checking, no bundling, no resolution
 *    — which is what makes it fast enough to do per request. `npm run
 *    typecheck` still covers the same files properly.
 * 2. **An import map.** Bare specifiers like `import {LitElement} from 'lit'`
 *    are what a bundler normally resolves. The browser can do it natively given
 *    a map, and `buildImportMap` generates one from what is actually installed
 *    rather than from a hardcoded list that would drift.
 *
 * The map needs more entries than the one dependency suggests: `lit` re-exports
 * from `lit-html`, `lit-element`, and `@lit/reactive-element`, and those reach
 * for `@lit-labs/ssr-dom-shim` in turn. Each package needs both a bare mapping
 * (`lit`) and a trailing-slash prefix (`lit/`), because directives are imported
 * by subpath.
 *
 * ## The engine is just another dependency
 *
 * The app imports `ExecutionDetail` and `isStuck` from `workflow-engine/protocol`
 * rather than restating them, which is what makes a field added to a projection
 * a compile error here instead of `undefined` at runtime. Type-only imports
 * vanish in transpilation, but `isStuck` and friends are *values*, so the
 * browser really does ask for the module.
 *
 * It is served from `node_modules` exactly like Lit is. That is the whole
 * difference from the old arrangement: the engine is a declared dependency
 * resolved through the package boundary, not a sibling directory reached into
 * with `../src/`.
 *
 * ## Two extension rules, for one reason
 *
 * A request for `./client.js` where only `client.ts` exists resolves to the
 * TypeScript, and so does an extensionless `./service`. Neither is a
 * convenience:
 *
 * -   ESM requires a real extension on relative imports, and TypeScript's rule
 *     is that you write the extension of the *emitted* file — so `./client.js`
 *     is what a type-checked project must say even though nothing by that name
 *     exists on disk.
 * -   The engine's own modules are written for a bundler-style resolver and use
 *     extensionless specifiers (`export * from './service'`), which a browser
 *     cannot resolve at all.
 *
 * Both are only fallbacks, so a real `.js` sitting beside a `.ts` still wins.
 *
 * ## Path containment
 *
 * Everything served is read from disk by a path derived from the URL, which is
 * the classic way to hand out `/etc/passwd`. `resolveWithin` is the only
 * function that turns a URL into a path, it resolves before it compares, and it
 * refuses anything that escapes its root.
 */

import {existsSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Packages the browser needs, resolved from what is actually installed. */
const VENDOR_PACKAGES = [
  'lit',
  'lit-html',
  'lit-element',
  '@lit/reactive-element',
  '@lit-labs/ssr-dom-shim',
];

/**
 * Bare specifiers that name a *subpath* of a package rather than its entry.
 *
 * The engine exposes `./protocol` through its `exports` map, which `main` and
 * `module` know nothing about — so it is named here rather than derived. Kept
 * to the one entry the app actually imports: widening it would let the browser
 * pull engine modules that expect Node.
 */
const VENDOR_SUBPATHS: Record<string, string> = {
  'workflow-engine/protocol': 'workflow-engine/src/protocol/index.ts',
};

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
 * Generated from each package's own `main`, so a dependency upgrade that moves
 * its entry point does not silently serve a 404. Every package gets two
 * entries: the bare name, and a trailing-slash prefix for subpath imports.
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
    imports[name] = `/vendor/${name}/${entry}`;
    imports[`${name}/`] = `/vendor/${name}/`;
  }
  for (const [specifier, target] of Object.entries(VENDOR_SUBPATHS))
    imports[specifier] = `/vendor/${target}`;
  return {imports};
}

/**
 * The file a request actually means: `./client.js` and `./service` both resolve
 * to `.ts` when that is what exists. See the fileoverview for why both rules
 * are necessary rather than convenient.
 */
function withTsFallback(file: string): string {
  if (existsSync(file)) return file;
  if (file.endsWith('.js')) {
    const asTs = `${file.slice(0, -'.js'.length)}.ts`;
    if (existsSync(asTs)) return asTs;
  }
  if (path.extname(file) === '' && existsSync(`${file}.ts`))
    return `${file}.ts`;
  return file;
}

/** Transpiled output, keyed by path, invalidated when the file changes. */
interface CacheEntry {
  mtimeMs: number;
  js: string;
}

export interface StaticServerOptions {
  /** The dashboard's browser sources. */
  appRoot: string;
  /** Where vendored packages — Lit, and the engine — are read from. */
  nodeModules: string;
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
  const transpiled = new Map<string, CacheEntry>();

  /**
   * TypeScript in, ES module out. Syntax only: `isolatedModules` semantics, no
   * type resolution, and therefore no knowledge of other files — which is why
   * it is fast enough to run per request and why `npm run typecheck` is still
   * the thing that actually checks the code.
   */
  function toJs(file: string): string {
    const {mtimeMs} = statSync(file);
    const hit = transpiled.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.js;
    const {outputText} = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        // Kept off deliberately: the app uses Lit's static-properties form
        // rather than decorators, so nothing here needs them, and leaving them
        // unsupported keeps the served output a straight transcription.
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
    respond: Responder,
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
      const [pathname = '/'] = url.split('?');

      if (pathname === '/' || pathname === '/index.html') {
        const shell = resolveWithin(options.appRoot, 'index.html');
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

      if (pathname.startsWith('/vendor/'))
        return serveFile(
          options.nodeModules,
          pathname.slice('/vendor/'.length),
          respond,
        );

      return serveFile(options.appRoot, pathname, respond);
    },
  };
}

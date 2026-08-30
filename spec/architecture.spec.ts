/**
 * @fileoverview
 * The determinism boundary, enforced rather than asserted. Two jobs: prove the
 * repo currently obeys the rules, and — more importantly — prove the rules would
 * *catch* it if it stopped. A checker that has only ever been run against passing
 * code is indistinguishable from one that checks nothing, so most of this file
 * feeds it deliberately broken files.
 */

import {readFileSync} from 'node:fs';

import {checkDependencies, checkRepoDependencies} from '../tools/dependencies';
import {
  BROWSER_SAFE_ENTRYPOINTS,
  checkBoundaries,
  internalLibraries,
  isWorkflowModule,
  readSourceFiles,
  stripCommentsAndStrings,
  type SourceFile,
} from '../tools/boundaries';
import {REPO_ROOT, repoPath} from './support/repo_root';

// See spec/support/repo_root.ts — fixed to this file, not to the caller's cwd.
const repoRoot = REPO_ROOT;

/** One synthetic file, so a rule can be tested without touching the real tree. */
function file(filePath: string, text: string): SourceFile {
  return {path: filePath, text};
}

describe('architecture — the repo obeys its own boundary', () => {
  it('has no boundary violations anywhere in src', () => {
    const violations = checkBoundaries(readSourceFiles(repoRoot, ['src']));
    expect(violations).toEqual([]);
  });

  it('checks a non-trivial number of files, so "clean" means something', () => {
    expect(readSourceFiles(repoRoot, ['src']).length).toBeGreaterThan(40);
  });
});

describe('architecture — layering', () => {
  it('rejects the core reaching down into a runtime layer', () => {
    const violations = checkBoundaries([
      file('src/core/replay.ts', `import { x } from '../server/server_core';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('layering');
    expect(violations[0].message).toContain('core/ must not import server/');
  });

  /**
   * Stricter than the documented `protocol <- core <- {server, ...}` chain, and
   * deliberately so: the server runs no user code, and replay happens in the
   * workflow worker. A server that imported core would be a design regression.
   */
  it('rejects the server reaching into the deterministic engine', () => {
    const violations = checkBoundaries([
      file('src/server/server_core.ts', `import { replay } from '../core';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain('runs NO user code');
  });

  /**
   * The direction the layer split exists to make enforceable. With `poller` and
   * `signal_stream` inside `core/`, they are reached through the same relative
   * imports as the engine, and same-layer imports are not checked — so `replay.ts`
   * importing a helper built *on* replay would pass. The split is what turns "the
   * engine does not depend on the patterns" from a convention into a rule.
   */
  it('rejects the engine depending on the patterns built from it', () => {
    const violations = checkBoundaries([
      file('src/core/replay.ts', `import { x } from '../patterns/poller';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('layering');
    expect(violations[0].message).toContain('core/ must not import patterns/');
  });

  it('allows a pattern to build on the engine', () => {
    const violations = checkBoundaries([
      file('src/patterns/poller.ts', `import { sleep } from '../core';`),
    ]);

    expect(violations).toEqual([]);
  });

  /**
   * The rule that would have been lost silently in the move: purity was keyed on
   * `core/`, and patterns run inside a replay just as much as the engine does.
   */
  it('holds patterns to the same determinism ban as the engine', () => {
    const violations = checkBoundaries([
      file('src/patterns/poller.ts', `const t = Date.now();`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('core-purity');
  });

  it('rejects protocol depending on anything at all', () => {
    const violations = checkBoundaries([
      file('src/protocol/commands.ts', `import { x } from '../core/context';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('layering');
  });

  it('allows the imports the real layering depends on', () => {
    const violations = checkBoundaries([
      file('src/core/replay.ts', `import type { C } from '../protocol';`),
      file(
        'src/worker/workflow_worker.ts',
        `import { replay } from '../core';`,
      ),
      file('src/services/local_service.ts', `import { s } from '../server';`),
      file('src/services/local_service.ts', `import { w } from '../worker';`),
      file('src/client/client.ts', `import type { S } from '../protocol';`),
    ]);

    expect(violations).toEqual([]);
  });

  it('leaves the entrypoints free to compose every layer', () => {
    const violations = checkBoundaries([
      file('src/local_runtime.ts', `import { s } from './services';`),
      file('bin/server-main.ts', `import { h } from '../src/services';`),
    ]);

    expect(violations).toEqual([]);
  });
});

describe('architecture — core purity', () => {
  it('rejects reading the wall clock inside the core', () => {
    const violations = checkBoundaries([
      file('src/core/replay.ts', `const now = Date.now();`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('core-purity');
    expect(violations[0].message).toContain('Date.now()');
  });

  /**
   * Purity is a question about *where code runs*, not about which directory it
   * sits in — and the props parse runs on every activation from a file at `src/`
   * root. Planted here because the rule would otherwise be silently narrower
   * than the claim it makes.
   */
  it('rejects a clock in a module that runs inside a replay', () => {
    const violations = checkBoundaries([
      file('src/workflow_props.ts', `const at = Date.now();`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('core-purity');
  });

  it('rejects randomness inside the core', () => {
    const violations = checkBoundaries([
      file('src/core/condition.ts', `const r = Math.random();`),
    ]);

    expect(violations.length).toBe(1);
  });

  /**
   * The one sanctioned piece of host coupling: `drainMicrotasks` needs a macrotask
   * boundary. It is exempted by exact path, so a second use anywhere else in the
   * core still fails — the exception has to be argued for in a diff.
   */
  it('allows the documented microtask yield only in the module that owns it', () => {
    const allowed = checkBoundaries([
      file(
        'src/core/microtask_scheduler.ts',
        `export const d = () => new Promise((r) => setImmediate(r));`,
      ),
    ]);
    const elsewhere = checkBoundaries([
      file('src/core/replay.ts', `setImmediate(() => {});`),
    ]);

    expect(allowed).toEqual([]);
    expect(elsewhere.length).toBe(1);
    expect(elsewhere[0].message).toContain('setImmediate');
  });

  /**
   * `core/replay.ts` documents the rule with the words "never `Date.now()`".
   * A naive grep would report the documentation as a violation, so the checker
   * blanks comments before scanning.
   */
  it('does not mistake documentation about a construct for a use of it', () => {
    const violations = checkBoundaries([
      file(
        'src/core/replay.ts',
        [
          '/**',
          ' * Time comes from `sleep`, never `Date.now()`.',
          ' */',
          '// Math.random() would break replay.',
          'export const ok = 1;',
        ].join('\n'),
      ),
    ]);

    expect(violations).toEqual([]);
  });

  it('leaves the runtime layers free to use the clock and I/O', () => {
    const violations = checkBoundaries([
      file('src/server/server_core.ts', `const t = Date.now();`),
      file('src/worker/activity_worker.ts', `await fetch('http://x');`),
    ]);

    expect(violations).toEqual([]);
  });
});

describe('architecture — the author entrypoint', () => {
  it('recognises workflow modules by convention', () => {
    expect(isWorkflowModule('src/workflows.ts')).toBeTrue();
    expect(isWorkflowModule('app/workflows/orders.ts')).toBeTrue();
    expect(isWorkflowModule('app/orders.workflow.ts')).toBeTrue();
    expect(isWorkflowModule('src/server/server_core.ts')).toBeFalse();
  });

  /**
   * The roadmap's original exit criterion for this rule: a deliberately planted
   * `Date.now()` in a workflow file must fail the check.
   */
  it('fails a deliberately planted Date.now() in workflow code', () => {
    const violations = checkBoundaries([
      file(
        'src/workflows.ts',
        `import { sleep } from './workflow';\nexport const at = Date.now();`,
      ),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('author-entrypoint');
    expect(violations[0].message).toContain('non-deterministic');
  });

  it('rejects workflow code importing the host entrypoint', () => {
    const violations = checkBoundaries([
      file('src/workflows.ts', `import { createLocalRuntime } from './index';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain('only workflow.ts');
  });

  it('rejects workflow code importing a node builtin', () => {
    const violations = checkBoundaries([
      file('src/workflows.ts', `import { readFileSync } from 'node:fs';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('author-entrypoint');
  });

  it('allows workflow code that imports only the deterministic surface', () => {
    const violations = checkBoundaries([
      file(
        'src/workflows.ts',
        `import { runActivity, condition, sleep } from './workflow';
         export async function w() { await sleep(5); }`,
      ),
    ]);

    expect(violations).toEqual([]);
  });

  /**
   * The exemption that makes the documented typing pattern expressible.
   * `proxyActivities<typeof activities>` needs the activities module's shape inside
   * the workflow module, and `import type * as` is the only way to get it without a
   * runtime edge. Without the exemption, following the advice in
   * `spec/support/greeter_worker.ts` fails `npm run lint` and a properly-named
   * workflow module cannot be typed at all.
   */
  it('allows a type-only import, which is erased and cannot run', () => {
    const violations = checkBoundaries([
      file(
        'src/workflows.ts',
        `import { runActivity } from './workflow';
         import type * as activities from './activities';
         export type A = typeof activities;`,
      ),
    ]);

    expect(violations).toEqual([]);
  });

  it('allows a type-only re-export for the same reason', () => {
    const violations = checkBoundaries([
      file('src/workflows.ts', `export type { Order } from './orders';`),
    ]);

    expect(violations).toEqual([]);
  });

  // The exemption is about what executes. Drop the `type` and the same line is a
  // runtime dependency on a module that may do I/O inside a replay.
  it('still rejects the same import without the type modifier', () => {
    const violations = checkBoundaries([
      file('src/workflows.ts', `import * as activities from './activities';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('author-entrypoint');
  });

  /**
   * Conservative on purpose: an inline `{type Foo}` can still emit a bare
   * `import './x'` under `verbatimModuleSyntax`, which is a side-effect import and
   * therefore real. Only the statement form guarantees nothing runs.
   */
  it('does not exempt an inline type modifier, which can still emit an import', () => {
    const violations = checkBoundaries([
      file('src/workflows.ts', `import { type Order } from './orders';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('author-entrypoint');
  });
});

describe('architecture — browser safety', () => {
  it('lists only entrypoints that exist, so the rule cannot check nothing', () => {
    const paths = new Set(
      readSourceFiles(repoRoot, ['src']).map((source) => source.path),
    );

    for (const entrypoint of BROWSER_SAFE_ENTRYPOINTS) {
      expect(paths.has(entrypoint)).toBe(true);
    }
  });

  it('rejects an entrypoint importing a node builtin directly', () => {
    const violations = checkBoundaries([
      file('src/remote_client.ts', `import * as http from 'node:http';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('browser-safety');
    expect(violations[0].message).toContain('node:http');
  });

  /**
   * The failure this rule exists for, and the one no single-file check can see:
   * every file in the chain is innocent on its own. `remote_client.ts` imports
   * `services/remote_service` directly for exactly this reason — routing it
   * through `services/index.ts` would re-export `rpc_server` and put `node:http`
   * in a dashboard's bundle.
   */
  it('follows a barrel to the host module it re-exports', () => {
    const violations = checkBoundaries([
      file('src/remote_client.ts', `export * from './services';`),
      file('src/services/index.ts', `export * from './rpc_server';`),
      file('src/services/rpc_server.ts', `import * as http from 'node:http';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('browser-safety');
    expect(violations[0].path).toBe('src/services/rpc_server.ts');
  });

  it('names the route that reached the builtin, not just the builtin', () => {
    const violations = checkBoundaries([
      file('src/remote_client.ts', `export * from './services';`),
      file('src/services/index.ts', `export * from './rpc_server';`),
      file('src/services/rpc_server.ts', `import * as http from 'node:http';`),
    ]);

    expect(violations[0].message).toContain(
      'src/remote_client.ts -> src/services/index.ts -> src/services/rpc_server.ts',
    );
  });

  /**
   * The exemption that makes the rule usable at all: `remote_service.ts` names
   * a dozen protocol types.
   * An erased import emits no module reference, so no bundler follows it.
   */
  it('ignores a type-only import of a module that is not browser-safe', () => {
    const violations = checkBoundaries([
      file(
        'src/remote_client.ts',
        `import type {Server} from './server_main';`,
      ),
      file('src/server_main.ts', `import {readFileSync} from 'node:fs';`),
    ]);

    expect(violations).toEqual([]);
  });

  /**
   * The other half of the promise, and the half that fails silently. A builtin
   * breaks the consumer's build; a workflow module registers its activities into
   * a process-global registry and breaks nothing you can see. This is what
   * `src/schedule/index.ts` did for a day — see
   * `spec/schedule/client_entrypoint.spec.ts`, which asserts the same property
   * for that entrypoint specifically and in both directions.
   */
  it('rejects an entrypoint reaching a workflow module for a value', () => {
    const violations = checkBoundaries([
      file('src/schedule/index.ts', `export * from './scheduler.workflow';`),
      file('src/schedule/scheduler.workflow.ts', `export const x = 1;`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('browser-safety');
    expect(violations[0].message).toContain('scheduler.workflow');
  });

  it('lets an entrypoint name a workflow module in a type-only import', () => {
    const violations = checkBoundaries([
      file(
        'src/schedule/index.ts',
        `import type {Spec} from './scheduler.workflow';`,
      ),
      file('src/schedule/scheduler.workflow.ts', `export const x = 1;`),
    ]);

    expect(violations).toEqual([]);
  });

  it('reports a builtin reached through a cycle exactly once', () => {
    const violations = checkBoundaries([
      file('src/remote_client.ts', `export * from './a';`),
      file('src/a.ts', `export * from './b';`),
      file('src/b.ts', `export * from './a';\nimport 'node:fs';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain('node:fs');
  });
});

describe('architecture — the comment stripper', () => {
  it('preserves line numbers so violations point at the right line', () => {
    const stripped = stripCommentsAndStrings('a\n/* x\n y */\nb');
    expect(stripped.split('\n').length).toBe(4);
  });

  it('keeps import specifiers readable while blanking prose', () => {
    const stripped = stripCommentsAndStrings(
      `import { a } from '../core'; // Date.now() here is only prose`,
    );
    expect(stripped).toContain(`'../core'`);
    expect(stripped).not.toContain('Date.now');
  });
});

/**
 * The dependency allowlist. Same reasoning as the boundary rules: the constraint
 * is only real if a violation fails a build rather than a code review.
 *
 * Both directions matter here. The repo passing today proves nothing about
 * whether the checker works, so the interesting tests are the planted additions.
 */
describe('architecture — dependencies', () => {
  it('accepts what the project actually carries', () => {
    expect(checkRepoDependencies(repoRoot)).toEqual([]);
  });

  /**
   * The runtime list is empty, and an empty list is the one shape a checker can
   * get wrong in a way that looks like success — a bug that returns no
   * violations passes the case above too, because the repo declares no runtime
   * dependency to find. So the claim is pinned from the other side: anything at
   * all in `dependencies` is refused, and `lit` in particular, as the browser
   * dependency a dashboard in this tree would reintroduce.
   */
  it('refuses any runtime dependency, lit included', () => {
    const violations = checkDependencies({
      dependencies: {lit: '^3.2.0', 'date-fns': '^3'},
    });

    expect(violations.map((v) => v.name).sort()).toEqual(['date-fns', 'lit']);
    expect(violations.every((v) => v.field === 'dependencies')).toBe(true);
  });

  /**
   * The dev list is separate and just as closed. A bundler is the likeliest
   * thing to appear here — one was on it until the dashboard, the only thing
   * being bundled, left the repo — and adding one back is a decision, not an
   * install.
   */
  it('refuses a new dev dependency, bundlers included', () => {
    const violations = checkDependencies({
      devDependencies: {vite: '^5', esbuild: '^0.25.0'},
    });

    expect(violations.map((v) => v.name).sort()).toEqual(['esbuild', 'vite']);
    expect(violations.every((v) => v.field === 'devDependencies')).toBe(true);
  });
});

describe('architecture — internal libraries', () => {
  /**
   * Location is the declaration: any file under src/libraries/<name>/ is held
   * to the library contract with no list to join. These plant each way the
   * contract can break; the last two check the real tree for the halves the
   * checker cannot see (a contract entrypoint, a seam spec).
   */
  it('rejects a library reaching into the engine', () => {
    const violations = checkBoundaries([
      file('src/libraries/fake/thing.ts', `import {x} from '../../core';`),
    ]);
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('library-boundary');
    expect(violations[0].message).toContain('libraries/fake');
  });

  it('rejects a library importing a Node builtin — third-party means self-contained', () => {
    const violations = checkBoundaries([
      file('src/libraries/fake/thing.ts', `import * as fs from 'node:fs';`),
    ]);
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('library-boundary');
  });

  it('rejects a library importing a sibling library', () => {
    const violations = checkBoundaries([
      file(
        'src/libraries/fake/thing.ts',
        `import {x} from '../schema/validate';`,
      ),
    ]);
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('library-boundary');
  });

  it('allows a library importing its own files', () => {
    expect(
      checkBoundaries([
        file('src/libraries/fake/thing.ts', `import {x} from './other';`),
      ]),
    ).toEqual([]);
  });

  it('refuses a loose file directly under src/libraries/', () => {
    const violations = checkBoundaries([
      file('src/libraries/stray.ts', `export const x = 1;`),
    ]);
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('library-boundary');
    expect(violations[0].message).toContain('belongs to no package');
  });

  it('derives the membership every other check keys on from the tree', () => {
    expect(internalLibraries(readSourceFiles(repoRoot, ['src']))).toEqual([
      'schema',
      'walltime',
    ]);
  });

  // The two halves of the contract the checker cannot enforce from file
  // contents alone: an index.ts stating the contract, and a seam spec pinning
  // the removal surface. Checked here against the real tree so a package
  // cannot drift into existence with neither.
  it('gives every library a contract entrypoint and a seam spec', () => {
    const src = readSourceFiles(repoRoot, ['src']);
    const specs = new Set(
      readSourceFiles(repoRoot, ['spec']).map((f) => f.path),
    );
    const srcPaths = new Set(src.map((f) => f.path));
    for (const library of internalLibraries(src)) {
      expect(srcPaths.has(`src/libraries/${library}/index.ts`))
        .withContext(
          `src/libraries/${library}/ has no index.ts — the contract fileoverview lives there`,
        )
        .toBe(true);
      expect(specs.has(`spec/libraries/${library}/seam.spec.ts`))
        .withContext(
          `src/libraries/${library}/ has no seam spec — spec/libraries/${library}/seam.spec.ts names its removal surface`,
        )
        .toBe(true);
    }
  });
});

/**
 * The marker a published entrypoint's guide opens with. It is what makes the
 * surfaces findable by eye (`grep ★ src/`) as well as by this check.
 */
const GUIDE_MARKER = '★';

/** The leading block comment, or '' — a guide that is not first is not a guide. */
function leadingComment(text: string): string {
  if (!text.startsWith('/**')) return '';
  const end = text.indexOf('*/');
  return end === -1 ? text : text.slice(0, end);
}

/**
 * Published subpaths whose entrypoint carries no guide.
 *
 * Wildcard patterns are skipped. `./sandbox/shims/*` publishes a family of
 * replacement modules rather than a surface to build on, and the guide that
 * governs them is the sandbox entrypoint's — which this does check.
 *
 * Pure, so the rule can be run against a surface deliberately published
 * without one rather than only against the tree that passes.
 */
function surfacesMissingGuides(
  exportsMap: Record<string, string>,
  files: SourceFile[],
): string[] {
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  const missing: string[] = [];
  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (subpath.includes('*')) continue;
    const filePath = target.replace(/^\.\//, '');
    const text = byPath.get(filePath);
    if (text === undefined || !leadingComment(text).includes(GUIDE_MARKER))
      missing.push(subpath);
  }
  return missing;
}

function publishedExports(): Record<string, string> {
  const manifest = JSON.parse(
    readFileSync(repoPath('package.json'), 'utf8'),
  ) as {exports: Record<string, string>};
  return manifest.exports;
}

/**
 * A path in the `exports` map is something outside resolving it by name, which
 * makes it a surface someone builds on — and AGENTS.md asks every one of those
 * to carry a guide at its entrypoint. Checked here because the alternative is
 * finding out from whoever gets stuck on the surface that has none.
 */
describe('architecture — published surfaces', () => {
  it('gives every published surface a guide at its entrypoint', () => {
    const missing = surfacesMissingGuides(
      publishedExports(),
      readSourceFiles(repoRoot, ['src']),
    );

    expect(missing)
      .withContext(
        `published without a guide: ${missing.join(', ')} — see AGENTS.md, "Every surface someone builds on gets a guide"`,
      )
      .toEqual([]);
  });

  it('publishes a non-trivial number of surfaces, so "clean" means something', () => {
    const checked = Object.keys(publishedExports()).filter(
      (subpath) => !subpath.includes('*'),
    );
    expect(checked.length).toBeGreaterThan(8);
  });

  /**
   * A subpath is only as good as the file behind it, and nothing else in the
   * suite looks: every spec imports `../../src/...` by relative path, so a
   * target renamed on one side of a move stays green here and is total for the
   * consumer resolving it by name.
   *
   * Read from the tree rather than resolved by the module loader. Importing
   * `workflow-engine/schema` to prove the same thing is a package
   * self-reference, which the build system consuming this repo does not resolve
   * — see the note in `tsconfig.json`. This asks the question that matters
   * without depending on whose resolver is asking.
   */
  it('points every published subpath at a file that exists', () => {
    const present = new Set(
      readSourceFiles(repoRoot, ['src']).map((f) => f.path),
    );
    const dangling = Object.entries(publishedExports())
      .filter(([subpath]) => !subpath.includes('*'))
      .filter(([, target]) => !present.has(target.replace(/^\.\//, '')))
      .map(([subpath, target]) => `${subpath} -> ${target}`);

    expect(dangling)
      .withContext(`published subpaths resolving to nothing: ${dangling}`)
      .toEqual([]);
  });

  /**
   * The wildcard the check above has to skip. It cannot be resolved to one
   * file, so the thing to hold is that the directory it fans out over is really
   * there — otherwise `./sandbox/shims/*` could name nothing at all and no test
   * in this file would notice.
   */
  it('backs its one wildcard subpath with a directory that has files in it', () => {
    const shims = readSourceFiles(repoRoot, ['src']).filter((f) =>
      f.path.startsWith('src/sandbox/shims/'),
    );

    expect(publishedExports()['./sandbox/shims/*']).toBe(
      './src/sandbox/shims/*.ts',
    );
    expect(shims.length).toBeGreaterThan(0);
  });

  it('fails a surface published without one', () => {
    const missing = surfacesMissingGuides({'./new': './src/new.ts'}, [
      file('src/new.ts', `/**\n * @fileoverview\n * A module.\n */`),
    ]);

    expect(missing).toEqual(['./new']);
  });

  it('fails a surface whose entrypoint does not exist at all', () => {
    expect(surfacesMissingGuides({'./gone': './src/gone.ts'}, [])).toEqual([
      './gone',
    ]);
  });

  /**
   * The marker has to be in the *leading* comment. A `★` further down is a
   * mention of some other entrypoint — every guide here links to its
   * neighbours — and counting it would let a surface pass on someone else's.
   */
  it('does not accept a marker that appears below the fileoverview', () => {
    const missing = surfacesMissingGuides({'./new': './src/new.ts'}, [
      file(
        'src/new.ts',
        `/**\n * @fileoverview\n * A module.\n */\n// see ★ CLIENT ENTRYPOINT\n`,
      ),
    ]);

    expect(missing).toEqual(['./new']);
  });
});

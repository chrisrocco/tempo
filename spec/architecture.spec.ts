/**
 * @fileoverview
 * The determinism boundary, enforced rather than asserted. Two jobs: prove the
 * repo currently obeys the rules, and — more importantly — prove the rules would
 * *catch* it if it stopped. A checker that has only ever been run against passing
 * code is indistinguishable from one that checks nothing, so most of this file
 * feeds it deliberately broken files.
 */

import {checkDependencies, checkRepoDependencies} from '../tools/dependencies';
import {
  checkBoundaries,
  isWorkflowModule,
  readSourceFiles,
  stripCommentsAndStrings,
  type SourceFile,
} from '../tools/boundaries';
import {REPO_ROOT} from './support/repo_root';

// See spec/support/repo_root.ts — fixed to this file, not to the caller's cwd.
const repoRoot = REPO_ROOT;

/** One synthetic file, so a rule can be tested without touching the real tree. */
function file(filePath: string, text: string): SourceFile {
  return {path: filePath, text};
}

describe('architecture — the repo obeys its own boundary', () => {
  it('has no boundary violations anywhere in src or examples', () => {
    const violations = checkBoundaries(
      readSourceFiles(repoRoot, ['src', 'examples']),
    );
    expect(violations).toEqual([]);
  });

  it('checks a non-trivial number of files, so "clean" means something', () => {
    expect(
      readSourceFiles(repoRoot, ['src', 'examples']).length,
    ).toBeGreaterThan(40);
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
   * The direction that used to be unenforceable. `poller` and `signal_stream`
   * lived in `core/` and were reached through the same relative imports as the
   * engine, and same-layer imports are not checked — so `replay.ts` importing a
   * helper built *on* replay would have passed. Splitting the layer is what
   * turns "the engine does not depend on the patterns" from a convention into a
   * rule.
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

  it('accepts lit, the one permitted runtime dependency', () => {
    expect(checkDependencies({dependencies: {lit: '^3.2.0'}})).toEqual([]);
  });

  /**
   * The engine's own list is empty, and that is the claim worth pinning: `lit`
   * is permitted *somewhere*, and the somewhere is the dashboard. Checking only
   * the general case would pass while the engine quietly regrew a runtime
   * dependency for a browser.
   */
  it('refuses a runtime dependency in the engine, including lit', () => {
    const violations = checkDependencies(
      {dependencies: {lit: '^3.2.0'}},
      {runtime: [], dev: []},
    );

    expect(violations.map((v) => v.name)).toEqual(['lit']);
  });

  /**
   * The specific rule that is easiest to talk yourself out of: labs packages
   * look official, and each one replaces work. They are pre-release by
   * definition, and the dashboard was scoped to do without them.
   */
  it('refuses a Lit labs package, and says why', () => {
    const violations = checkDependencies({
      dependencies: {'@lit-labs/virtualizer': '^2.0.0'},
    });

    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain('labs');
    expect(violations[0].message).toContain('AGENTS.md');
  });

  // "Part of Lit" means the `lit` package — not everything under the org.
  it('refuses a @lit/ package that is not lit itself', () => {
    const violations = checkDependencies({
      dependencies: {'@lit/context': '^1'},
    });

    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain('not Lit');
  });

  it('refuses an unrelated runtime dependency', () => {
    const violations = checkDependencies({dependencies: {'date-fns': '^3'}});

    expect(violations.length).toBe(1);
    expect(violations[0].field).toBe('dependencies');
  });

  // The dev list is separate and just as closed — a bundler is the likeliest
  // thing to appear here, and adding one is a decision, not an install.
  it('refuses a new dev dependency, bundlers included', () => {
    const violations = checkDependencies({devDependencies: {vite: '^5'}});

    expect(violations.length).toBe(1);
    expect(violations[0].field).toBe('devDependencies');
  });
});

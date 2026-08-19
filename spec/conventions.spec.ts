/**
 * @fileoverview
 * The written-shape conventions, enforced rather than asserted — the same two
 * jobs `spec/architecture.spec.ts` does for the boundary rules. Prove the repo
 * obeys them today, and prove the checker would *catch* it if it stopped, by
 * feeding it deliberately broken files. A rule that has only ever seen passing
 * code is indistinguishable from no rule.
 *
 * The rules and the reasoning behind each are in
 * [`tools/conventions.ts`](../tools/conventions.ts); this file is where they are
 * pinned down. Three of the four were the dashboard's and left with it, so what
 * remains is the namespace-import rule and the checker's reach.
 */

import {
  CHECKED_DIRS,
  checkConventions,
  readCheckedFiles,
} from '../tools/conventions';
import type {SourceFile} from '../tools/boundaries';
import {REPO_ROOT} from './support/repo_root';

// See spec/support/repo_root.ts — fixed to this file, not to the caller's cwd.
const repoRoot = REPO_ROOT;

/** One synthetic file, so a rule can be tested without touching the real tree. */
function file(filePath: string, text: string): SourceFile {
  return {path: filePath, text};
}

describe('conventions — the repo obeys its own conventions', () => {
  it('has no convention violations in any hand-written directory', () => {
    expect(checkConventions(readCheckedFiles(repoRoot))).toEqual([]);
  });

  it('checks a non-trivial number of files, so "clean" means something', () => {
    expect(readCheckedFiles(repoRoot).length).toBeGreaterThan(100);
  });

  /**
   * The directories are the rule's reach, and the reach is the point: the first
   * default import this checker found was in `tools/`, which no tsconfig
   * includes and so no type-aware checker can see.
   */
  it('reaches the directories no tsconfig includes', () => {
    expect(CHECKED_DIRS).toContain('tools');
    expect(CHECKED_DIRS).toContain('spec');
  });
});

describe('conventions — namespace imports', () => {
  it('rejects a default import of a Node builtin', () => {
    const violations = checkConventions([
      file('src/services/rpc_server.ts', `import path from 'node:path';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('namespace-import');
    expect(violations[0].message).toContain('import * as path');
  });

  it('rejects a default import of a package', () => {
    const violations = checkConventions([
      file('tools/style.ts', `import ts from 'typescript';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('namespace-import');
  });

  // The mixed form is the one that slips through a rule written as "the line
  // must not start with `import <name> from`" — the default binding is still
  // there, with a named clause hiding it.
  it('rejects a default import that arrives beside a named clause', () => {
    const violations = checkConventions([
      file('tools/style.ts', `import ts, {SyntaxKind} from 'typescript';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('namespace-import');
  });

  it('rejects a default import written as a type import', () => {
    const violations = checkConventions([
      file('src/server/lease.ts', `import type Config from './config';`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('namespace-import');
  });

  it('accepts the namespace import it asks for', () => {
    const violations = checkConventions([
      file('src/services/rpc_server.ts', `import * as path from 'node:path';`),
    ]);

    expect(violations).toEqual([]);
  });

  it('leaves named, type-only, and side-effect imports alone', () => {
    const violations = checkConventions([
      file('src/core/replay.ts', `import {replay} from './replay';`),
      file('src/core/context.ts', `import type {Command} from '../protocol';`),
      file('spec/core/replay.spec.ts', `import 'jasmine';`),
      file(
        'src/server/index.ts',
        `import {\n  readFileSync,\n  writeFileSync,\n} from 'node:fs';`,
      ),
    ]);

    expect(violations).toEqual([]);
  });

  /**
   * The rule this file needs in order to test itself: every planted violation
   * above lives inside a string literal, and a checker that read them would
   * report this spec as breaking the rules it is pinning down.
   */
  it('does not read code quoted inside a string as code', () => {
    const violations = checkConventions([
      file(
        'spec/conventions.spec.ts',
        'const planted = `import path from "node:path";`;',
      ),
    ]);

    expect(violations).toEqual([]);
  });
});

describe('conventions — see pointers resolve', () => {
  it('accepts a pointer to a file the tree contains', () => {
    const files = [
      file('src/a.ts', '/** see `src/b.ts` for the rest. */'),
      file('src/b.ts', ''),
    ];

    expect(checkConventions(files)).toEqual([]);
  });

  it('rejects a pointer to a file the tree does not contain', () => {
    const files = [file('src/a.ts', '/** see `src/gone.ts` for the rest. */')];

    const [violation] = checkConventions(files);
    expect(violation?.rule).toBe('dangling-pointer');
    expect(violation?.line).toBe(1);
    expect(violation?.message).toContain('src/gone.ts');
  });

  it('accepts a pointer that omits the .ts this repo omits', () => {
    const files = [
      file('src/a.ts', '/** see `bin/server-main` for the invocation. */'),
      file('bin/server-main.ts', ''),
    ];

    expect(checkConventions(files)).toEqual([]);
  });

  it('accepts a pointer to a directory something lives under', () => {
    const files = [
      file('src/a.ts', '/** see `src/server/ports/` for the contract. */'),
      file('src/server/ports/history_store.ts', ''),
    ];

    expect(checkConventions(files)).toEqual([]);
  });

  /**
   * The case that decides how narrow the rule is. `remote_client.ts` heads a
   * section "Why it is not `src/client.ts`" — a path that must *not* exist, and
   * the reason the rule cannot be "every backticked path resolves".
   */
  it('ignores a path named in prose without being pointed at', () => {
    const files = [file('src/a.ts', '/** ## Why it is not `src/client.ts` */')];

    expect(checkConventions(files)).toEqual([]);
  });
});

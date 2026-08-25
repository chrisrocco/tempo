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
 * pinned down — the namespace-import rule, the self-reference rule, and the
 * checker's reach.
 */

import {readFileSync} from 'node:fs';

import {
  CHECKED_DIRS,
  PACKAGE_NAME,
  checkConventions,
  readCheckedFiles,
} from '../tools/conventions';
import type {SourceFile} from '../tools/boundaries';
import {REPO_ROOT, repoPath} from './support/repo_root';

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

/**
 * The planted specifiers below are interpolated rather than written out, and
 * that is not fussiness: this rule reads string *contents*, because a specifier
 * is one — so unlike the namespace rule above, it cannot be fooled into
 * ignoring a violation quoted inside a test. A literal `from 'workflow-engine'`
 * anywhere in this file would be a real violation of the rule the file exists
 * to pin down. Interpolation keeps the name out of the one position the rule
 * looks at while leaving the planted file exactly what a reader expects.
 */
const NAME = PACKAGE_NAME;

describe('conventions — self-referencing imports', () => {
  it('names the package the rule is about, as the manifest spells it', () => {
    const manifest = JSON.parse(
      readFileSync(repoPath('package.json'), 'utf8'),
    ) as {name: string};

    // Held as a constant for purity's sake, so this is what stops a rename
    // leaving the rule matching a name nothing is called any more.
    expect(PACKAGE_NAME).toBe(manifest.name);
  });

  it('rejects importing this package by its published name', () => {
    const violations = checkConventions([
      file(
        'spec/libraries/schema/guide.spec.ts',
        `import {t} from '${NAME}/schema';`,
      ),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('self-reference-import');
    expect(violations[0].message).toContain('relative path');
  });

  it('rejects the package root as readily as a subpath', () => {
    const violations = checkConventions([
      file('spec/x.spec.ts', `import {startServer} from '${NAME}';`),
    ]);

    expect(violations.length).toBe(1);
  });

  /** Four spellings resolve a specifier, and a rule that caught one would be a rule about that one. */
  it('rejects the side-effect, dynamic, and require spellings too', () => {
    const violations = checkConventions([
      file('spec/a.spec.ts', `import '${NAME}/schema';`),
      file('spec/b.spec.ts', `const m = await import('${NAME}');`),
      file('spec/c.spec.ts', `const m = require('${NAME}/protocol');`),
    ]);

    expect(violations.length).toBe(3);
    expect(violations.every((v) => v.rule === 'self-reference-import')).toBe(
      true,
    );
  });

  it('accepts the relative path it asks for', () => {
    const violations = checkConventions([
      file('spec/x.spec.ts', `import {t} from '../../src/libraries/schema';`),
    ]);

    expect(violations).toEqual([]);
  });

  /**
   * The specifier is not the only place the name is written. A `describe` naming
   * the surface under test reads as prose, and a rule that reported it would be
   * a rule people rename their tests to get around.
   */
  it('does not mistake the package name in prose for an import of it', () => {
    const violations = checkConventions([
      file(
        'spec/libraries/schema/guide.spec.ts',
        `describe('workflow-engine/schema — the surface its guide describes', () => {});`,
      ),
      file(
        'spec/client/entrypoint.spec.ts',
        `it('is the file the exports map publishes as workflow-engine/client', () => {});`,
      ),
    ]);

    expect(violations).toEqual([]);
  });
});

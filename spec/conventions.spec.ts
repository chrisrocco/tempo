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
 * pinned down.
 */

import * as path from 'node:path';
import {
  CHECKED_DIRS,
  checkConventions,
  readCheckedFiles,
} from '../tools/conventions';
import type {SourceFile} from '../tools/boundaries';

// See tools/lint.ts — resolved from the working directory, not the module URL.
const repoRoot = path.resolve('.');

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
      file('src/cli/up.ts', `import path from 'node:path';`),
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
      file('src/cli/up.ts', `import * as path from 'node:path';`),
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

describe('conventions — a dashboard spec names its harness', () => {
  it('rejects a dashboard spec that leaves describe and it ambient', () => {
    const violations = checkConventions([
      file(
        'spec/dashboard/routes.spec.ts',
        `import {parseRoute} from '../../dashboard/app/routes';`,
      ),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('spec-harness-import');
    expect(violations[0].message).toContain("import 'jasmine';");
  });

  it('accepts a dashboard spec that imports jasmine', () => {
    const violations = checkConventions([
      file(
        'spec/dashboard/routes.spec.ts',
        `import 'jasmine';\nimport {parseRoute} from '../../dashboard/app/routes';`,
      ),
    ]);

    expect(violations).toEqual([]);
  });

  // Scoped deliberately: the rest of the suite still leans on the root
  // tsconfig's ambient `types`, and widening this would be its own decision.
  it('asks nothing of the specs outside the dashboard folder', () => {
    const violations = checkConventions([
      file(
        'spec/core/replay.spec.ts',
        `import {replay} from '../../src/core';`,
      ),
      file('spec/architecture.spec.ts', `import * as path from 'node:path';`),
    ]);

    expect(violations).toEqual([]);
  });

  // A mention in prose is not a declaration.
  it('does not accept the import when it appears only in a comment', () => {
    const violations = checkConventions([
      file(
        'spec/dashboard/routes.spec.ts',
        `// import 'jasmine';\nconst a = 1;`,
      ),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('spec-harness-import');
  });
});

describe('conventions — DOM sink writes', () => {
  it('rejects a dotted write to a sink property in browser code', () => {
    const violations = checkConventions([
      file('dashboard/app/execution_detail.ts', `anchor.href = url;`),
    ]);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('dom-sink-bracket');
    expect(violations[0].message).toContain(`['href']`);
  });

  it('names every sink it knows about, not just the markup ones', () => {
    const violations = checkConventions([
      file('dashboard/app/json_view.ts', `node.innerHTML = text;`),
      file('dashboard/app/execution_detail.ts', `anchor.download = name;`),
      file('dashboard/app/start_form.ts', `form.action = target;`),
    ]);

    expect(violations.length).toBe(3);
    expect(violations.every((v) => v.rule === 'dom-sink-bracket')).toBe(true);
  });

  it('accepts the bracketed write it asks for', () => {
    const violations = checkConventions([
      file('dashboard/app/execution_detail.ts', `anchor['href'] = url;`),
    ]);

    expect(violations).toEqual([]);
  });

  it('reads a comparison as a comparison rather than a write', () => {
    const violations = checkConventions([
      file('dashboard/app/router.ts', `if (link.href === current) return;`),
    ]);

    expect(violations).toEqual([]);
  });

  /**
   * A `lit` binding is template syntax, not a property write: bracket notation
   * cannot express it, so flagging it would leave a violation nobody can fix.
   */
  it('leaves a lit template binding alone', () => {
    const violations = checkConventions([
      file(
        'dashboard/app/action_bar.ts',
        'return html`<a .href=${url}>open</a>`;',
      ),
    ]);

    expect(violations).toEqual([]);
  });

  // The engine has no DOM, and `src/` has its own field named `action` waiting
  // to be invented. This rule is about browser code and says so.
  it('asks nothing of code that never touches a document', () => {
    const violations = checkConventions([
      file('src/server/server_core.ts', `record.action = 'terminate';`),
      file('dashboard/server/main.ts', `response.src = body;`),
    ]);

    expect(violations).toEqual([]);
  });
});

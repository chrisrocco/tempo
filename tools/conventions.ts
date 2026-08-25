/**
 * @fileoverview
 * The conventions a text scan can decide, over every hand-written file in the
 * repo — not just the ones a tsconfig happens to include.
 *
 * Three checkers live in `tools/` and the split between them is about what a
 * rule needs in order to answer:
 *
 * -   [`boundaries.ts`](boundaries.ts) asks architectural questions about
 *     `src/` — which layer may import which, and what may not appear on the
 *     deterministic side.
 * -   [`style.ts`](style.ts) asks questions only a type checker can answer — is
 *     this expression a promise, is this `await` at module scope — and so it
 *     builds a real TypeScript program.
 * -   This file asks questions about the *shape of the source text*, which today
 *     is one question asked two ways: how an import is spelled.
 *
 * The third one is not a variation on the second. A program only sees files
 * some tsconfig included, and `tools/` is in none of them — which is exactly
 * where the first violation of the import rule was found. A rule about how the
 * whole repo is written has to be able to read the whole repo, so it reads the
 * tree directly (`CHECKED_DIRS`) and stays a pure function of file contents so
 * planted breakage can be tested against it (spec/conventions.spec.ts).
 *
 * Two rules. Both are about how an import is spelled, and both apply to every
 * hand-written file here:
 *
 * 1. **Namespace imports, never default imports.** `import * as path from
 *    'node:path'`, not `import path from 'node:path'`. A default import of a
 *    CommonJS module is a binding `esModuleInterop` invents; the module never
 *    exported it. That makes the line mean different things under different
 *    compiler settings, and it means the same module gets spelled two ways in
 *    one repo — which is how it was found, `tools/style.ts` importing `* as
 *    path` while `tools/boundaries.ts` next door imported the default. A
 *    namespace import names what the module actually exports and reads the same
 *    everywhere.
 *
 * 2. **No importing this package by its own name.** `../../src/libraries/schema`,
 *    not `workflow-engine/schema`. A self-reference resolves only under a
 *    resolver that reads this package's own `exports` map; the build system that
 *    consumes this repo does not, so one costs that consumer a local patch on
 *    every sync. It is here rather than in `boundaries.ts` for the same reason
 *    rule 1 is: `tools/` and `spec/` are in no tsconfig, and the one violation
 *    this rule has ever had was in `spec/`.
 *
 * The file keeps its plural shape — a violation type with a `rule` field, a
 * dispatch loop, a formatter — because the reach is what makes it worth having,
 * and the next rule about how the source text is written lands here rather than
 * in a checker that has to be invented first.
 */

import {readSourceFiles, stripCommentsAndStrings} from './boundaries';
import type {SourceFile} from './boundaries';

/** A convention violation, located precisely enough to jump to. */
export interface ConventionViolation {
  path: string;
  line: number;
  rule: 'namespace-import' | 'self-reference-import';
  message: string;
}

/**
 * This package's own name, which nothing in the tree may import itself by.
 *
 * Held here rather than read from `package.json` so the checker stays a pure
 * function of file contents; `spec/conventions.spec.ts` pins it against the
 * manifest, so a rename cannot leave the rule quietly matching nothing.
 */
export const PACKAGE_NAME = 'workflow-engine';

/**
 * Every directory of hand-written source in the repo. Wider than the boundary
 * checker's `src` on purpose: these rules are about how code is written, and
 * `tools/` and `spec/` are written by the same hands.
 */
export const CHECKED_DIRS = ['bin', 'spec', 'src', 'tools'] as const;

/**
 * Blank the *bodies* of string and template literals, keeping the quotes and
 * the line count.
 *
 * `stripCommentsAndStrings` deliberately keeps string contents so import
 * specifiers stay readable, which is right for the boundary rules and wrong
 * here: a spec that plants `import fs from 'node:fs'` inside a template literal
 * to prove the rule catches it would otherwise be reported as breaking the rule
 * it is testing. The rule only needs the *shape* of a line — a default binding
 * before `from` — so it reads the blanked text and never the specifier.
 */
function blankStringBodies(strippedText: string): string {
  return strippedText.replace(
    /(['"`])([\s\S]*?)\1/g,
    (_match, quote: string, body: string) =>
      `${quote}${body.replace(/[^\n]/g, ' ')}${quote}`,
  );
}

/** `import x from '…'`, with or without a `type` keyword or a named clause. */
const DEFAULT_IMPORT =
  /^\s*import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*)\s*)?from\s+['"]/;

function checkNamespaceImports(
  file: SourceFile,
  blanked: string,
): ConventionViolation[] {
  const violations: ConventionViolation[] = [];
  blanked.split('\n').forEach((lineText, index) => {
    const match = DEFAULT_IMPORT.exec(lineText);
    if (!match) return;
    violations.push({
      path: file.path,
      line: index + 1,
      rule: 'namespace-import',
      message: `default import '${match[1]}' — write \`import * as ${match[1]} from …\`. A default import of a CommonJS module is a binding esModuleInterop invents rather than one the module exports, so the line means different things under different compiler settings`,
    });
  });
  return violations;
}

/**
 * An import of this package by its own published name, in any of the four
 * spellings that resolve one: `from '…'`, a side-effect `import '…'`, a dynamic
 * `import('…')`, and `require('…')`.
 *
 * Anchored on the importing keyword rather than on the quoted string alone,
 * because the specifier is not the only place the package name is written —
 * `describe('workflow-engine/schema — …')` names the surface a spec covers, and
 * reporting that would make the rule something contributors work around.
 */
const SELF_REFERENCE = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]` +
    PACKAGE_NAME +
    String.raw`(?:\/[^'"]*)?['"]`,
);

/**
 * Reads the *stripped* text rather than the blanked text the rule above uses:
 * this one is about the specifier itself, and `stripCommentsAndStrings` keeps
 * string contents for exactly that reason.
 */
function checkSelfReferenceImports(
  file: SourceFile,
  strippedText: string,
): ConventionViolation[] {
  const violations: ConventionViolation[] = [];
  strippedText.split('\n').forEach((lineText, index) => {
    if (!SELF_REFERENCE.test(lineText)) return;
    violations.push({
      path: file.path,
      line: index + 1,
      rule: 'self-reference-import',
      message: `imports '${PACKAGE_NAME}' by package name — use a relative path. A package self-reference resolves only under a resolver that reads this package's own \`exports\` map, and the build system downstream does not, so one costs that consumer a patch on every sync. See the note in tsconfig.json`,
    });
  });
  return violations;
}

/**
 * Check every supplied file against the conventions. Pure: it takes file
 * contents and returns violations, so the rules can be tested against
 * deliberately planted breakage rather than only against code that passes.
 */
export function checkConventions(files: SourceFile[]): ConventionViolation[] {
  const violations: ConventionViolation[] = [];
  for (const file of files) {
    const stripped = stripCommentsAndStrings(file.text);
    violations.push(
      ...checkNamespaceImports(file, blankStringBodies(stripped)),
      ...checkSelfReferenceImports(file, stripped),
    );
  }
  return violations;
}

/** Read every directory the conventions cover. */
export function readCheckedFiles(root: string): SourceFile[] {
  return readSourceFiles(root, [...CHECKED_DIRS]);
}

/** Format violations for a terminal, grouped so the output is scannable. */
export function formatConventionViolations(
  violations: ConventionViolation[],
): string {
  return violations
    .map((v) => `${v.path}:${v.line}  [${v.rule}]\n    ${v.message}`)
    .join('\n\n');
}

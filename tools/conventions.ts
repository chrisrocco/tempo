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
 *     is one question: how an import is spelled.
 *
 * The third one is not a variation on the second. A program only sees files
 * some tsconfig included, and `tools/` is in none of them — which is exactly
 * where the first violation of the import rule was found. A rule about how the
 * whole repo is written has to be able to read the whole repo, so it reads the
 * tree directly (`CHECKED_DIRS`) and stays a pure function of file contents so
 * planted breakage can be tested against it (spec/conventions.spec.ts).
 *
 * Two rules, and there used to be four others. Three were the dashboard's — a
 * harness import its specs needed, bracket notation on DOM sinks, and a bundle
 * format that had to agree with the shell's `<script>` tag — and they went with
 * it. What is left applies to every hand-written file here:
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
 * 2. **A `see` pointer must resolve.** AGENTS.md has always said "don't leave a
 *    pointer to something that no longer exists", and this is that sentence
 *    checked rather than trusted. A moved file leaves comments elsewhere
 *    directing the next reader to where it used to be, and nothing fails — the
 *    pointer is simply believed. Deliberately narrow: prose legitimately names
 *    paths that are hypothetical or rejected (`remote_client.ts` has a heading
 *    "Why it is not `src/client.ts`"), so only a `see` is treated as a promise
 *    that the target is there. See `checkSeePointers` for why that line is
 *    where it is.
 *
 * The file kept its plural shape for exactly this — a violation type with a
 * `rule` field, a dispatch loop, a formatter — so the second rule landed here
 * rather than in a checker that had to be invented first.
 */

import {readSourceFiles, stripCommentsAndStrings} from './boundaries';
import type {SourceFile} from './boundaries';

/** A convention violation, located precisely enough to jump to. */
export interface ConventionViolation {
  path: string;
  line: number;
  rule: 'namespace-import' | 'dangling-pointer';
  message: string;
}

/**
 * Every directory of hand-written source in the repo. Wider than the boundary
 * checker's `src`/`examples` on purpose: these rules are about how code is
 * written, and `tools/` and `spec/` are written by the same hands.
 */
export const CHECKED_DIRS = [
  'bin',
  'examples',
  'spec',
  'src',
  'tools',
] as const;

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
 * Check every supplied file against the conventions. Pure: it takes file
 * contents and returns violations, so the rules can be tested against
 * deliberately planted breakage rather than only against code that passes.
 */
export function checkConventions(files: SourceFile[]): ConventionViolation[] {
  const violations: ConventionViolation[] = [];
  // The set the pointer rule resolves against is the file set it was handed,
  // which is what keeps it pure: "does this pointer resolve" is a question about
  // a tree, and the tree is the argument rather than the disk.
  const known = new Set(files.map((file) => file.path));
  for (const file of files) {
    const blanked = blankStringBodies(stripCommentsAndStrings(file.text));
    violations.push(...checkNamespaceImports(file, blanked));
    violations.push(...checkSeePointers(file, known));
  }
  return violations;
}

/**
 * A `see `path`` in prose that points at a file the tree does not contain.
 *
 * AGENTS.md has always said "don't leave a pointer to something that no longer
 * exists"; this is that sentence, checked. The failure it catches is specific
 * and quiet: a file is renamed or moved, and a comment elsewhere goes on
 * directing the next reader to where it used to be. Nothing fails, nothing
 * looks wrong, and the pointer is worse than no pointer because it is believed.
 *
 * ## Only `see` pointers, deliberately
 *
 * The obvious rule — every backticked repo path must resolve — is wrong, and
 * `remote_client.ts` is the counter-example: its heading is *"Why it is not
 * `src/client.ts`"*, a deliberate reference to a path that must **not** exist.
 * Prose legitimately names paths that are hypothetical, rejected, or historical.
 *
 * A `see` is different. It is an instruction to go and look, so it is exactly
 * the construct that promises the target is there. Narrowing to it is what makes
 * the rule zero-false-positive on this tree rather than a source of noise
 * someone would learn to ignore.
 *
 * Resolution allows an omitted `.ts` (`bin/server-main` is how this repo writes
 * it) and accepts a directory prefix, so `see `src/server/ports/`` is fine.
 */
export function checkSeePointers(
  file: SourceFile,
  known: ReadonlySet<string>,
): ConventionViolation[] {
  const violations: ConventionViolation[] = [];
  // Comments only — the exact inverse of `stripCommentsAndStrings`, and needed
  // for the same reason it exists. This checker's own spec plants `see` pointers
  // inside string literals, and a scan of raw text would read those fixtures as
  // real pointers and fail the repo against its own test data.
  const lines = commentsOnly(file.text).split('\n');
  lines.forEach((text, index) => {
    for (const match of text.matchAll(SEE_POINTER)) {
      const target = match[1];
      if (target === undefined || resolvesInTree(target, known)) continue;
      violations.push({
        path: file.path,
        line: index + 1,
        rule: 'dangling-pointer',
        message:
          `\`see ${target}\` points at a file this tree does not contain. ` +
          `Update the pointer, or drop it — a pointer to something that moved ` +
          `sends the next reader somewhere it is not.`,
      });
    }
  });
  return violations;
}

/** `see `<dir>/...`` where `<dir>` is one this checker reads. */
const SEE_POINTER = new RegExp(
  `[Ss]ee\\s+\`((?:${CHECKED_DIRS.join('|')})/[A-Za-z0-9_./-]+)\``,
  'g',
);

/**
 * Blank everything that is not inside a comment, preserving offsets so line
 * numbers still point where the reader expects.
 *
 * The mirror of `stripCommentsAndStrings` in `boundaries.ts`: that one exists so
 * a scan for code constructs never trips over prose, and this one so a scan for
 * prose never trips over code — including the string literals a spec plants
 * breakage in.
 */
export function commentsOnly(text: string): string {
  let out = '';
  let inBlock = false;
  let inLine = false;
  let quote: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const next = text[i + 1];

    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      } else out += c;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        out += '  ';
        i++;
      } else out += c === '\n' ? c : c;
      continue;
    }
    if (quote !== null) {
      if (c === '\\') {
        out += '  ';
        i++;
      } else if (c === quote) {
        quote = null;
        out += ' ';
      } else out += c === '\n' ? c : ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      out += '  ';
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      out += '  ';
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += ' ';
      continue;
    }
    out += c === '\n' ? c : ' ';
  }
  return out;
}

/** A path, the same path with `.ts`, or a directory something lives under. */
function resolvesInTree(target: string, known: ReadonlySet<string>): boolean {
  const trimmed = target.replace(/\/$/, '');
  if (known.has(trimmed) || known.has(`${trimmed}.ts`)) return true;
  for (const path of known) if (path.startsWith(`${trimmed}/`)) return true;
  return false;
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

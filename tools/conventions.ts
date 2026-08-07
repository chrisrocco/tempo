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
 * -   This file asks questions about the *shape of the source text*: how an
 *     import is spelled, what a spec declares, how a DOM write is written.
 *
 * The third one is not a variation on the second. A program only sees files
 * some tsconfig included, and `tools/` is in none of them — which is exactly
 * where the first violation of the import rule was found. A rule about how the
 * whole repo is written has to be able to read the whole repo, so it reads the
 * tree directly (`CHECKED_DIRS`) and stays a pure function of file contents so
 * planted breakage can be tested against it (spec/conventions.spec.ts).
 *
 * Three rules:
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
 * 2. **Dashboard specs import their harness.** Every `spec/dashboard/*.spec.ts`
 *    starts with `import 'jasmine';`. `describe`/`it`/`expect` otherwise arrive
 *    as ambient globals from `types: ['node', 'jasmine']` in the root tsconfig,
 *    which is a fact about the config rather than about the file. The dashboard
 *    is where that matters: its browser half already sets `types: []`
 *    (`dashboard/app/tsconfig.json`) so Node's globals are genuinely absent
 *    rather than merely discouraged, and these specs are the ones that would
 *    move under a config like it if they ever needed a DOM. The import survives
 *    that move — `import 'jasmine'` pulls the harness declarations in by name,
 *    with no `types` entry at all. The rest of the suite still leans on the root
 *    config, which is why the rule is scoped here rather than to all of `spec/`.
 *
 * 3. **DOM sink writes use bracket notation.** In `dashboard/app/`, a write to
 *    one of the properties in `DOM_SINKS` is spelled `el['href'] = …`.
 *
 *    A DOM security scanner (Trusted Types conformance checkers such as `tsec`)
 *    matches these sinks by property-access *syntax*, and the report it produces
 *    is only worth reading if everything left in it is unreviewed. Bracket
 *    notation is how a write says "someone looked at this" — which means it is a
 *    claim, and the claim has to be true: **the notation changes what a scanner
 *    matches, not what the browser does.** The value being assigned is exactly
 *    as safe or unsafe as it was. So the rule comes with an obligation the
 *    checker cannot enforce — a comment at the write saying why the value is
 *    safe. `execution_detail.ts`'s export anchor is the worked example: the URL
 *    is an object URL the method itself minted from a blob it built.
 *
 *    Scoped to `dashboard/app/` because that is the only browser code here.
 *    Deliberately *not* extended to the `.href=${…}` bindings inside `lit`
 *    templates: those are template syntax rather than a property write, bracket
 *    notation cannot express them, and the string scan below does not see inside
 *    a template literal anyway.
 *
 * 4. **The shell loads a classic script, and the bundle is built to match.** A
 *    downstream build system consumes `dashboard/app/index.html` and does not
 *    accept `type="module"`, so the shell carries a plain `<script defer>`.
 *
 *    That constrains the *bundle*, which is why this is two checks and not one.
 *    esbuild's ESM output carries `import`/`export` statements as soon as the
 *    entry exports something or a dependency is left external, and those are a
 *    syntax error in a classic script — the page dies before rendering. Today's
 *    entry does neither, so the formats differ only by the wrapper; the rule is
 *    what stops the first export from turning the page blank. So the esbuild
 *    invocation in `dashboard/package.json` must stay `--format=iife`. Neither
 *    file mentions the other and each looks perfectly correct on its own, which
 *    is the shape of coupling worth having a checker for.
 *
 *    HTML comments are stripped before the scan, so the comment in `index.html`
 *    explaining the rule does not trip it.
 */

import {readFileSync} from 'node:fs';
import * as path from 'node:path';
import {readSourceFiles, stripCommentsAndStrings} from './boundaries';
import type {SourceFile} from './boundaries';

/** A convention violation, located precisely enough to jump to. */
export interface ConventionViolation {
  path: string;
  line: number;
  rule:
    | 'namespace-import'
    | 'spec-harness-import'
    | 'dom-sink-bracket'
    | 'classic-script'
    | 'bundle-format';
  message: string;
}

/**
 * Every directory of hand-written source in the repo. Wider than the boundary
 * checker's `src`/`examples` on purpose: these rules are about how code is
 * written, and `tools/` and `spec/` are written by the same hands.
 *
 * `dashboard/` is listed by its two halves rather than whole, so a build in
 * `dashboard/dist/` is never mistaken for source.
 */
export const CHECKED_DIRS = [
  'bin',
  'dashboard/app',
  'dashboard/server',
  'examples',
  'spec',
  'src',
  'tools',
] as const;

/**
 * The DOM properties whose assignment a security scanner treats as a sink.
 * Short and specific: a long list of maybe-sinks trains people to skip the rule.
 */
const DOM_SINKS = [
  'innerHTML',
  'outerHTML',
  'href',
  'src',
  'srcdoc',
  'download',
  'action',
  'formAction',
] as const;

/** Where rule 2 applies: the dashboard's specs, and only those. */
function isDashboardSpec(filePath: string): boolean {
  return /^spec\/dashboard\/.+\.spec\.ts$/.test(filePath);
}

/** Where rule 3 applies: the browser half of the dashboard. */
function isBrowserCode(filePath: string): boolean {
  return filePath.startsWith('dashboard/app/');
}

/**
 * The manifest whose build command has to agree with the shell. Read as a file
 * like everything else, so the rule stays a pure function of file contents.
 */
export const BUNDLE_MANIFEST = 'dashboard/package.json';

/**
 * Blank the *bodies* of string and template literals, keeping the quotes and
 * the line count.
 *
 * `stripCommentsAndStrings` deliberately keeps string contents so import
 * specifiers stay readable, which is right for the boundary rules and wrong
 * here: a spec that plants `import fs from 'node:fs'` inside a template literal
 * to prove the rule catches it would otherwise be reported as breaking the rule
 * it is testing. Rules that only need the *shape* of a line run on this; rule 2,
 * which has to know that the specifier is `jasmine`, runs on the text that still
 * has its specifiers.
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

function checkSpecHarnessImport(
  file: SourceFile,
  stripped: string,
): ConventionViolation[] {
  if (/^\s*import\s+['"]jasmine['"]\s*;?\s*$/m.test(stripped)) return [];
  return [
    {
      path: file.path,
      line: 1,
      rule: 'spec-harness-import',
      message:
        "a dashboard spec names its harness: add `import 'jasmine';` above the other imports. describe/it/expect otherwise depend on the root tsconfig's ambient `types`, which is a fact about the config rather than about this file",
    },
  ];
}

function checkDomSinkBrackets(
  file: SourceFile,
  blanked: string,
): ConventionViolation[] {
  const violations: ConventionViolation[] = [];
  blanked.split('\n').forEach((lineText, index) => {
    for (const sink of DOM_SINKS) {
      // An assignment, not a comparison and not an arrow: `=` alone, and the
      // compound forms (`||=`, `??=`) that are assignments too.
      const write = new RegExp(`\\.\\s*${sink}\\s*(?:\\|\\||&&|\\?\\?)?=(?!=)`);
      if (!write.test(lineText)) continue;
      violations.push({
        path: file.path,
        line: index + 1,
        rule: 'dom-sink-bracket',
        message: `write this sink as \`['${sink}'] = …\` — a DOM security scanner matches \`.${sink} =\` by syntax, and bracket notation is how a write says it has been reviewed. Say why the value is safe in a comment at the assignment; the notation changes what a scanner matches, not what the browser does`,
      });
    }
  });
  return violations;
}

/**
 * A page's `<script>` tags must be classic. Comments are blanked first, so the
 * note in `index.html` explaining this rule is not read as breaking it.
 */
function checkClassicScript(file: SourceFile): ConventionViolation[] {
  const withoutComments = file.text.replace(/<!--[\s\S]*?-->/g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
  const violations: ConventionViolation[] = [];
  withoutComments.split('\n').forEach((lineText, index) => {
    if (!/<script\b[^>]*\btype\s*=\s*["']module["']/.test(lineText)) return;
    violations.push({
      path: file.path,
      line: index + 1,
      rule: 'classic-script',
      message:
        'load this as a classic script — `<script defer src="…">`, no `type="module"`. A downstream build system consumes this shell and does not accept a module script. `defer` keeps the timing a module had: run after parsing, so the elements below are already in the document',
    });
  });
  return violations;
}

/**
 * The other half of rule 4: the bundle behind a classic script cannot be ESM.
 *
 * Checked against the build command rather than the built file, so it fails at
 * lint time rather than in a browser, and so it fails *now* rather than on the
 * day the entry grows an export — which is when an ESM bundle would start
 * emitting the module syntax a classic script cannot parse.
 */
function checkBundleFormat(file: SourceFile): ConventionViolation[] {
  const violations: ConventionViolation[] = [];
  file.text.split('\n').forEach((lineText, index) => {
    if (!/--format=(esm|es6|module)\b/.test(lineText)) return;
    violations.push({
      path: file.path,
      line: index + 1,
      rule: 'bundle-format',
      message:
        'build this bundle `--format=iife`: the shell loads it as a classic script (see dashboard/app/index.html), and esbuild ESM output carries `import`/`export` as soon as the entry exports something or a dependency goes external — a syntax error in a classic script, and a blank page with both files looking correct',
    });
  });
  return violations;
}

/**
 * Check every supplied file against the conventions. Pure: it takes file
 * contents and returns violations, so the rules can be tested against
 * deliberately planted breakage rather than only against code that passes.
 *
 * Dispatched on what the file *is*: the TypeScript rules would read an HTML
 * page or a manifest as source and report nonsense about both.
 */
export function checkConventions(files: SourceFile[]): ConventionViolation[] {
  const violations: ConventionViolation[] = [];
  for (const file of files) {
    if (file.path.endsWith('.html')) {
      violations.push(...checkClassicScript(file));
      continue;
    }
    if (file.path === BUNDLE_MANIFEST) {
      violations.push(...checkBundleFormat(file));
      continue;
    }

    const stripped = stripCommentsAndStrings(file.text);
    const blanked = blankStringBodies(stripped);

    violations.push(...checkNamespaceImports(file, blanked));
    if (isDashboardSpec(file.path))
      violations.push(...checkSpecHarnessImport(file, stripped));
    if (isBrowserCode(file.path))
      violations.push(...checkDomSinkBrackets(file, blanked));
  }
  return violations;
}

/**
 * Read every directory the conventions cover, plus the one manifest a rule is
 * about. `.html` comes along because the shell is source too — it is written by
 * hand and shipped as-is.
 */
export function readCheckedFiles(root: string): SourceFile[] {
  const files = readSourceFiles(root, [...CHECKED_DIRS], ['.ts', '.html']);
  files.push({
    path: BUNDLE_MANIFEST,
    text: readFileSync(path.join(root, BUNDLE_MANIFEST), 'utf8'),
  });
  return files;
}

/** Format violations for a terminal, grouped so the output is scannable. */
export function formatConventionViolations(
  violations: ConventionViolation[],
): string {
  return violations
    .map((v) => `${v.path}:${v.line}  [${v.rule}]\n    ${v.message}`)
    .join('\n\n');
}

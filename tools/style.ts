/**
 * @fileoverview
 * The style rules that need to understand the code, not just match text.
 *
 * `boundaries.ts` next door works on stripped source with regexes, which is
 * right for its questions — "does this file import that layer?" is answerable
 * from the import list. The rules here are not: whether an expression is a
 * promise is a question about *types*, and whether an `await` is top-level is a
 * question about *scope*. Both need the TypeScript program, so this checker
 * builds one rather than guessing from syntax.
 *
 * Four rules, each with a failure it exists to prevent:
 *
 * 1. **Floating promises.** An unawaited promise whose rejection nobody handles
 *    is an unhandled rejection, which Node treats as fatal. This repo has already
 *    lost a server to one (`ServerHost.createAndEnqueue`, before it grew a
 *    `.catch`). Writing `void` in front is not ceremony — it is the difference
 *    between a deliberate fire-and-forget and a forgotten `await`, and only the
 *    author knows which one it was.
 *
 * 2. **Top-level await, anywhere.** The Node half of this repo is CommonJS
 *    (`tsconfig.json` says why), and CommonJS has no top-level await — it is
 *    TS1378, and a module that uses it does not run at all. This rule used to
 *    cover `bin/` alone, back when the project was ESM and the concern was an
 *    entrypoint quietly constraining how everything else could be compiled.
 *    Entrypoints use `void run().then(…)`; so does everyone else now.
 *
 * 3. **`import.meta`.** The same constraint, one level worse: a *syntax* error
 *    under CommonJS rather than a diagnostic, so a single use breaks the file
 *    for every reader of it. `__dirname` is what to reach for instead — the
 *    reason the repo is CommonJS at all is a downstream build system that takes
 *    `__dirname` and rejects `import.meta`.
 *
 * 4. **Unqualified browser globals in `dashboard/app/`.** `window.localStorage`,
 *    not `localStorage` — see `WINDOW_GLOBALS` for the list and the reasoning.
 *
 * Rule 3 is a text scan; the others walk the AST. They live together because
 * they answer one question — "will this still compile where it has to, and does
 * it say what it depends on?" — and a second tool would mean a second program
 * build, which is the slow part.
 *
 * Rule 4 in particular is here rather than in `tools/conventions.ts` next door
 * because it cannot be decided from text: `dashboard/app/routes.ts` declares a
 * local named `history`, and the bare word appears over a hundred times across
 * the app in a codebase whose whole subject is execution history. Only the
 * checker can tell the global from the variable — which is the same reason the
 * rule is worth having, since a reader can too, but only by going and looking.
 */

import * as path from 'node:path';
import * as ts from 'typescript';

/** A style violation, located precisely enough to jump to. */
export interface StyleViolation {
  path: string;
  line: number;
  rule:
    'floating-promise' | 'top-level-await' | 'import-meta' | 'window-global';
  message: string;
}

/**
 * Where top-level `await` is checked: everywhere. Kept as a named constant
 * because it was `['bin/']` until the Node half became CommonJS, and the empty
 * prefix is the whole change — worth being able to see rather than infer.
 */
const TOP_LEVEL_AWAIT_DIRS = [''];

/** Directories that run in a browser, where `window` is the ambient object. */
const BROWSER_DIRS = ['dashboard/app/'];

/**
 * The browser globals that must be written as `window.x`.
 *
 * **What is on the list**: the state and services `window` owns — storage, the
 * URL, the session's history, the document, timers, the network, listeners.
 * Written bare, each of these is indistinguishable at the call site from an
 * import or a local, and the reader cannot tell without checking which. `window.`
 * says "ambient, browser, not ours" in the one place it matters.
 *
 * That is not pedantry in *this* repo: the dashboard's other half is Node, where
 * `fetch`, `setTimeout`, and `navigator` all exist with different types and
 * different behaviour, and the two halves are edited in the same sitting. A
 * qualified name says which environment the line assumes.
 *
 * **What is not**: global *constructors* — `URL`, `Blob`, `Date`, `CustomEvent`.
 * They are types as much as values, `new window.Blob()` reads as a mistake, and
 * nothing about them is ambient state. The rule is about what the window *has*,
 * not about everything it happens to expose.
 */
const WINDOW_GLOBALS = new Set([
  'addEventListener',
  'alert',
  'cancelAnimationFrame',
  'clearInterval',
  'clearTimeout',
  'confirm',
  'document',
  'fetch',
  'getComputedStyle',
  'history',
  'innerHeight',
  'innerWidth',
  'localStorage',
  'location',
  'matchMedia',
  'navigator',
  'prompt',
  'removeEventListener',
  'requestAnimationFrame',
  'scrollTo',
  'sessionStorage',
  'setInterval',
  'setTimeout',
]);

function isPromiseLike(type: ts.Type, checker: ts.TypeChecker): boolean {
  // A union counts if any arm is thenable — `Promise<T> | undefined` still needs
  // handling, and that shape shows up wherever a call is conditional.
  if (type.isUnion()) return type.types.some((t) => isPromiseLike(t, checker));
  const then = type.getProperty('then');
  if (!then) return false;
  const declaration = then.valueDeclaration ?? then.declarations?.[0];
  if (!declaration) return false;
  const thenType = checker.getTypeOfSymbolAtLocation(then, declaration);
  return thenType.getCallSignatures().length > 0;
}

/**
 * Is this expression statement already accounted for?
 *
 * `void x`, `await x`, and `yield x` all say the author saw the promise. So does
 * an **assignment**: `stopping ??= work()` stores the promise for someone else to
 * await, and the statement's *value* being a promise is incidental. Missing that
 * case is the checker's most likely false positive, and it fired on real code
 * (`Tempo.startWorker`'s idempotent `stop`) the first time this ran.
 */
function isDischarged(expression: ts.Expression): boolean {
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return true;
  return (
    ts.isVoidExpression(expression) ||
    ts.isAwaitExpression(expression) ||
    ts.isYieldExpression(expression)
  );
}

/** True when `node` sits outside every function, i.e. at module scope. */
function isTopLevel(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isConstructorDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p)
    )
      return false;
  }
  return true;
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

/**
 * True when this identifier *names* something rather than reading it — a
 * declaration, a property key, an imported binding. `const history = …` is the
 * case that matters: naming a local after a global is legal, and this rule is
 * about reads.
 */
function isNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isQualifiedName(parent)) return parent.right === node;
  if (ts.isPropertyAssignment(parent)) return parent.name === node;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  if (ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  );
}

/**
 * True when the name resolves to a declaration in TypeScript's own lib files —
 * i.e. it really is the ambient global and not something the repo declared. This
 * is the whole reason the rule needs a program: `routes.ts`'s local `history` and
 * `window.history` are the same nine characters and different symbols.
 */
function resolvesToLibGlobal(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  const declarations = symbol?.getDeclarations();
  if (!declarations || declarations.length === 0) return false;
  return declarations.every((declaration) => {
    const file = declaration.getSourceFile();
    return file.isDeclarationFile && /\/lib\.[^/]+\.d\.ts$/.test(file.fileName);
  });
}

/**
 * Check every file in `program` that lives under `root`. Declaration files and
 * anything outside the repo (node_modules, lib.d.ts) are skipped.
 */
export function checkStyle(
  program: ts.Program,
  root: string,
): StyleViolation[] {
  const checker = program.getTypeChecker();
  const violations: StyleViolation[] = [];

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue;
    const relative = path
      .relative(root, file.fileName)
      .split(path.sep)
      .join('/');
    if (relative.startsWith('..') || relative.includes('node_modules'))
      continue;

    const bansTopLevelAwait = TOP_LEVEL_AWAIT_DIRS.some((d) =>
      relative.startsWith(d),
    );
    const isBrowser = BROWSER_DIRS.some((d) => relative.startsWith(d));

    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node) && !isDischarged(node.expression)) {
        const type = checker.getTypeAtLocation(node.expression);
        if (isPromiseLike(type, checker))
          violations.push({
            path: relative,
            line: lineOf(file, node),
            rule: 'floating-promise',
            message:
              'this promise is neither awaited nor voided — an unhandled rejection is fatal to the process; write `void` in front if that is deliberate',
          });
      }

      if (bansTopLevelAwait && ts.isAwaitExpression(node) && isTopLevel(node))
        violations.push({
          path: relative,
          line: lineOf(file, node),
          rule: 'top-level-await',
          message:
            'top-level await does not exist in CommonJS (TS1378), and the Node half of this repo is CommonJS — use `void fn().then(…)`',
        });

      if (
        isBrowser &&
        ts.isIdentifier(node) &&
        WINDOW_GLOBALS.has(node.text) &&
        !isNamePosition(node) &&
        resolvesToLibGlobal(node, checker)
      )
        violations.push({
          path: relative,
          line: lineOf(file, node),
          rule: 'window-global',
          message: `write this as \`window.${node.text}\` — bare, it reads like an import or a local, and the dashboard's other half is Node, where several of these names exist with different behaviour`,
        });

      ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);

    // A text scan, because `import.meta` is a syntax error under CommonJS rather
    // than something the parser hands back as a node worth inspecting.
    file.text.split('\n').forEach((text, index) => {
      const stripped = text.replace(/\/\/.*$/, '').replace(/\*.*$/, '');
      if (/\bimport\s*\.\s*meta\b/.test(stripped))
        violations.push({
          path: relative,
          line: index + 1,
          rule: 'import-meta',
          message:
            'import.meta is unavailable under some module targets — resolve paths with path.resolve() from the working directory instead',
        });
    });
  }

  return violations;
}

/**
 * Build a program from one of the repo's tsconfigs, so the rules see what
 * `tsc` sees.
 *
 * `configFile` is relative to `root` because there is more than one: the engine
 * and the dashboard are checked under different libs (Node vs. DOM) and so
 * cannot share a program. The floating-promise rule matters on both sides — a
 * dropped promise in a custom element is a swallowed error rather than a dead
 * process, which is quieter and therefore worse.
 */
export function programFor(
  root: string,
  configFile = 'tsconfig.json',
): ts.Program {
  const configPath = path.join(root, configFile);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
  );
  return ts.createProgram(parsed.fileNames, parsed.options);
}

/** Format violations for a terminal, grouped so the output is scannable. */
export function formatStyleViolations(violations: StyleViolation[]): string {
  return violations
    .map((v) => `${v.path}:${v.line}  [${v.rule}]\n    ${v.message}`)
    .join('\n\n');
}

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
 * Three rules, each with a failure it exists to prevent:
 *
 * 1. **Floating promises.** An unawaited promise whose rejection nobody handles
 *    is an unhandled rejection, which Node treats as fatal. This repo has already
 *    lost a server to one (`ServerHost.createAndEnqueue`, before it grew a
 *    `.catch`). Writing `void` in front is not ceremony — it is the difference
 *    between a deliberate fire-and-forget and a forgotten `await`, and only the
 *    author knows which one it was.
 *
 * 2. **Top-level await in `bin/`.** Legal only under some module targets
 *    (TS1378). An entrypoint that uses it quietly constrains how the whole
 *    project may be compiled.
 *
 * 3. **`import.meta`.** Same reason, one level worse: it is a syntax error under
 *    CommonJS output rather than a diagnostic. Path resolution goes through
 *    `path.resolve` from the working directory instead.
 *
 * Rule 3 is a text scan; the other two walk the AST. They live together because
 * they answer one question — "will this still compile where it has to?" — and a
 * second tool would mean a second program build, which is the slow part.
 */

import * as path from 'node:path';
import ts from 'typescript';

/** A style violation, located precisely enough to jump to. */
export interface StyleViolation {
  path: string;
  line: number;
  rule: 'floating-promise' | 'top-level-await' | 'import-meta';
  message: string;
}

/** Directories whose entrypoints must stay compilable under any module target. */
const ENTRYPOINT_DIRS = ['bin/'];

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

    const isEntrypoint = ENTRYPOINT_DIRS.some((d) => relative.startsWith(d));

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

      if (isEntrypoint && ts.isAwaitExpression(node) && isTopLevel(node))
        violations.push({
          path: relative,
          line: lineOf(file, node),
          rule: 'top-level-await',
          message:
            'top-level await is legal only under some module targets (TS1378) — use `void fn().then(…)` so the entrypoint does not constrain the build',
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

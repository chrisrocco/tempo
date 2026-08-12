/**
 * @fileoverview
 * `npm run lint` — the four checkers, over the whole repo, exiting non-zero on
 * any violation. `boundaries` answers "is this in the right layer, and is the
 * deterministic side still pure?"; `style` answers "will this still compile
 * where it has to, and is every promise accounted for?"; `conventions` answers
 * "is this written the way this repo writes things?"; `dependencies` answers
 * "did anything get installed that we did not agree to carry?".
 *
 * Several of them are thinner than they were: the dashboard is gone, and with it
 * the rules that were only ever about a browser. Each checker's `@fileoverview`
 * says which of its rules left.
 *
 * The boundary, dependency, and convention rules also run inside the suite
 * (spec/architecture.spec.ts, spec/conventions.spec.ts), so CI enforces them
 * even if nobody runs this. The style rules do not: they need a full TypeScript
 * program, which takes seconds to build and would be the slowest thing in an
 * otherwise fast suite. They run here and in CI's lint step.
 */

import * as path from 'node:path';
import {checkBoundaries, formatViolations, readSourceFiles} from './boundaries';
import {
  CHECKED_DIRS,
  checkConventions,
  formatConventionViolations,
  readCheckedFiles,
} from './conventions';
import {
  checkRepoDependencies,
  formatDependencyViolations,
} from './dependencies';
import {checkStyle, formatStyleViolations, programFor} from './style';

// Resolved from this file rather than from the working directory, so the same
// answer comes back under `npm run lint`, under an editor task, and under a
// build system that picks its own cwd. `import.meta` is banned repo-wide (see
// tools/style.ts); `__dirname` is what CommonJS gives instead.
const root = path.resolve(__dirname, '..');

const files = readSourceFiles(root, ['src', 'examples']);
const boundaryViolations = checkBoundaries(files);
if (boundaryViolations.length === 0) {
  console.log(`boundaries: clean (${files.length} files checked)`);
} else {
  console.error(formatViolations(boundaryViolations));
  console.error(
    `\nboundaries: ${boundaryViolations.length} violation(s) across ${files.length} files checked`,
  );
}

// Wider than the boundary rules on purpose: how an import is spelled is a
// question about every hand-written file, including the ones (`tools/`, `spec/`)
// that no tsconfig includes.
const checkedFiles = readCheckedFiles(root);
const conventionViolations = checkConventions(checkedFiles);
if (conventionViolations.length === 0) {
  console.log(
    `conventions: clean (${checkedFiles.length} files across ${CHECKED_DIRS.length} directories)`,
  );
} else {
  console.error(formatConventionViolations(conventionViolations));
  console.error(
    `\nconventions: ${conventionViolations.length} violation(s) across ${checkedFiles.length} files checked`,
  );
}

const dependencyViolations = checkRepoDependencies(root);
if (dependencyViolations.length === 0) {
  console.log('dependencies: clean (allowlist in tools/dependencies.ts)');
} else {
  console.error(formatDependencyViolations(dependencyViolations));
  console.error(`\ndependencies: ${dependencyViolations.length} violation(s)`);
}

// One program. It was three while the dashboard was here — its server half and
// its browser half are checked under different libs than the engine, and no
// single program can hold two libs at once.
const styleViolations = checkStyle(programFor(root), root);
if (styleViolations.length === 0) {
  console.log('style: clean (floating promises, top-level await, import.meta)');
} else {
  console.error(formatStyleViolations(styleViolations));
  console.error(`\nstyle: ${styleViolations.length} violation(s)`);
}

const total =
  boundaryViolations.length +
  conventionViolations.length +
  dependencyViolations.length +
  styleViolations.length;
process.exit(total === 0 ? 0 : 1);

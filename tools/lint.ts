/**
 * @fileoverview
 * `npm run lint` — the three checkers, over the whole repo, exiting non-zero on
 * any violation. `boundaries` answers "is this in the right layer, and is the
 * deterministic side still pure?"; `style` answers "will this still compile
 * where it has to, and is every promise accounted for?"; `dependencies` answers
 * "did anything get installed that we did not agree to carry?".
 *
 * The boundary and dependency rules also run inside the suite
 * (spec/architecture.spec.ts), so CI enforces them even if nobody runs this. The
 * style rules do not: they need a full TypeScript program, which takes seconds
 * to build and would be the slowest thing in an otherwise fast suite. They run
 * here and in CI's lint step.
 */

import path from 'node:path';
import {checkBoundaries, formatViolations, readSourceFiles} from './boundaries';
import {
  checkRepoDependencies,
  formatDependencyViolations,
} from './dependencies';
import {checkStyle, formatStyleViolations, programFor} from './style';

// Resolved from the working directory: `import.meta` is banned repo-wide (see
// tools/style.ts), and npm scripts always run from the repo root.
const root = path.resolve('.');

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

const dependencyViolations = checkRepoDependencies(root);
if (dependencyViolations.length === 0) {
  console.log('dependencies: clean (allowlist in tools/dependencies.ts)');
} else {
  console.error(formatDependencyViolations(dependencyViolations));
  console.error(`\ndependencies: ${dependencyViolations.length} violation(s)`);
}

const program = programFor(root);
const styleViolations = checkStyle(program, root);
if (styleViolations.length === 0) {
  console.log('style: clean (floating promises, top-level await, import.meta)');
} else {
  console.error(formatStyleViolations(styleViolations));
  console.error(`\nstyle: ${styleViolations.length} violation(s)`);
}

const total =
  boundaryViolations.length +
  dependencyViolations.length +
  styleViolations.length;
process.exit(total === 0 ? 0 : 1);

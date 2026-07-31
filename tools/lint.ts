/**
 * @fileoverview
 * `npm run lint` — run the determinism-boundary checker over the repo and exit
 * non-zero on any violation. The same rules run inside the suite
 * (spec/architecture.spec.ts), so CI enforces them even if nobody runs this;
 * this entrypoint exists for the fast local check and for a pre-commit hook.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkBoundaries,
  formatViolations,
  readSourceFiles,
} from './boundaries';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = readSourceFiles(root, ['src', 'examples']);
const violations = checkBoundaries(files);

if (violations.length === 0) {
  console.log(`boundaries: clean (${files.length} files checked)`);
  process.exit(0);
}

console.error(formatViolations(violations));
console.error(
  `\nboundaries: ${violations.length} violation(s) across ${files.length} files checked`,
);
process.exit(1);

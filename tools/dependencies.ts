/**
 * @fileoverview
 * The dependency allowlist: what this project is permitted to depend on.
 *
 * The engine has no runtime dependencies at all, and the dashboard is allowed
 * exactly one — `lit`. That is a deliberate constraint rather than an accident
 * of nothing being needed yet, so it is checked here rather than trusted, in the
 * same spirit as `boundaries.ts`.
 *
 * The reason is that dependencies are a ratchet. Each one is individually
 * reasonable — a router, a virtualizer, a context library — and the sum is a
 * project that cannot be built, audited, or upgraded without a supply chain. A
 * durable workflow engine is infrastructure other things depend on; its own
 * footprint is part of its contract.
 *
 * **`@lit-labs/*` is not permitted**, and neither is `@lit/*`. "Part of Lit"
 * means the `lit` package. Labs packages are explicitly pre-release and change
 * shape; the things they offer here (routing, virtualization, context) are each
 * a few dozen lines against the platform, and writing them is cheaper than
 * carrying an unstable dependency. See `planning/sprints/06-dashboard.md` for
 * what replaces each one.
 *
 * The dev toolchain is a separate list, deliberately short: TypeScript, its
 * runner, the test runner, the formatter. `tsx` is the only thing that executes
 * TypeScript; there is no bundler, and adding one is a decision to make out
 * loud rather than a package to install.
 */

import {readFileSync} from 'node:fs';
import path from 'node:path';

/** A dependency that is not on a list, and where it was declared. */
export interface DependencyViolation {
  name: string;
  field: 'dependencies' | 'devDependencies';
  message: string;
}

/**
 * Shipped to anyone who installs this. `lit` is here for the dashboard; the
 * engine itself imports nothing outside node: builtins.
 */
const ALLOWED_RUNTIME = ['lit'];

/**
 * Build and test only. Each earns its place by being something we would
 * otherwise have to write badly: a type checker, a TS runner, a test runner, a
 * formatter.
 */
const ALLOWED_DEV = [
  '@types/jasmine',
  '@types/node',
  'jasmine',
  'prettier',
  'tsx',
  'typescript',
];

/**
 * Why a given addition is refused, phrased so the failure teaches rather than
 * just blocks. A checker that only says "not allowed" invites the reader to
 * conclude the list is stale and add themselves to it.
 */
function refusal(name: string, field: string): string {
  if (name.startsWith('@lit-labs/'))
    return `${name} is a Lit *labs* package — pre-release by definition, and off the list. Whatever it offers (routing, virtualization, context) is a few dozen lines against the platform here; see planning/sprints/06-dashboard.md`;
  if (name.startsWith('@lit/'))
    return `${name} is adjacent to Lit but not Lit — "part of Lit" means the \`lit\` package itself`;
  return `${name} is not on the ${field} allowlist in tools/dependencies.ts. Adding a dependency is a decision to make out loud: put it on the list in the same commit that uses it, with a reason`;
}

/** Check a parsed package.json against both allowlists. */
export function checkDependencies(pkg: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): DependencyViolation[] {
  const violations: DependencyViolation[] = [];
  for (const [field, allowed] of [
    ['dependencies', ALLOWED_RUNTIME],
    ['devDependencies', ALLOWED_DEV],
  ] as const) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (allowed.includes(name)) continue;
      violations.push({name, field, message: refusal(name, field)});
    }
  }
  return violations;
}

/** Read the repo's package.json and check it. */
export function checkRepoDependencies(root: string): DependencyViolation[] {
  const raw = readFileSync(path.join(root, 'package.json'), 'utf8');
  return checkDependencies(
    JSON.parse(raw) as Parameters<typeof checkDependencies>[0],
  );
}

/** Format violations for a terminal. */
export function formatDependencyViolations(
  violations: DependencyViolation[],
): string {
  return violations
    .map((v) => `package.json (${v.field})  [dependency]\n    ${v.message}`)
    .join('\n\n');
}

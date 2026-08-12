/**
 * @fileoverview
 * The dependency allowlist: what this project is permitted to depend on.
 *
 * **Nothing, at runtime.** The list is empty and that is the whole claim — a
 * deliberate constraint rather than an accident of nothing being needed yet, so
 * it is checked here rather than trusted, in the same spirit as `boundaries.ts`.
 *
 * The reason is that dependencies are a ratchet. Each one is individually
 * reasonable — a router, a virtualizer, a context library — and the sum is a
 * project that cannot be built, audited, or upgraded without a supply chain. A
 * durable workflow engine is infrastructure other things depend on; its own
 * footprint is part of its contract.
 *
 * The dev toolchain is a separate list, deliberately short: a type checker, a TS
 * runner, a test runner, a formatter.
 *
 * **There is no bundler on it, and there was.** `esbuild` was argued for rather
 * than installed, and what it was argued for was the dashboard: that package
 * had shipped a server compiling TypeScript per request and generating an import
 * map at page load, which put the TypeScript compiler in its *runtime*
 * dependencies. `esbuild` deleted all of that. Then the dashboard left this repo
 * and took the only thing being bundled with it, so the bundler went too — a
 * tool kept for the day something needs it is exactly the drift this list
 * exists to prevent. The engine itself has never had a build step: it runs from
 * source under `tsx`, and adding one to it would be its own argument.
 *
 * **`lit` used to be permitted, and only in the dashboard.** Two lists were
 * needed then, one per manifest, so a browser dependency could not creep into
 * the package claiming to have none. One package, one list, and the rule it was
 * protecting is now structural.
 */

import {readFileSync} from 'node:fs';
import * as path from 'node:path';

/** A dependency that is not on a list, and where it was declared. */
export interface DependencyViolation {
  name: string;
  field: 'dependencies' | 'devDependencies';
  message: string;
  /** Which package declared it, repo-relative. Absent when checked directly. */
  pkg?: string;
}

/**
 * What this package ships to anyone who installs it: nothing.
 *
 * An empty list is the claim the fileoverview makes, enforced rather than
 * asserted: adding anything is a decision to argue for out loud.
 */
const ALLOWED_RUNTIME: readonly string[] = [];

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
  return `${name} is not on the ${field} allowlist in tools/dependencies.ts. Adding a dependency is a decision to make out loud: put it on the list in the same commit that uses it, with a reason`;
}

/** What one manifest is permitted. */
export interface Allowlists {
  runtime: readonly string[];
  dev: readonly string[];
}

/**
 * Every manifest in the repo, and what each may depend on.
 *
 * A list of one, kept as a list: it held two while the dashboard was a second
 * package with a budget of its own, and the shape is what makes adding a
 * package a matter of stating its budget rather than rewriting this file.
 */
const PACKAGES: {dir: string; allow: Allowlists}[] = [
  {dir: '.', allow: {runtime: ALLOWED_RUNTIME, dev: ALLOWED_DEV}},
];

/** Check a parsed package.json against a pair of allowlists. */
export function checkDependencies(
  pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  },
  allow: Allowlists = {runtime: ALLOWED_RUNTIME, dev: ALLOWED_DEV},
): DependencyViolation[] {
  const violations: DependencyViolation[] = [];
  for (const [field, allowed] of [
    ['dependencies', allow.runtime],
    ['devDependencies', allow.dev],
  ] as const) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (allowed.includes(name)) continue;
      violations.push({name, field, message: refusal(name, field)});
    }
  }
  return violations;
}

/** Read every manifest in the repo and check each against its own list. */
export function checkRepoDependencies(root: string): DependencyViolation[] {
  const violations: DependencyViolation[] = [];
  for (const {dir, allow} of PACKAGES) {
    const manifest = path.join(root, dir, 'package.json');
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Parameters<
      typeof checkDependencies
    >[0];
    for (const violation of checkDependencies(pkg, allow))
      violations.push({...violation, pkg: dir});
  }
  return violations;
}

/** Format violations for a terminal. */
export function formatDependencyViolations(
  violations: DependencyViolation[],
): string {
  return violations
    .map(
      (v) =>
        `${v.pkg ?? '.'}/package.json (${v.field})  [dependency]\n    ${v.message}`,
    )
    .join('\n\n');
}

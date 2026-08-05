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
 * runner, the test runner, the formatter, and one bundler.
 *
 * **`esbuild` is the bundler, and it was argued for rather than installed.**
 * The rule used to be that there was none, and the cost of that was paid in the
 * dashboard: it shipped a server that compiled TypeScript per request and
 * generated an import map at page load, which put the TypeScript compiler in
 * its *runtime* dependencies. That is not expressible under a real build system
 * — "compile when asked" is not a build step — so the no-bundler rule was the
 * thing standing between this repo and one.
 *
 * It earns its place by deleting more than it adds: the transpile path, the
 * import map, the vendored-package route, and two flavours of extension
 * guessing all went with it. It is also a single binary driven entirely by
 * command-line flags, so the same invocation works from npm and from a build
 * rule with no configuration file to keep in step.
 */

import {readFileSync} from 'node:fs';
import path from 'node:path';

/** A dependency that is not on a list, and where it was declared. */
export interface DependencyViolation {
  name: string;
  field: 'dependencies' | 'devDependencies';
  message: string;
  /** Which package declared it, repo-relative. Absent when checked directly. */
  pkg?: string;
}

/**
 * What the **engine** ships to anyone who installs it: nothing.
 *
 * It was one — `lit`, for a dashboard the engine used to serve. That was
 * backwards, and the dashboard is now its own package that depends on the
 * engine rather than the other way round. An empty list here is the claim the
 * fileoverview makes, finally enforced rather than asserted: adding anything is
 * a decision to argue for out loud.
 */
const ALLOWED_RUNTIME: readonly string[] = [];

/**
 * The **dashboard**, which is allowed exactly one real dependency plus the
 * engine it reports on.
 *
 * `workflow-engine` is the local package, linked by path — it is what makes a
 * field added to a projection a compile error in the browser code rather than
 * `undefined` at runtime, and it is a one-way edge: the engine does not know
 * this package exists.
 */
const ALLOWED_DASHBOARD_RUNTIME: readonly string[] = ['lit', 'workflow-engine'];

/**
 * Build and test only. Each earns its place by being something we would
 * otherwise have to write badly: a type checker, a TS runner, a test runner, a
 * formatter.
 */
const ALLOWED_DEV = [
  '@types/jasmine',
  '@types/node',
  'esbuild',
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

/** What one manifest is permitted. */
export interface Allowlists {
  runtime: readonly string[];
  dev: readonly string[];
}

/**
 * Every manifest in the repo, and what each may depend on.
 *
 * Two lists rather than one, because the two packages have genuinely different
 * budgets: the engine's is empty and the dashboard's is not. A single list
 * would let a browser dependency creep into the thing that claims to have none.
 */
const PACKAGES: {dir: string; allow: Allowlists}[] = [
  {dir: '.', allow: {runtime: ALLOWED_RUNTIME, dev: ALLOWED_DEV}},
  {dir: 'dashboard', allow: {runtime: ALLOWED_DASHBOARD_RUNTIME, dev: []}},
];

/** Check a parsed package.json against a pair of allowlists. */
export function checkDependencies(
  pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  },
  allow: Allowlists = {runtime: ALLOWED_DASHBOARD_RUNTIME, dev: ALLOWED_DEV},
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

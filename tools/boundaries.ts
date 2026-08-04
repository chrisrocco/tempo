/**
 * @fileoverview
 * The determinism-boundary checker: the mechanical half of the rule the rest of
 * the codebase only asserts. Until this existed, `core/` staying pure and workflow
 * code importing only the author entrypoint were upheld by discipline — which is
 * exactly what a newcomer does not yet have. A misplaced `Date.now()` shipped
 * silently and diverged later on a cold replay, the hardest class of bug to trace
 * back to its cause.
 *
 * `checkBoundaries` is a pure function over file contents so the rules can be
 * tested against deliberately planted violations rather than only against a
 * codebase that already passes (see spec/architecture.spec.ts). Reading the disk
 * lives separately in `readSourceFiles`.
 *
 * Four rules, each mapping to a claim made elsewhere in the docs:
 *
 * 1. **Layering** — dependencies point strictly down, and each layer declares what
 *    it may reach. Two are worth calling out: `server/` may NOT import `core/`,
 *    because the server runs no user code and replay happens in the workflow
 *    worker; and `core/` may not import `patterns/`, because the engine must not
 *    depend on helpers built out of it. The second is why `patterns/` is a layer
 *    at all rather than a folder inside `core/` — same-layer imports are not
 *    checked, so as long as both lived in `core/` that direction was unsayable.
 * 2. **Determinism purity** — no clock, randomness, I/O, or ambient host state in
 *    `core/` *or* `patterns/`: both run inside a replay. One documented exception
 *    (see `ALLOWED_HOST_COUPLING`).
 * 3. **The author entrypoint** — workflow modules import only `workflow.ts`, and
 *    obey the same purity rule as the core they run inside.
 * 4. **Package direction** — the engine must not import the dashboard. The
 *    dashboard depends on the engine and not the reverse, which is what lets the
 *    engine ship with no runtime dependencies. This one is here because the
 *    coupling it forbids is the coupling that actually grew: the engine served
 *    the dashboard while the dashboard reached back into `src/`.
 */

import {readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';

/** One source file to check: a repo-relative POSIX path plus its contents. */
export interface SourceFile {
  path: string;
  text: string;
}

/** A single rule failure, located precisely enough to jump to. */
export interface Violation {
  path: string;
  line: number;
  rule: 'layering' | 'core-purity' | 'author-entrypoint' | 'package-direction';
  message: string;
}

/**
 * What each layer under `src/` is permitted to import. Absent from this map means
 * "unrestricted" — the entrypoints and `cli/` compose everything by design.
 */
const LAYER_IMPORTS: Record<string, readonly string[]> = {
  protocol: [],
  core: ['protocol'],
  patterns: ['protocol', 'core'],
  server: ['protocol'],
  worker: ['protocol', 'core'],
  client: ['protocol', 'core'],
  services: ['protocol', 'core', 'server', 'worker'],
};

/** Why a given layer may not reach another — stated so the failure teaches. */
const LAYER_RATIONALE: Record<string, string> = {
  protocol:
    'protocol/ is pure data with no dependencies — it is what lets core and server share types without depending on each other',
  core: 'core/ is the deterministic engine: (history) -> (commands). It may import only protocol/ — and never patterns/, which is built on top of it',
  patterns:
    'patterns/ is workflow-authoring helpers built from the primitives core/ exports; it depends on core/, never the reverse',
  server:
    'server/ runs NO user code — workflow replay happens in the workflow worker, so it must not reach into core/',
  worker: 'worker/ is written against protocol/ and runs core/',
  client:
    'client/ turns a WorkflowService into handles; it needs only protocol/ and core/',
  services:
    'services/ composes server/ and worker/ behind the WorkflowService seam',
};

/** Constructs that make replay irreproducible, so they cannot appear on the deterministic side. */
const NONDETERMINISTIC = [
  {pattern: /\bDate\.now\b/, name: 'Date.now()'},
  {pattern: /\bnew Date\b/, name: 'new Date()'},
  {pattern: /\bMath\.random\b/, name: 'Math.random()'},
  {pattern: /\bsetTimeout\b/, name: 'setTimeout'},
  {pattern: /\bsetInterval\b/, name: 'setInterval'},
  {pattern: /\bsetImmediate\b/, name: 'setImmediate'},
  {pattern: /\bprocess\.env\b/, name: 'process.env'},
  {pattern: /\bfetch\s*\(/, name: 'fetch()'},
] as const;

/**
 * The single sanctioned piece of host coupling in the core. `drainMicrotasks` needs
 * a macrotask boundary to flush the microtask queue; it reads nothing host-specific,
 * so replay stays reproducible. Keeping the exception here — rather than as a
 * blanket rule — means any second one has to be argued for in a diff.
 */
const ALLOWED_HOST_COUPLING: Record<string, readonly string[]> = {
  'src/core/microtask_scheduler.ts': ['setImmediate'],
};

/** True for files that hold workflow code and must obey the author-entrypoint rule. */
export function isWorkflowModule(filePath: string): boolean {
  return (
    /(^|\/)workflows\//.test(filePath) ||
    /(^|\/)workflows\.ts$/.test(filePath) ||
    /\.workflow\.ts$/.test(filePath)
  );
}

/**
 * Blank out comments and string bodies while preserving offsets, so scanning for
 * constructs never trips over prose. `core/replay.ts` documents the rule with the
 * words "never `Date.now()`", which a naive grep would report as a violation.
 */
export function stripCommentsAndStrings(text: string): string {
  let out = '';
  let inBlock = false;
  let inLine = false;
  let quote: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      } else out += ' ';
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
        out += '  ';
      } else out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (quote) {
      // Keep the quotes themselves so import specifiers stay extractable.
      if (c === '\\') {
        out += '  ';
        i++;
      } else if (c === quote) {
        quote = null;
        out += c;
      } else out += c === '\n' ? '\n' : c;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      out += '  ';
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

interface ImportRef {
  specifier: string;
  line: number;
}

function extractImports(strippedText: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const lines = strippedText.split('\n');
  const re = /(?:\bfrom|\bimport)\s*\(?\s*'([^']+)'/g;
  lines.forEach((lineText, idx) => {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(lineText)) !== null) {
      refs.push({specifier: m[1], line: idx + 1});
    }
  });
  return refs;
}

/** The layer a repo-relative path belongs to, or undefined if it is not layered. */
function layerOf(repoPath: string): string | undefined {
  const m = /^src\/([^/]+)\//.exec(repoPath);
  return m ? m[1] : undefined;
}

function resolveSpecifier(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // node builtin or package
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromPath), specifier),
  );
  return resolved;
}

function checkLayering(file: SourceFile, stripped: string): Violation[] {
  const fromLayer = layerOf(file.path);
  if (!fromLayer) return [];
  const allowed = LAYER_IMPORTS[fromLayer];
  if (!allowed) return []; // cli/ and the entrypoints compose freely

  const violations: Violation[] = [];
  for (const ref of extractImports(stripped)) {
    const resolved = resolveSpecifier(file.path, ref.specifier);
    if (!resolved) continue;
    const toLayer = layerOf(resolved.endsWith('/') ? resolved : `${resolved}/`);
    if (!toLayer || toLayer === fromLayer) continue;
    if (allowed.includes(toLayer)) continue;
    violations.push({
      path: file.path,
      line: ref.line,
      rule: 'layering',
      message: `${fromLayer}/ must not import ${toLayer}/ — ${LAYER_RATIONALE[fromLayer] ?? 'dependencies point down'}`,
    });
  }
  return violations;
}

/**
 * The engine must not know the dashboard exists.
 *
 * The dashboard is a separate package that depends on the engine, and that edge
 * points one way. It did not always: the engine used to serve the dashboard —
 * carrying a TypeScript transpiler and an import-map generator to do it — while
 * the dashboard reached back into `src/` for the values it needed. Each half
 * looked reasonable on its own, and together they meant neither could be
 * understood, tested, or shipped without the other.
 *
 * Checked rather than trusted for the usual reason: the coupling grew where
 * nothing was looking. A single import is all it takes to grow back.
 */
function checkPackageDirection(
  file: SourceFile,
  stripped: string,
): Violation[] {
  const violations: Violation[] = [];
  for (const ref of extractImports(stripped)) {
    if (!/(^|\/)dashboard\//.test(ref.specifier)) continue;
    violations.push({
      path: file.path,
      line: ref.line,
      rule: 'package-direction',
      message:
        'the engine must not import the dashboard — the dashboard depends on the engine, and that edge points one way. Whatever is needed here belongs in the engine, or the dashboard should reach it over the RPC',
    });
  }
  return violations;
}

function checkPurity(
  file: SourceFile,
  stripped: string,
  rule: 'core-purity' | 'author-entrypoint',
): Violation[] {
  const exempt = ALLOWED_HOST_COUPLING[file.path] ?? [];
  const violations: Violation[] = [];
  stripped.split('\n').forEach((lineText, idx) => {
    for (const {pattern, name} of NONDETERMINISTIC) {
      if (exempt.includes(name)) continue;
      if (pattern.test(lineText)) {
        violations.push({
          path: file.path,
          line: idx + 1,
          rule,
          message: `${name} is non-deterministic — replay must reproduce identically, so time and external results arrive through history (use sleep / an activity)`,
        });
      }
    }
  });
  return violations;
}

function checkAuthorEntrypoint(
  file: SourceFile,
  stripped: string,
): Violation[] {
  const violations: Violation[] = [];
  for (const ref of extractImports(stripped)) {
    const resolved = resolveSpecifier(file.path, ref.specifier);
    if (resolved === null) {
      violations.push({
        path: file.path,
        line: ref.line,
        rule: 'author-entrypoint',
        message: `workflow code may not import '${ref.specifier}' — only the deterministic surface in workflow.ts`,
      });
      continue;
    }
    if (!/(^|\/)src\/workflow$/.test(resolved)) {
      violations.push({
        path: file.path,
        line: ref.line,
        rule: 'author-entrypoint',
        message: `workflow code may import only workflow.ts, not '${ref.specifier}' — that is what makes the determinism boundary structural rather than a convention`,
      });
    }
  }
  return violations;
}

/**
 * Check every supplied file against the boundary rules. Pure: it takes file
 * contents and returns violations, so the rules themselves can be tested against
 * planted breakage instead of only against code that already passes.
 */
export function checkBoundaries(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const stripped = stripCommentsAndStrings(file.text);
    if (isWorkflowModule(file.path)) {
      violations.push(...checkAuthorEntrypoint(file, stripped));
      violations.push(...checkPurity(file, stripped, 'author-entrypoint'));
      continue;
    }
    violations.push(...checkLayering(file, stripped));
    violations.push(...checkPackageDirection(file, stripped));
    // Both layers run inside a replay, so both are held to determinism. Keying
    // this on `core` alone was safe only while `core` was the only thing that
    // ran there: a helper in `patterns/` is called from workflow code just the
    // same, and a `Date.now()` in one is exactly as fatal.
    const layer = layerOf(file.path);
    if (layer === 'core' || layer === 'patterns') {
      violations.push(...checkPurity(file, stripped, 'core-purity'));
    }
  }
  return violations;
}

/** Read every `.ts` file under `root`, returning repo-relative POSIX paths. */
export function readSourceFiles(root: string, dirs: string[]): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(path.join(root, dir))) {
      const rel = path.posix.join(dir, entry);
      if (statSync(path.join(root, rel)).isDirectory()) walk(rel);
      else if (rel.endsWith('.ts'))
        files.push({
          path: rel,
          text: readFileSync(path.join(root, rel), 'utf8'),
        });
    }
  };
  for (const dir of dirs) walk(dir);
  return files;
}

/** Format violations for a terminal, grouped so the output is scannable. */
export function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `${v.path}:${v.line}  [${v.rule}]\n    ${v.message}`)
    .join('\n\n');
}

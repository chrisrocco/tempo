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
 * 3. **The author entrypoint** — workflow modules import only `workflow.ts` at
 *    runtime, and obey the same purity rule as the core they run inside. A
 *    statement-level `import type` is exempt; see `checkAuthorEntrypoint`.
 * 4. **Browser safety** — the published entrypoints a dashboard is invited to
 *    import reach neither a Node builtin nor a workflow module through a value
 *    import, transitively. The only rule here that reads the import graph; see
 *    `BROWSER_SAFE_ENTRYPOINTS`.
 *
 * A different fourth rule used to exist — package direction, forbidding any
 * mention of `dashboard/` from `src/`. It guarded a one-way edge between two
 * packages in this repo, and there is now one package. A rule that can no longer
 * fail is not a weaker rule, it is a rule about nothing; the boundary it protected
 * became the published `exports` map, which a consumer's resolver enforces rather
 * than this file.
 *
 * Rule 4 is not that rule returning. A resolver enforces which *paths* a consumer
 * may import and can say nothing about what those paths pull in behind them —
 * which is the half that actually broke, twice, and the half no consumer discovers
 * until their bundler does.
 */

import {readdirSync, readFileSync, statSync} from 'node:fs';
import * as path from 'node:path';

/** One source file to check: a repo-relative POSIX path plus its contents. */
export interface SourceFile {
  path: string;
  text: string;
}

/** A single rule failure, located precisely enough to jump to. */
export interface Violation {
  path: string;
  line: number;
  rule: 'layering' | 'core-purity' | 'author-entrypoint' | 'browser-safety';
  message: string;
}

/**
 * What each layer under `src/` is permitted to import. Absent from this map means
 * "unrestricted" — the entrypoints compose everything by design.
 */
const LAYER_IMPORTS: Record<string, readonly string[]> = {
  protocol: [],
  timespec: [],
  core: ['protocol', 'timespec'],
  patterns: ['protocol', 'core'],
  schedule: ['protocol', 'timespec'],
  server: ['protocol'],
  worker: ['protocol', 'core'],
  client: ['protocol', 'core'],
  services: ['protocol', 'core', 'server', 'worker'],
  // `workflow_descriptor` is a top-level module rather than a directory, but
  // `layerOf` reads the first path segment under `src/` either way, so importing
  // one from inside a layer has to be declared like a layer. `tempo.ts` reaches
  // the same module unchecked, being top-level itself — which is the asymmetry
  // this entry pays for, not a second kind of dependency.
  testing: [
    'protocol',
    'core',
    'client',
    'services',
    'worker',
    'workflow_descriptor',
  ],
};

/** Why a given layer may not reach another — stated so the failure teaches. */
const LAYER_RATIONALE: Record<string, string> = {
  protocol:
    'protocol/ is pure data with no dependencies — it is what lets core and server share types without depending on each other',
  timespec:
    'timespec/ is an internally-owned library — duration strings and wall-clock rules — treated like a third-party dependency the repo happens to host: it knows nothing about the engine and imports nothing, so it stays removable by deleting the directory and the call sites spec/timespec/seam.spec.ts names',
  core: 'core/ is the deterministic engine: (history) -> (commands). It may import only protocol/ and timespec/ (whose deterministic half it uses) — and never patterns/, which is built on top of it',
  patterns:
    'patterns/ is workflow-authoring helpers built from the primitives core/ exports; it depends on core/, never the reverse',
  schedule:
    'schedule/ is when-does-this-fire arithmetic over protocol/ spec types, plus the seam to the timespec/ library. It must not reach core/: it runs inside an activity, on the I/O side of the determinism boundary',
  server:
    'server/ runs NO user code — workflow replay happens in the workflow worker, so it must not reach into core/',
  worker: 'worker/ is written against protocol/ and runs core/',
  client:
    'client/ turns a WorkflowService into handles; it needs only protocol/ and core/',
  services:
    'services/ composes server/ and worker/ behind the WorkflowService seam',
  testing:
    'testing/ composes a server and its workers into named fixture states, so it reaches almost everything — but not server/ directly, because a fixture that reached past the service seam could build a state no deployment can reach, which is the one thing a shared fixture must not do',
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
 * The sanctioned pieces of host coupling on the checked-for-purity side. Each is
 * an argument that had to be made in a diff, which is the point of listing files
 * rather than blanket-exempting a layer:
 *
 * - `drainMicrotasks` needs a macrotask boundary to flush the microtask queue;
 *   it reads nothing host-specific, so replay stays reproducible.
 * - `timespec/wall_clock.ts` reads the platform's timezone data (`Intl`, plus
 *   `new Date` for calendar math on its wall encoding) and is **not**
 *   replay-safe — its own fileoverview says so. It is exempted rather than left
 *   unchecked so that its sibling `duration.ts`, which the deterministic core
 *   calls during replay, stays machine-held to purity: a `Date.now()` slipped
 *   into the parser must fail lint, not diverge a replay.
 */
const ALLOWED_HOST_COUPLING: Record<string, readonly string[]> = {
  'src/core/microtask_scheduler.ts': ['setImmediate'],
  'src/timespec/wall_clock.ts': ['new Date()'],
};

/**
 * Published entrypoints that must stay importable in a browser.
 *
 * Each is a path in the `exports` map that a dashboard, a CLI, or any other
 * out-of-repo consumer is invited to import, and none of them may reach a Node
 * builtin through a value import. The rule walks the graph rather than reading
 * one file, because the failure it prevents is always transitive: every one of
 * these files is browser-safe on its own, and it is what they pull in behind
 * them that breaks a bundle.
 *
 * This has now gone wrong twice for the same reason — a *barrel* re-exporting a
 * neighbour that opens a port or reads a disk. `schedule/index.ts` was split from
 * `schedule/worker.ts` after a dashboard importing `createScheduleClient` got the
 * workflow runtime with it, and `src/remote_client.ts` exists because
 * `createRemoteService` was reachable only through the host entrypoint, next to
 * `startServer` and `FileHistoryStore`. Both were found by someone bundling the
 * result; neither could fail a check, because there was none.
 *
 * Exported, and **asserted to exist** by `spec/architecture.spec.ts` rather than
 * by the checker. A renamed entrypoint left behind in this list would otherwise
 * make the rule silently check nothing, which is the failure mode this whole file
 * exists to avoid. It is not checked here because `checkBoundaries` is pure over
 * whatever file set it is handed — the planted-breakage tests pass two or three
 * synthetic files — so "this path is absent" is a fact about the real tree and
 * belongs to the test that reads the real tree.
 */
export const BROWSER_SAFE_ENTRYPOINTS: readonly string[] = [
  'src/remote_client.ts',
  'src/protocol/index.ts',
  'src/schedule/index.ts',
];

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
  /**
   * True for a statement-level `import type …` or `export type …`, which
   * TypeScript erases entirely — the emitted JavaScript contains no reference to
   * the module, and using the binding as a value is a compile error.
   *
   * Only the statement form counts. An inline `import {type Foo, bar}` is a value
   * import of `bar`, and even `import {type Foo}` alone can emit a bare
   * `import './x'` under `verbatimModuleSyntax` — which is a side-effect import and
   * therefore real. Conservative on purpose: the point of the flag is that nothing
   * runs, and only the statement form guarantees it.
   */
  typeOnly: boolean;
  /**
   * The binding from `import * as NAME from '…'`, when the statement has that
   * shape. Absent for named, default, and bare side-effect imports.
   *
   * Only the namespace form is captured because it is the only one the activities
   * exemption accepts — see `checkAuthorEntrypoint`.
   */
  namespaceBinding?: string;
}

/** The call a workflow module may hand a value-imported activities namespace to. */
const ACTIVITY_DEFINER = 'proxyActivities';

/**
 * The file with its import statements blanked out, so scanning for *uses* of a
 * binding does not count the line that introduced it.
 *
 * Line-based, which is exact here: every import in this codebase occupies whole
 * lines, and a multi-line `import {…}` block contains no other code.
 */
function withoutImportStatements(strippedText: string): string {
  const lines = strippedText.split('\n');
  const out = [...lines];
  for (let i = 0; i < lines.length; i++) {
    // Only `import` statements, which are the only ones that bind a local name. An
    // `export … from` creates no binding, and matching `export` here would blank
    // every `export function` in the file.
    if (!/^\s*import\b/.test(lines[i] ?? '')) continue;
    let end = i;
    while (end < lines.length) {
      out[end] = '';
      // The specifier closes the statement, however many lines the clause took.
      if (/'[^']*'/.test(lines[end] ?? '')) break;
      end++;
    }
    i = end;
  }
  return out.join('\n');
}

/**
 * Is every use of `binding` in `body` an argument to `proxyActivities`?
 *
 * Counting rather than parsing: each `proxyActivities(binding` match contains
 * exactly one occurrence of the binding, so if the totals agree then every
 * occurrence is accounted for by such a call. Any other reference — a direct call,
 * a re-export, passing it somewhere else — pushes the first count higher and fails.
 */
function onlyDefinesActivities(body: string, binding: string): boolean {
  const name = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uses = body.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;

  // An unused namespace binding is **not** harmless, which is easy to get wrong: the
  // import still evaluates the module, so any module-scope work in an activities file
  // — opening a pool, reading config — runs inside the workflow worker. Only a
  // binding actually handed to `proxyActivities` earns the exemption.
  if (uses === 0) return false;

  const handedOver =
    body.match(new RegExp(`\\b${ACTIVITY_DEFINER}\\s*\\(\\s*${name}\\b`, 'g'))
      ?.length ?? 0;
  return uses === handedOver;
}

function extractImports(strippedText: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const lines = strippedText.split('\n');
  const re = /(?:\bfrom|\bimport)\s*\(?\s*'([^']+)'/g;
  // Carried across lines, because the modifier belongs to the *statement* and the
  // specifier can be several lines below it:
  //
  //     import type {
  //       A,
  //       B,
  //     } from '../protocol';
  //
  // Read per line, the `} from …` line does not look type-only, and an erased import
  // was reported as a real one. That made the determinism exemption depend on **line
  // length**: the same import passed until a name was added and Prettier wrapped it,
  // which is how it was found. Value imports were never missed — they are attributed
  // to the same closing line, where `typeOnly` is false either way — so the bug was
  // false positives only.
  let openTypeStatement = false;
  lines.forEach((lineText, idx) => {
    const opensType = /^\s*(?:import|export)\s+type\s/.test(lineText);
    const typeOnly = opensType || openTypeStatement;
    // A statement is still open when it began a brace list this line did not close.
    if (opensType && !/\bfrom\s*'/.test(lineText)) openTypeStatement = true;
    else if (/\bfrom\s*'/.test(lineText)) openTypeStatement = false;
    const namespace = /^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s/.exec(
      lineText,
    );
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(lineText)) !== null) {
      refs.push({
        specifier: m[1],
        line: idx + 1,
        typeOnly,
        ...(namespace?.[1] ? {namespaceBinding: namespace[1]} : {}),
      });
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
  if (!allowed) return []; // the entrypoints compose freely

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

/**
 * Workflow code may import only `workflow.ts` — **at runtime.**
 *
 * A statement-level `import type` is exempt, because it is erased: the emitted
 * JavaScript names no other module, nothing is executed, and the compiler rejects
 * any attempt to use the binding as a value. The rule exists to keep
 * nondeterminism out of replay, and a type cannot run.
 *
 * Without the exemption the recommended way to type activities is unexpressible.
 * `proxyActivities<typeof activities>` needs the activities module's *shape* in the
 * workflow module, and the only way to get it without a runtime edge is
 * `import type * as activities from './activities'`. That is precisely what
 * `examples/greeter.ts` tells authors to do, and this checker used to reject it —
 * so following the documented advice failed `npm run lint`, and there was no other
 * way to write a typed workflow module that the convention would accept.
 *
 * The layering rule is deliberately *not* given the same exemption. That one is
 * about which layers may know about which, and a type dependency is still
 * knowledge; this one is about what executes inside a replay.
 *
 * ## The one value import that is allowed, and what makes it safe
 *
 * `proxyActivities(impls, options)` types the proxy from the implementations *and*
 * registers them, so a workflow that declares it will call an activity has
 * registered that activity by saying so. That is worth having — a large workflow
 * decomposed across helper modules otherwise depends on someone maintaining a flat
 * list at the worker entrypoint by memory, and the failure is a silent retry loop
 * in production.
 *
 * But passing implementations means binding them, and a bound implementation is one
 * keystroke from catastrophe:
 *
 *     const act = proxyActivities(payments, {…});
 *     await act.charge(amount);      // correct — issues a command
 *     await payments.charge(amount); // real I/O inside replay, on every replay
 *
 * Nothing else in the repo catches the second line. Activities modules are not
 * purity-checked — I/O is their whole job — and the call site matches no
 * nondeterministic pattern. The type-only import used to prevent it by making the
 * binding not exist.
 *
 * So the value import is allowed **only in the shape that cannot be misused**:
 * `import * as NAME from '…'` where every occurrence of `NAME` in the file is an
 * argument to `proxyActivities`. Reach for the binding anywhere else and this
 * fails. That keeps the protection structural rather than turning it into a
 * convention, which is the property this whole file exists to provide.
 *
 * Deliberately narrow. Only the namespace form is considered — named, default, and
 * bare side-effect imports stay rejected outright, because `proxyActivities` takes
 * a module namespace and no other shape has a reason to appear here. A rule that
 * fails a legitimate-but-unusual import is recoverable; one that admits an
 * implementation binding is not.
 */
function checkAuthorEntrypoint(
  file: SourceFile,
  stripped: string,
): Violation[] {
  const violations: Violation[] = [];
  const body = withoutImportStatements(stripped);

  for (const ref of extractImports(stripped)) {
    if (ref.typeOnly) continue;
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
    if (/(^|\/)src\/workflow$/.test(resolved)) continue;

    // The activities exemption: a namespace binding used for nothing but
    // `proxyActivities` never reaches an implementation, so it cannot run one.
    if (
      ref.namespaceBinding &&
      onlyDefinesActivities(body, ref.namespaceBinding)
    )
      continue;

    violations.push({
      path: file.path,
      line: ref.line,
      rule: 'author-entrypoint',
      message: ref.namespaceBinding
        ? `workflow code may import '${ref.specifier}' only to hand it to proxyActivities — '${ref.namespaceBinding}' is used elsewhere in this file, and a bound activity implementation can be called directly, which would run real I/O inside replay`
        : `workflow code may import only workflow.ts, not '${ref.specifier}' — that is what makes the determinism boundary structural rather than a convention. To call its activities, use \`import * as x\` and hand it to proxyActivities`,
    });
  }
  return violations;
}

/**
 * What a browser-safe entrypoint may reach at runtime: no bare specifier, and no
 * workflow module.
 *
 * The only rule here that reads the **graph** rather than a file. The other three
 * are local questions — this layer's imports, this file's constructs — and this
 * one cannot be: `src/remote_client.ts` contains no `node:` import and never
 * will, because the way it breaks is that something three hops down does.
 *
 * Two conditions, because there are two ways the same promise breaks. A builtin
 * breaks the *bundle* — the consumer finds out when their build fails, loudly. A
 * workflow module breaks the *process* — importing one registers activities into
 * a process-global registry, and the consumer finds out never, because nothing
 * about it fails.
 *
 * ## Any bare specifier, not just `node:`
 *
 * A specifier that does not start with `.` is either a Node builtin or a package,
 * and both fail the test for the same reason: the entrypoint stops being
 * self-contained. Today the second case cannot arise — the runtime dependency
 * allowlist in `tools/dependencies.ts` is empty and enforced — so in practice
 * every failure here is a builtin. If a browser-safe dependency is ever added,
 * this is the rule that has to be taught about it, deliberately, in that diff.
 *
 * ## Value imports only
 *
 * A statement-level `import type` is erased: the emitted JavaScript names no
 * module, so no bundler follows it. That is what lets `client/client.ts` name
 * `SignalDef` from `core/` and `remote_service.ts` name a dozen protocol types
 * without either of them pulling anything into a browser build. The same
 * exemption, and the same reasoning, as `checkAuthorEntrypoint`.
 */
function checkBrowserSafety(files: SourceFile[]): Violation[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const violations: Violation[] = [];

  /** A resolved specifier names either the module itself or a directory barrel. */
  function fileAt(resolved: string): SourceFile | undefined {
    return byPath.get(`${resolved}.ts`) ?? byPath.get(`${resolved}/index.ts`);
  }

  for (const entrypoint of BROWSER_SAFE_ENTRYPOINTS) {
    // Absent from *this* set is not a failure: a planted-breakage test hands over
    // two synthetic files and means nothing by the other seventy-three. Absent
    // from the real tree is a failure, and the spec is what says so.
    const start = byPath.get(entrypoint);
    if (!start) continue;
    // Breadth-first, carrying the chain that got here so the failure names the
    // route and not merely the destination. Which barrel pulled the builtin in is
    // the entire diagnosis; the builtin itself is never the surprise.
    const seen = new Set<string>([start.path]);
    const queue: Array<{file: SourceFile; via: readonly string[]}> = [
      {file: start, via: [start.path]},
    ];
    for (let i = 0; i < queue.length; i++) {
      const step = queue[i];
      if (!step) continue;
      const stripped = stripCommentsAndStrings(step.file.text);
      for (const ref of extractImports(stripped)) {
        if (ref.typeOnly) continue;
        const resolved = resolveSpecifier(step.file.path, ref.specifier);
        if (resolved === null) {
          violations.push({
            path: step.file.path,
            line: ref.line,
            rule: 'browser-safety',
            message: `'${ref.specifier}' is not available in a browser, and ${entrypoint} reaches it: ${step.via.join(' -> ')}. Import the module that has what you need directly, rather than a barrel that also re-exports host code.`,
          });
          continue;
        }
        const next = fileAt(resolved);
        if (!next || seen.has(next.path)) continue;
        // Reaching workflow code is the other way a safe-looking entrypoint goes
        // wrong, and it is not about builtins at all: a workflow module calls
        // `proxyActivities` at module scope, so importing one registers activities
        // into a process-global registry as an import side effect. Correct in a
        // worker binary, wrong in anything else — and it is what
        // `src/schedule/index.ts` did for a day without anything failing.
        if (isWorkflowModule(next.path)) {
          violations.push({
            path: step.file.path,
            line: ref.line,
            rule: 'browser-safety',
            message: `${entrypoint} must stay importable outside a worker, and reaches the workflow module '${next.path}': ${step.via.join(' -> ')}. Importing one evaluates it, which registers its activities as a side effect. Import its types instead, or move the value import to a worker-only path.`,
          });
          continue;
        }
        seen.add(next.path);
        queue.push({file: next, via: [...step.via, next.path]});
      }
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
    // These layers run inside a replay, so they are held to determinism. Keying
    // this on `core` alone was safe only while `core` was the only thing that
    // ran there: a helper in `patterns/` is called from workflow code just the
    // same, and a `Date.now()` in one is exactly as fatal. `timespec` is on the
    // list because `core` calls its duration parser during replay — its one
    // legitimately host-coupled file is exempted by name in
    // `ALLOWED_HOST_COUPLING`, which is what keeps the rest of the library
    // checked rather than trusted.
    const layer = layerOf(file.path);
    if (layer === 'core' || layer === 'patterns' || layer === 'timespec') {
      violations.push(...checkPurity(file, stripped, 'core-purity'));
    }
  }
  // Once, over the whole set rather than per file: it is the only rule that is a
  // question about the import graph, so it has nothing to say about a file in
  // isolation.
  violations.push(...checkBrowserSafety(files));
  return violations;
}

/**
 * Read every matching file under `root`, returning repo-relative POSIX paths.
 *
 * `extensions` stays a parameter, defaulted to TypeScript: `tools/conventions.ts`
 * reads the same tree through this function and has asked for more than `.ts`
 * before — it read the dashboard's HTML shell, back when there was one.
 */
export function readSourceFiles(
  root: string,
  dirs: string[],
  extensions: readonly string[] = ['.ts'],
): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(path.join(root, dir))) {
      const rel = path.posix.join(dir, entry);
      if (statSync(path.join(root, rel)).isDirectory()) walk(rel);
      else if (extensions.some((extension) => rel.endsWith(extension)))
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

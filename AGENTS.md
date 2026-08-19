# Working in this repo

Read [`README.md`](README.md) first — what the project is, how it's laid out,
and the reading order through the code.

## Structuring the code

The documentation rules below depend on this section: concepts have to map onto
modules, or there is nowhere for the explanation to live. Structure first, then
document.

**Organize by responsibility, not by technical kind.** The top-level split is
`protocol/`, `walltime/`, `core/`, `patterns/`, `schedule/`, `server/`,
`services/`, `worker/`, `client/` — each a job the system does, and each
declaring what it may import in [`tools/boundaries.ts`](tools/boundaries.ts).
(`walltime/` is the odd one out: an internally-owned library the engine treats
like a third-party dependency — see `src/walltime/index.ts` for its contract.) A new area of behaviour
gets its own layer there rather than a folder inside a neighbour: absence from
that map means _unrestricted_, so skipping the declaration exempts the new code
rather than leaving it safely unchecked. Resist `types/`, `utils/`, `helpers/`, `handlers/`: those group
files by what they _are_ rather than what they are _for_, and a concept spread
across them belongs to no one.

**One module, one idea — nameable in a sentence.** If you can't finish "this
module is where we…" without an "and", it is two modules. `retry_policy.ts` was
pulled out of `server_core.ts` for exactly this reason: retry decisions are
their own idea, separately testable and separately explainable.

**Dependencies point one way.** `protocol <- core <- {patterns, server, services,
worker, client} <- {local_runtime, entrypoints, bin}`. A dependency that wants to point
back up means a responsibility is sitting on the wrong side of a line. This is
**checked, not trusted** — [`tools/boundaries.ts`](tools/boundaries.ts) enforces
the layering, the ban on clock/randomness/IO inside `core/` and `patterns/`, and the rule that
workflow modules import only `workflow.ts`. Run it with `npm run lint`; the
suite runs the same rules. When it fails, the message names the layer and why.

**Almost nothing is worth a dependency.** This package has **none** at runtime —
its allowlist is empty, and that is enforced rather than asserted. The dev
toolchain is a separate, equally short list: TypeScript, `tsx`, Jasmine, and
Prettier. This is **checked, not trusted** —
[`tools/dependencies.ts`](tools/dependencies.ts) holds both lists, and `npm run
lint` and the suite both fail on anything else. Adding to a list is fine; doing
it in the same commit that needs it, with a reason, is the point.

**There is no build step, and no bundler.** `tsx` executes the TypeScript
directly; nothing here is compiled before it runs. `esbuild` was on the dev list
for one job — bundling the dashboard's browser code — and left when the
dashboard did. Adding a build step to the engine would be its own argument, and
the argument has never been made.

**The operator tooling is not here, and that is the standing decision.** The CLI
went first, then the deployment kit ([#64](https://github.com/chrisrocco/tempo/issues/64)),
then the dashboard. Each was written here and could only be falsified somewhere
else — against a real systemd, in a real browser — so each iteration cost a round
trip through the repo that owns the thing being tested. What this repo owes them
instead is that everything they need is on the published surface: the `exports`
map in `package.json`, and `workflow-engine/protocol` in particular, which
carries every projection type and all three predicates (`isStuck`,
`isQueueServed`, `isNameServed`) a UI would otherwise reimplement and get subtly wrong. A gap
there is a bug in this package, not a reason to move the tool back in.

**Put seams behind interfaces, implementations behind them.** `server/ports/`
declares a contract; `server/memory/` and `server/file/` satisfy it. This splits
the documentation cleanly too — the port owns the contract and its invariants,
each adapter owns its own tradeoffs, and neither has to repeat the other.

**Entrypoints are deliberate focal points.** `workflow.ts`, `index.ts`, and
`tempo.ts` are thin re-export files whose job is to make a boundary explicit.
They are the one place a barrel legitimately owns a large cross-cutting idea,
because they are where that idea is enforced.

### Homeless documentation is a design smell

When you sit down to document something and no module is the obvious home, treat
that as information about the structure, not as a documentation problem. The
test: if you can't name the owning module in one guess, something is wrong —
usually a responsibility smeared across modules that should be one, or a module
quietly doing several unrelated things. Fix the structure and the home appears.

A separate `docs/` tree hides this signal: prose can be organized independently
of the code, so it can describe a structure the tree doesn't have — and keep
describing it long after the code moves.

## Documentation lives in the code

**Anything a reader needs in order to understand or safely change an
implementation belongs in a comment in the module it concerns** — architecture
and how modules relate, design rationale, constraints, invariants, caveats,
failure semantics, operational notes. This repo has no `docs/` tree, and adding
one back is not the answer to "where should this go?"

Two reasons this is worth the discipline:

- **Discoverability.** You find the explanation because you opened the file it
  describes, not because you knew a doc existed and went looking.
- **It stays true.** A comment next to the code is in the same diff when
  behavior changes, so review catches drift. A parallel doc tree has no such
  forcing function and rots silently.

### Where each kind of thing goes

| Kind                                                    | Home                                      |
| ------------------------------------------------------- | ----------------------------------------- |
| What a module is, why it's shaped that way, its caveats | `@fileoverview` at the top of the module  |
| The contract of one exported symbol                     | JSDoc on that symbol                      |
| Non-obvious local reasoning                             | An inline comment at the point it applies |
| What the system guarantees                              | A spec — executable, and it runs in CI    |

An idea spanning several modules gets **one home**: the module that owns it;
others refer to it by path. The determinism boundary is owned by
`src/workflow.ts`, and `core/` modules point at it. Duplicating a concept across
three fileoverviews recreates the drift this pattern exists to prevent.

### Decisions, including the ones you didn't take

A decision is documentation with a shape of its own, and the rule above is not
enough by itself: "design rationale" says the choice was explained, not that the
**alternatives** were. Record what was rejected and why — that is the half that
stops the next reader relitigating something already settled, and the half that
tells them when reopening it _would_ be right.

- **The decision lives with the code it constrains**, in the `@fileoverview`
  of the module that owns the idea. Why the listing's order is not
  configurable is in `server/execution_query.ts`; why a listing's time bounds
  cross the wire as instants rather than durations is in
  `protocol/service.ts`. If you can't name the owning module, re-read
  [Homeless documentation is a design smell](#homeless-documentation-is-a-design-smell)
  — it's the same signal.
- **Say what it cost to decide, not only what was decided.** "No sort control"
  is a note. "No sort control, because the cursor _is_ the sort key, so a
  second ordering silently resolves old links into a differently-ordered set"
  is a decision — it survives someone who disagrees.
- **An issue that lands says what shipped**, including any deviation from the
  shape it proposed and what was deliberately left undone. The issue keeps the
  problem statement, the code keeps the rationale, and the closing note is the
  link between them. See
  [#50](https://github.com/chrisrocco/tempo/issues/50).
- **A decision _not_ to build something still lands**, with the reasoning that
  made waiting the cheap option. Nothing was built, so no module can host it —
  which makes the issue its only home, and a reason to close it as
  `not_planned` rather than delete the thinking. See
  [#51](https://github.com/chrisrocco/tempo/issues/51) and
  [#48](https://github.com/chrisrocco/tempo/issues/48).
- **When a decision outgrows a fileoverview, it belongs in the issue**, not in
  a design document that no code change will ever force someone to revisit.
  See [#33](https://github.com/chrisrocco/tempo/issues/33).

The forcing function is the one the rest of this section relies on: a decision
recorded beside the code it governs is in the diff when that code changes, so
review catches it going stale.

### When you're tempted to add a doc file

Find the module that owns the idea and put it there. If genuinely no module owns
it, that is a signal about what kind of thing it actually is — and it belongs in
one of the few places that legitimately sit outside the code:

- **[`README.md`](README.md)** — what the project is, the layout, current
  status, and the reading order. The front door, for someone who has read
  nothing.
- **[`ROADMAP.md`](ROADMAP.md)** — what is not built yet, and the invariants
  that hold while building it.
- **[`GLOSSARY.md`](GLOSSARY.md)** — one term per concept, and the tiebreaker
  when two names are in circulation. Outside the code because vocabulary spans
  every module by definition: the words for `execution`, `task queue` and
  `marker` are used in `core/`, `server/`, `worker/` and `protocol/` alike, so no
  one module can own them without the others deferring to a neighbour. Use its
  terms in comments and commit messages, and add a row rather than inventing a
  synonym.
- **GitHub issues** — in-flight design work: proposals, scoping, and decisions
  about code that doesn't exist yet, so there's no module to host them.
- **This file** — contributor conventions: process, not implementation.

### Keeping it honest

Update the module comment in the **same commit** as the behavior change; a
fileoverview that describes the old design is worse than none, because it is
believed. Where a comment and the code disagree, the code is the truth and the
comment is a bug — fix it rather than working around it. Don't leave a pointer
to something that no longer exists.

Two ways prose goes stale without ever being wrong when written:

- **A claim a later change falsified.** `ActivityRetryGroup` called flakiness
  underivable from history for a week after `activityRetryScheduled` made it
  derivable. A change owns every comment describing it, including in neighbouring
  modules.
- **The history of something removed.** A decision documents code it
  _constrains_; a deleted thing constrains nothing, so its story belongs in the
  commit message. Keep what the code does now and what is still open.

The tell for the second: on a change that removes code, the comment delta should
be negative too.

### Start here when orienting

| Read                                      | For                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------- |
| [`GLOSSARY.md`](GLOSSARY.md)              | The vocabulary — read first, so the rest reads as one voice           |
| `src/workflow.ts`                         | The determinism boundary — the organizing idea, and the author rules  |
| `src/core/replay.ts`                      | Activation vs. replay, what suppresses a command, observe-don't-await |
| `src/core/condition.ts`                   | How a workflow waits, and why `condition` exists                      |
| `src/server/ports/workflow_task_queue.ts` | The two concurrency bugs the queue design prevents                    |
| `src/services/local_service.ts`           | Local vs. distributed, and the failure-semantics caveat               |
| `spec/integration/local.spec.ts`          | The whole programming model, executable                               |

## Code style

The baseline is the
[Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).
Most of it the repo already satisfies structurally — no default exports, no
`var`, no `namespace`, no enums, `strict: true`, `snake_case` filenames, named
function declarations, JSDoc on exported symbols — and Prettier's defaults line
up with its formatting (80 columns, two spaces, single quotes, semicolons,
trailing commas). Two rules need local judgement rather than literal
application:

- **`any` in rest-parameter positions is correct here and must stay.**
  `ActivityFn` and `AnyFn` take `(...args: any[])`, and `WorkflowFn` takes
  `(props?: any)`, because `strictFunctionTypes` makes parameters
  contravariant: a real `({name}: {name: string}) => Promise<string>` is _not_
  assignable to `(props?: unknown) => …`, so a registry typed that way would
  accept nothing anyone writes. Return types
  carry no such constraint and stay `unknown`. Each such `any` is documented
  at its declaration — Google's rule is to justify it, not to pretend it is
  avoidable.
- **A `switch` over a discriminated union ends in `default: assertNever(x)`**,
  not a bare `default`. Google requires a default case; an empty one would
  defeat the exhaustiveness check that makes an unhandled variant a compile
  error. See `services/rpc_server.ts`, where the alternative was a new RPC
  method silently returning `null` on the wire.

Prettier owns mechanical formatting — line width, indentation, quotes, trailing
commas (`.prettierrc.json`: `printWidth: 80`, `singleQuote: true`). Run `npm run
format`. What neither Prettier nor the Google guide enforces, apply yourself:

- **Every module opens with an `@fileoverview`** JSDoc block, blank line after
  it — not a plain `//` header. For what goes _in_ it, see
  [Documentation lives in the code](#documentation-lives-in-the-code).
- **Every exported symbol carries a JSDoc comment**, unless the module's
  `@fileoverview` already documents it — a single-purpose module named after
  the thing it exports needs no second copy (`condition.ts`,
  `microtask_scheduler.ts`).
- **Namespace imports, never default imports.** `import * as path from
'node:path'`, not `import path from 'node:path'` — and the same for packages
  (`import * as ts from 'typescript'`). A default import of a CommonJS module
  is a binding `esModuleInterop` _invents_ rather than one the module exports,
  so the same line means different things under different compiler settings,
  and the same module ends up spelled two ways in one repo — which is how this
  was found, `tools/style.ts` importing `* as path` while `tools/boundaries.ts`
  next door imported the default. Named imports (`import {readFileSync} from
'node:fs'`), type-only imports, and side-effect imports are untouched by
  this. **Checked** — see below.
- **`function` over arrow functions** for statement functions — including
  helpers in specs, which is where the exceptions used to collect. A `const`
  bound to an arrow is still right when the arrow is a _value_ satisfying a
  declared type (`export const silentLogger: Logger = () => {};`); the rule is
  about functions declared to be called, not about every arrow. That
  distinction is why this one is not machine-checked: a blanket check cannot
  tell the two apart.
- **`while (true)`, never `for (;;)`.**

### The rules that are checked

`npm run lint` runs [`tools/boundaries.ts`](tools/boundaries.ts) for layering,
[`tools/conventions.ts`](tools/conventions.ts) for the namespace-import rule
above, and [`tools/style.ts`](tools/style.ts) for three a regex cannot decide —
it builds a real TypeScript program, because "is this a promise?" is a question
about types and "is this await top-level?" is a question about scope. Its
`@fileoverview` explains each rule and the failure it prevents; in short:

- **A promise that is neither awaited nor `void`ed is an error.** An unhandled
  rejection is fatal to a Node process, and this repo has already lost a
  server to one. Writing `void` is how a deliberate fire-and-forget is
  distinguished from a forgotten `await` — a distinction only the author can
  make, so each `void` here carries a comment saying why.
- **No top-level `await` anywhere, and no `import.meta`.** The repo is
  CommonJS, which has neither: top-level `await` is TS1378 and a module using
  it does not run, and `import.meta` is a _syntax_ error rather than a
  diagnostic. Use `void run().then(…)`, and resolve paths from `__dirname`.
  `tsconfig.json` says why the module system is what it is.

The conventions checker is the one that reads the **whole tree** rather than a
compiler's view of it — `tools/` and `spec/` are in no tsconfig, and the first
default import it found was in `tools/`. Its rules are pure functions over file
contents, so [`spec/conventions.spec.ts`](spec/conventions.spec.ts) can feed
them planted breakage; the suite runs them, the same way it runs the boundary
and dependency rules.

One more is enforced by the compiler rather than a tool:
`noPropertyAccessFromIndexSignature` in `tsconfig.json` requires `obj['key']`
for anything reached through an index signature, so `process.env['PORT']` and a
declared field stop looking alike at the call site.

**Several rules used to live here and no longer do.** A harness import for the
dashboard's specs, bracket notation on DOM sinks, `window.`-qualified browser
globals, and an IIFE bundle format were all about browser code, and went with
the dashboard. Each checker's `@fileoverview` records which of its rules left
and why, so a rule is not silently reinvented.

## Testing

Tests go in `/spec`, structured like documentation — a file per "chapter", laid
out to mirror `src/`. Every capability should be covered somewhere, and the
deterministic core in particular has unit specs (`spec/core/`) because
integration tests alone will not catch a replay bug that only shows on an
unusual history.

### Two kinds of spec, on purpose

Not every test is documentation, and forcing it to be makes both worse.

- **Documentation specs** — the author-facing programming model, meant to be
  _read_ as the spec of what the engine does:
  `spec/integration/local.spec.ts`. Hold these to the conventions below.
- **Correctness / internals specs** — `spec/server/` and the
  distributed/resume integration specs. These prove invariants (version CAS,
  lease redelivery, durable timers). Keep them rigorous, but don't contort
  them into English prose; they document _for contributors_, not for authors.

### Conventions for documentation specs

1.  **`describe` names one capability**, ideally matching a heading a reader
    would look for (`local runtime — signals and condition`). One concept per
    block.
2.  **Each `it` is a full declarative sentence stating one guarantee.** Present
    tense, active voice, no "should", no test-jargon. It should read as a line
    of the manual:
    - ✅ `it('parks on a condition and wakes when a signal makes it true')`
    - ✅ `it('retries a flaky activity and succeeds within maximumAttempts')`
    - ❌ `it('should work with signals')`
    - ❌ `it('test condition 2')`
3.  **One guarantee per test.** If the name needs "and" between two _different_
    behaviors, split it. (An "and" describing a single cause→effect is fine.)
4.  **Each test is a minimal, self-contained example.** Define the workflow
    inline in the test so the reader sees the whole example in one place; avoid
    shared mutable fixtures.
5.  **Order simple → advanced** within a `describe`, so reading straight down
    teaches the capability.
6.  **Comment a test only where the mechanism isn't obvious from reading it** —
    why this case exists, or what would break without it. A well-named test over
    a minimal example needs no preamble; a comment restating the title is noise.

`spec/integration/local.spec.ts` is the reference for all six.

### Examples must be spec-covered

Every file in `examples/` must be exercised by a spec. An example nobody runs
rots silently; one that CI runs cannot. `examples/greeter.ts` is covered by
`spec/integration/distributed.spec.ts` and
`spec/integration/worker_entrypoint.spec.ts`.

## Commands

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run format
```

```bash
npm run format:check
```

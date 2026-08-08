# Working in this repo

Read [`README.md`](README.md) first — what the project is, how it's laid out,
and the reading order through the code.

## Structuring the code

The documentation rules below depend on this section: concepts have to map onto
modules, or there is nowhere for the explanation to live. Structure first, then
document.

**Organize by responsibility, not by technical kind.** The top-level split is
`protocol/`, `core/`, `server/`, `services/`, `worker/`, `client/` — each a job
the system does. Resist `types/`, `utils/`, `helpers/`, `handlers/`: those group
files by what they *are* rather than what they are *for*, and a concept spread
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

**Almost nothing is worth a dependency.** The engine has **none** — its runtime
allowlist is empty, and that is enforced rather than asserted. The dashboard is
allowed exactly one, `lit`, plus the engine itself. Not `@lit-labs/*` —
pre-release by definition — and not `@lit/*` either: "part of Lit" means the
`lit` package. A router, a virtualizer, a context library are each a few dozen
lines against the platform, and writing them is cheaper than carrying an
unstable dependency in infrastructure other things depend on. The dev toolchain
is a separate, equally short list: TypeScript, `tsx`, Jasmine, Prettier, and
`esbuild`. This is **checked, not trusted** —
[`tools/dependencies.ts`](tools/dependencies.ts) holds a list per package, and
`npm run lint` and the suite both fail on anything else. Adding to a list is
fine; doing it in the same commit that needs it, with a reason, is the point.

**There is a bundler now, and there did not used to be.** The old rule was that
`tsx` was the only thing that executed TypeScript, and the dashboard paid for it:
it shipped a server that compiled TypeScript *per request* and generated an
import map at page load, which put the TypeScript compiler in its runtime
dependencies. "Compile when asked" is not something a build system can express,
so the no-bundler rule was the thing standing between this repo and one.

`esbuild` replaced all of it and deleted more than it added — the transpile
path, the import map, the vendored-package route, and two flavours of extension
guessing. It is a single binary driven entirely by command-line flags, so the
same invocation works from an npm script and from a build rule with no config
file to keep in step. **It bundles the dashboard's browser code and nothing
else**: the engine still runs from source under `tsx`, and adding a build step
to it would be its own argument.

**The dashboard is a separate package, and the edge points one way.** It depends
on the engine — for the RPC it calls and the projection types it renders — and
the engine has never heard of it. That is why `lit` is not the engine's problem
and why `services/` does not contain a TypeScript transpiler. It is also
**checked**: [`tools/boundaries.ts`](tools/boundaries.ts) fails any mention of
`dashboard/` from `src/` — an import or a spawned path, since a hardcoded
sibling path is the same dependency and a worse one. This is exactly the
coupling that grew last time nothing was watching for it.

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

-   **Discoverability.** You find the explanation because you opened the file it
    describes, not because you knew a doc existed and went looking.
-   **It stays true.** A comment next to the code is in the same diff when
    behavior changes, so review catches drift. A parallel doc tree has no such
    forcing function and rots silently.

### Where each kind of thing goes

| Kind                                | Home                                   |
| ----------------------------------- | -------------------------------------- |
| What a module is, why it's shaped   | `@fileoverview` at the top of the      |
: that way, its caveats               : module                                 :
| The contract of one exported symbol | JSDoc on that symbol                   |
| Non-obvious local reasoning         | An inline comment at the point it      |
:                                     : applies                                :
| What the system guarantees          | A spec — executable, and it runs in CI |

An idea spanning several modules gets **one home**: the module that owns it;
others refer to it by path. The determinism boundary is owned by
`src/workflow.ts`, and `core/` modules point at it. Duplicating a concept across
three fileoverviews recreates the drift this pattern exists to prevent.

### Decisions, including the ones you didn't take

A decision is documentation with a shape of its own, and the rule above is not
enough by itself: "design rationale" says the choice was explained, not that the
**alternatives** were. Record what was rejected and why — that is the half that
stops the next reader relitigating something already settled, and the half that
tells them when reopening it *would* be right.

-   **The decision lives with the code it constrains**, in the `@fileoverview`
    of the module that owns the idea. Why the listing's order is not
    configurable is in `server/execution_query.ts`; why the URL carries a
    duration rather than an instant is in `dashboard/app/time_range.ts`. If you
    can't name the owning module, re-read
    [Homeless documentation is a design smell](#homeless-documentation-is-a-design-smell)
    — it's the same signal.
-   **Say what it cost to decide, not only what was decided.** "No sort control"
    is a note. "No sort control, because the cursor *is* the sort key, so a
    second ordering silently resolves old links into a differently-ordered set"
    is a decision — it survives someone who disagrees.
-   **An issue that lands says what shipped**, including any deviation from the
    shape it proposed and what was deliberately left undone. The issue keeps the
    problem statement, the code keeps the rationale, and the closing note is the
    link between them. See
    [#50](https://github.com/chrisrocco/tempo/issues/50).
-   **A decision *not* to build something still lands**, with the reasoning that
    made waiting the cheap option. Nothing was built, so no module can host it —
    which makes the issue its only home, and a reason to close it as
    `not_planned` rather than delete the thinking. See
    [#51](https://github.com/chrisrocco/tempo/issues/51) and
    [#48](https://github.com/chrisrocco/tempo/issues/48).
-   **When a decision outgrows a fileoverview, it belongs in the issue**, not in
    a design document that no code change will ever force someone to revisit.
    See [#33](https://github.com/chrisrocco/tempo/issues/33).

The forcing function is the one the rest of this section relies on: a decision
recorded beside the code it governs is in the diff when that code changes, so
review catches it going stale.

### When you're tempted to add a doc file

Find the module that owns the idea and put it there. If genuinely no module owns
it, that is a signal about what kind of thing it actually is — and it belongs in
one of the few places that legitimately sit outside the code:

-   **[`README.md`](README.md)** — what the project is, the layout, current
    status, and the reading order. The front door, for someone who has read
    nothing.
-   **[`ROADMAP.md`](ROADMAP.md)** — what is not built yet, and the invariants
    that hold while building it.
-   **GitHub issues** — in-flight design work: proposals, scoping, and decisions
    about code that doesn't exist yet, so there's no module to host them. See
    below.
-   **This file** — contributor conventions: process, not implementation.

### Design work lives in issues, not in the tree

There used to be a `planning/` directory of sprints and tickets. It is gone, and
adding it back is not the answer to "where does this proposal go" — open an
issue.

The reason is the one this whole section is built on. A proposal is **living
state**: it has a status, it accumulates a progress log, it gets superseded, and
it ends up associated with a pull request. A markdown file in the tree can
represent none of that, so it represents it by convention — a `Status:`
blockquote somebody has to remember to update — and the convention is exactly
what rots. Every other rule here works because a diff forces the update. Nothing
forces a ticket.

Issues have that state natively: open/closed, `not_planned` for a decision
against, labels, cross-references, and a link to the PR that closed them. They
are also where the reader already is.

Two failure modes this avoids, both of which happened:

-   **A ticket that describes a design the code no longer has.** Ticket 10 was
    written, corrected twice inside a day, and deleted the same week — while a
    GitHub issue tracked the same work correctly throughout, because it was the
    thing being edited rather than a copy of it.
-   **Two copies of one argument, drifting.** A ticket and an issue covering the
    same decision will diverge, and the reader has no way to tell which is
    current.

What stays in the tree is what a diff can keep honest: the rationale that lives
beside the code it constrains, `ROADMAP.md` for what is not built yet, and this
file.

### Keeping it honest

Update the module comment in the **same commit** as the behavior change; a
fileoverview that describes the old design is worse than none, because it is
believed. Where a comment and the code disagree, the code is the truth and the
comment is a bug — fix it rather than working around it. Don't leave a pointer
to something that no longer exists.

### Start here when orienting

| Read                                      | For                             |
| ----------------------------------------- | ------------------------------- |
| `src/workflow.ts`                         | The determinism boundary — the  |
:                                           : organizing idea, and the author :
:                                           : rules                           :
| `src/core/replay.ts`                      | Activation vs. replay, what     |
:                                           : suppresses a command,           :
:                                           : observe-don't-await             :
| `src/core/condition.ts`                   | How a workflow waits, and why   |
:                                           : `condition` exists              :
| `src/server/ports/workflow_task_queue.ts` | The two concurrency bugs the    |
:                                           : queue design prevents           :
| `src/services/local_service.ts`           | Local vs. distributed, and the  |
:                                           : failure-semantics caveat        :
| `spec/integration/local.spec.ts`          | The whole programming model,    |
:                                           : executable                      :

## Code style

The baseline is the
[Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).
Most of it the repo already satisfies structurally — no default exports, no
`var`, no `namespace`, no enums, `strict: true`, `snake_case` filenames, named
function declarations, JSDoc on exported symbols — and Prettier's defaults line
up with its formatting (80 columns, two spaces, single quotes, semicolons,
trailing commas). Two rules need local judgement rather than literal
application:

-   **`any` in rest-parameter positions is correct here and must stay.**
    `WorkflowFn`, `ActivityFn`, and `AnyFn` take `(...args: any[])` because
    `strictFunctionTypes` makes parameters contravariant: a real `(name: string)
    => Promise<string>` is *not* assignable to `(...args: unknown[]) => …`, so a
    registry typed that way would accept nothing anyone writes. Return types
    carry no such constraint and stay `unknown`. Each such `any` is documented
    at its declaration — Google's rule is to justify it, not to pretend it is
    avoidable.
-   **A `switch` over a discriminated union ends in `default: assertNever(x)`**,
    not a bare `default`. Google requires a default case; an empty one would
    defeat the exhaustiveness check that makes an unhandled variant a compile
    error. See `services/rpc_server.ts`, where the alternative was a new RPC
    method silently returning `null` on the wire.

Prettier owns mechanical formatting — line width, indentation, quotes, trailing
commas (`.prettierrc.json`: `printWidth: 80`, `singleQuote: true`). Run `npm run
format`. What neither Prettier nor the Google guide enforces, apply yourself:

-   **Every module opens with an `@fileoverview`** JSDoc block, blank line after
    it — not a plain `//` header. For what goes *in* it, see
    [Documentation lives in the code](#documentation-lives-in-the-code).
-   **Every exported symbol carries a JSDoc comment**, unless the module's
    `@fileoverview` already documents it — a single-purpose module named after
    the thing it exports needs no second copy (`condition.ts`,
    `microtask_scheduler.ts`).
-   **Namespace imports, never default imports.** `import * as path from
    'node:path'`, not `import path from 'node:path'` — and the same for packages
    (`import * as ts from 'typescript'`). A default import of a CommonJS module
    is a binding `esModuleInterop` *invents* rather than one the module exports,
    so the same line means different things under different compiler settings,
    and the same module ends up spelled two ways in one repo — which is how this
    was found, `tools/style.ts` importing `* as path` while `tools/boundaries.ts`
    next door imported the default. Named imports (`import {readFileSync} from
    'node:fs'`), type-only imports, and side-effect imports are untouched by
    this. **Checked** — see below.
-   **A spec under `spec/dashboard/` opens with `import 'jasmine';`.**
    `describe`/`it`/`expect` otherwise arrive as ambient globals from the root
    `tsconfig.json`'s `types`, which is a fact about the config rather than about
    the file. These are the specs sitting against the browser boundary —
    `dashboard/app/tsconfig.json` already sets `types: []` so ambient globals
    stop leaking into code that must not have them — so they name their harness
    and keep type-checking under a config that declares none. The rest of the
    suite still leans on the root config. **Checked** — see below.
-   **DOM sink writes use bracket notation.** In `dashboard/app/`, a write to
    `innerHTML`, `href`, `src`, `download` and friends is spelled
    `anchor['href'] = url`. A DOM security scanner matches `.href =` by *syntax*,
    so bracket notation is what separates a reviewed write from an unreviewed one
    — which makes it a claim, and the claim has to be true. It changes what a
    scanner matches, not what the browser does: say why the value is safe in a
    comment at the assignment. The export anchor in
    `dashboard/app/execution_detail.ts` is the worked example. **Checked** — see
    below.
-   **Browser globals are qualified with `window.`** in `dashboard/app/`:
    `window.localStorage`, `window.location.hash`, `window.document`,
    `window.setTimeout`, `window.fetch`. Bare, each of these is
    indistinguishable at the call site from an import or a local, and the
    dashboard's other half is Node — where `fetch`, `setTimeout`, and
    `navigator` all exist with different types and behaviour, and the two halves
    get edited in the same sitting. The list is window-owned *state and
    services*, not global constructors: `new URL(…)` and `new Blob(…)` stay as
    they are, because `new window.Blob()` reads as a mistake and nothing about a
    constructor is ambient. See `WINDOW_GLOBALS` in
    [`tools/style.ts`](tools/style.ts) for the exact set. **Checked** — see
    below.
-   **`function` over arrow functions** for statement functions — including
    helpers in specs, which is where the exceptions used to collect. A `const`
    bound to an arrow is still right when the arrow is a *value* satisfying a
    declared type (`export const silentLogger: Logger = () => {};`); the rule is
    about functions declared to be called, not about every arrow. That
    distinction is why this one is not machine-checked: a blanket check cannot
    tell the two apart.
-   **`while (true)`, never `for (;;)`.**

### The rules that are checked

`npm run lint` runs [`tools/boundaries.ts`](tools/boundaries.ts) for layering,
[`tools/conventions.ts`](tools/conventions.ts) for the written-shape rules — the
ones above, plus a few that are documented in the files they constrain rather
than here — and [`tools/style.ts`](tools/style.ts) for four a regex cannot decide —
it builds a real TypeScript program, because "is this a promise?" is a question
about types and "is this await top-level?" is a question about scope. Its
`@fileoverview` explains each rule and the failure it prevents; in short:

-   **A promise that is neither awaited nor `void`ed is an error.** An unhandled
    rejection is fatal to a Node process, and this repo has already lost a
    server to one. Writing `void` is how a deliberate fire-and-forget is
    distinguished from a forgotten `await` — a distinction only the author can
    make, so each `void` here carries a comment saying why.
-   **No top-level `await` anywhere, and no `import.meta`.** The Node half of
    the repo is CommonJS, which has neither: top-level `await` is TS1378 and a
    module using it does not run, and `import.meta` is a *syntax* error rather
    than a diagnostic. Use `void run().then(…)`, and resolve paths from
    `__dirname`. `tsconfig.json` says why the module system is what it is.
-   **No unqualified browser global in `dashboard/app/`.** The `window.` rule
    above, and the clearest case for needing a program rather than a regex:
    `routes.ts` declares a local named `history`, and the bare word appears over
    a hundred times across the app. Only the checker can tell that local from
    `window.history` — which is exactly why the qualified form is worth writing.

The conventions checker is the one that reads the **whole tree** rather than a
compiler's view of it — `tools/` and `spec/` are in no tsconfig, the first
default import it found was in `tools/`, and some of its rules are about files no
compiler reads at all. Its rules are pure functions over file contents, so
[`spec/conventions.spec.ts`](spec/conventions.spec.ts) can feed them planted
breakage; the suite runs them, the same way it runs the boundary and dependency
rules.

One more is enforced by the compiler rather than a tool:
`noPropertyAccessFromIndexSignature` in `tsconfig.json` requires `obj['key']`
for anything reached through an index signature, so `process.env['PORT']` and a
declared field stop looking alike at the call site. It points the same way as the
bracket-notation rule above without being the same rule: this one is about where
a property came from, that one about which properties are sinks.

## Testing

Tests go in `/spec`, structured like documentation — a file per "chapter", laid
out to mirror `src/`. Every capability should be covered somewhere, and the
deterministic core in particular has unit specs (`spec/core/`) because
integration tests alone will not catch a replay bug that only shows on an
unusual history.

### Two kinds of spec, on purpose

Not every test is documentation, and forcing it to be makes both worse.

-   **Documentation specs** — the author-facing programming model, meant to be
    *read* as the spec of what the engine does:
    `spec/integration/local.spec.ts`. Hold these to the conventions below.
-   **Correctness / internals specs** — `spec/server/` and the
    distributed/resume integration specs. These prove invariants (version CAS,
    lease redelivery, durable timers). Keep them rigorous, but don't contort
    them into English prose; they document *for contributors*, not for authors.

### Conventions for documentation specs

1.  **`describe` names one capability**, ideally matching a heading a reader
    would look for (`local runtime — signals and condition`). One concept per
    block.
2.  **Each `it` is a full declarative sentence stating one guarantee.** Present
    tense, active voice, no "should", no test-jargon. It should read as a line
    of the manual:
    -   ✅ `it('parks on a condition and wakes when a signal makes it true')`
    -   ✅ `it('retries a flaky activity and succeeds within maximumAttempts')`
    -   ❌ `it('should work with signals')`
    -   ❌ `it('test condition 2')`
3.  **One guarantee per test.** If the name needs "and" between two *different*
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
`spec/integration/distributed.spec.ts` and `spec/integration/cli.spec.ts`.

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

```bash
npm run tempo -- help
```

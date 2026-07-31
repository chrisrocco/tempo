# Working in this repo

Read [`README.md`](README.md) first — what the project is, how it's laid out, and
the reading order through the code.

## Structuring the code

The documentation rules below depend on this section: concepts have to map onto
modules, or there is nowhere for the explanation to live. Structure first, then
document.

**Organize by responsibility, not by technical kind.** The top-level split is
`protocol/`, `core/`, `server/`, `services/`, `worker/`, `client/` — each a job the
system does. Resist `types/`, `utils/`, `helpers/`, `handlers/`: those group files
by what they _are_ rather than what they are _for_, and a concept spread across
them belongs to no one.

**One module, one idea — nameable in a sentence.** If you can't finish "this
module is where we…" without an "and", it is two modules. `retry_policy.ts` was
pulled out of `server_core.ts` for exactly this reason: retry decisions are their
own idea, separately testable and separately explainable.

**Dependencies point one way.** `protocol <- core <- {server, services, worker,
client} <- {local_runtime, entrypoints, bin}`. A dependency that wants to point
back up means a responsibility is sitting on the wrong side of a line.

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
that as information about the structure, not as a documentation problem. The test:
if you can't name the owning module in one guess, something is wrong — usually a
responsibility smeared across modules that should be one, or a module quietly
doing several unrelated things. Fix the structure and the home appears.

A separate `docs/` tree hides this signal: prose can be organized independently of
the code, so it can describe a structure the tree doesn't have — and keep
describing it long after the code moves.

## Documentation lives in the code

**Anything a reader needs in order to understand or safely change an
implementation belongs in a comment in the module it concerns** — architecture and
how modules relate, design rationale, constraints, invariants, caveats, failure
semantics, operational notes. This repo has no `docs/` tree, and adding one back
is not the answer to "where should this go?"

Two reasons this is worth the discipline:

- **Discoverability.** You find the explanation because you opened the file it
  describes, not because you knew a doc existed and went looking.
- **It stays true.** A comment next to the code is in the same diff when behavior
  changes, so review catches drift. A parallel doc tree has no such forcing
  function and rots silently.

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

### When you're tempted to add a doc file

Find the module that owns the idea and put it there. If genuinely no module owns
it, that is a signal about what kind of thing it actually is — and it belongs in
one of the few places that legitimately sit outside the code:

- **[`README.md`](README.md)** — what the project is, the layout, current status,
  and the reading order. The front door, for someone who has read nothing.
- **[`ROADMAP.md`](ROADMAP.md)** — what is not built yet, and the invariants that
  hold while building it.
- **[`planning/`](planning/)** — in-flight design work, sprints, and tickets:
  proposals for code that doesn't exist yet, so there's no module to host them.
- **This file** — contributor conventions: process, not implementation.

### Keeping it honest

Update the module comment in the **same commit** as the behavior change; a
fileoverview that describes the old design is worse than none, because it is
believed. Where a comment and the code disagree, the code is the truth and the
comment is a bug — fix it rather than working around it. Don't leave a pointer to
something that no longer exists.

### Start here when orienting

| Read                                      | For                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `src/workflow.ts`                         | The determinism boundary — the organizing idea, and the author rules |
| `src/core/replay.ts`                      | Activation vs. replay, the live edge, observe-don't-await            |
| `src/core/condition.ts`                   | How a workflow waits, and why `condition` exists                     |
| `src/server/ports/workflow_task_queue.ts` | The two concurrency bugs the queue design prevents                   |
| `src/services/local_service.ts`           | Local vs. distributed, and the failure-semantics caveat              |
| `spec/integration/local.spec.ts`          | The whole programming model, executable                              |

## Code style

Prettier owns mechanical formatting — line width, indentation, quotes, trailing
commas (`.prettierrc.json`: `printWidth: 80`, `singleQuote: true`). Run
`npm run format`. What it does **not** enforce, apply yourself:

- **Every module opens with an `@fileoverview`** JSDoc block, blank line after it
  — not a plain `//` header. For what goes _in_ it, see
  [Documentation lives in the code](#documentation-lives-in-the-code).
- **Every exported symbol** — variable, function, class — carries a JSDoc comment.
- **`function` over arrow functions** for statement functions. Inline expressions
  stay arrows.
- **`while (true)`, never `for (;;)`.**

## Testing

Tests go in `/spec`, structured like documentation — a file per "chapter". They
should exhaustively cover features and functionality.

### Two kinds of spec, on purpose

Not every test is documentation, and forcing it to be makes both worse.

- **Documentation specs** — the author-facing programming model, meant to be
  _read_ as the spec of what the engine does: `spec/integration/local.spec.ts`.
  Hold these to the conventions below.
- **Correctness / internals specs** — `spec/server/` and the
  distributed/resume integration specs. These prove invariants (version CAS,
  lease redelivery, durable timers). Keep them rigorous, but don't contort them
  into English prose; they document _for contributors_, not for authors.

### Conventions for documentation specs

1. **`describe` names one capability**, ideally matching a heading a reader would
   look for (`local runtime — signals and condition`). One concept per block.
2. **Each `it` is a full declarative sentence stating one guarantee.** Present
   tense, active voice, no "should", no test-jargon. It should read as a line of
   the manual:
   - ✅ `it('parks on a condition and wakes when a signal makes it true')`
   - ✅ `it('retries a flaky activity and succeeds within maximumAttempts')`
   - ❌ `it('should work with signals')`
   - ❌ `it('test condition 2')`
3. **One guarantee per test.** If the name needs "and" between two _different_
   behaviors, split it. (An "and" describing a single cause→effect is fine.)
4. **Each test is a minimal, self-contained example.** Define the workflow inline
   in the test so the reader sees the whole example in one place; avoid shared
   mutable fixtures.
5. **Order simple → advanced** within a `describe`, so reading straight down
   teaches the capability.
6. Put a multi-line comment above each test case explaining, tutorial-style, how
   to use the thing and how it works.

`spec/integration/local.spec.ts` is the reference example of all six.

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

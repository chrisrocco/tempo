# 07 — The tutorial

**Type:** scoping · **Input:** the module comments that already hold every
concept, [`AGENTS.md`](../../AGENTS.md)'s documentation rules, and the empty
`examples/flights/` directory somebody meant to fill

## Objective

A task-oriented tutorial that teaches the engine by building one thing, in an
order chosen for learning rather than for architecture — without creating a
second source of truth about the code.

## The finding

**The no-`docs/` rule is right, and it is aimed at the wrong half of the
problem.** What it exists to prevent is *reference* documentation: prose that
describes what a module does, organized independently of that module, free to
keep describing a design the code has since moved away from. That rule should
not be relaxed, and this proposes no exception to it.

What it has been enforced as, in practice, is a ban on prose generally. That
leaves a gap the module comments structurally cannot fill:

| question                             | who owns the answer today |
| ------------------------------------ | ------------------------- |
| What is a differ, and what are its caveats? | `patterns/diff.ts` — well |
| Why does replay work the way it does? | `core/replay.ts` — well |
| What do I do first, and then what?    | **nobody** |

Every concept is documented where it lives. Nothing documents them **in
sequence**. A newcomer can read every `@fileoverview` in the repo and still not
know what to build first, which of the concepts they need on day one, or which
they can ignore until something breaks. Reference answers *"what is this?"*; a
tutorial answers *"what do I do?"* — and no module owns a sequence, because a
sequence is not a property of any one module.

The reading order in `README.md` is not this. It orders the code for someone who
wants to understand the implementation. That is a different audience with a
different goal, and conflating the two is how tutorials end up teaching
internals nobody asked about.

## The rule this needs

**Documentation may depend on code. Code must never depend on documentation.**

The same one-way rule the module layering already follows, applied to prose. It
is what keeps the tutorial deletable: nothing in `src/` should break, or even
notice, if this were removed tomorrow.

The second half matters as much:

**A hard reference is a dependency, and every dependency can rot.** Docs should
name code as rarely as they can bear to. A tutorial that says
`src/core/workflow_api.ts` breaks *silently* the day that file moves. A tutorial
that says `tempo up examples/flights/booking.ts` breaks **loudly**, because CI
runs that example.

So the operational rule is: **prefer references CI executes over references a
human has to verify.** Commands and runnable example paths are fine — they are
covered by specs. Module paths, symbol names, and line numbers are not, and
should appear only where there is genuinely no substitute.

### The amendment to AGENTS.md

Proposed, to land in the same commit as the first chapter — the repo's own rule
for changing a rule. Replacing the "When you're tempted to add a doc file"
section's implicit ban with an explicit split:

> **Reference lives in the code. Instruction may live outside it.**
>
> The ban is on *reference* documentation — prose that explains what a module
> is, how it behaves, or why it is shaped that way. That belongs in the module,
> for the two reasons above, and a `docs/` tree for it is still the wrong
> answer.
>
> **Task-oriented and educational writing is a different kind of thing.** It
> connects concepts that are each documented in their own module into a sequence
> optimized for learning or for getting a job done. No module owns a sequence,
> so there is nowhere in the code for it to live. `TUTORIAL.md` is that, and is
> a sanctioned root file alongside the others.
>
> Two rules keep it from becoming the thing this section exists to prevent:
>
> 1.  **Code must never reference the docs.** Not "see TUTORIAL.md", not in a
>     fileoverview, not in an inline comment. The dependency points one way, so
>     the docs can be rewritten or deleted without touching a line of `src/`.
> 2.  **The docs reference code as little as they can.** Prefer a runnable
>     command, which CI exercises and which fails loudly when it rots, over a
>     module path or a symbol name, which fails silently. Never a line number.
>
> A tutorial that starts explaining a module's contract has drifted into
> reference, and the fix is to delete the explanation and let the module's own
> comment carry it.

### Open question: does `planning/` count?

Thirteen comments in `src/` and `ui/` currently point at `planning/` or
`AGENTS.md`. Under a strict reading of rule 1, all thirteen are violations.

They are arguably a different case: `planning/` holds *decision records*, and a
comment saying "this shape was chosen for the reason recorded there" is a
citation rather than a dependency on documentation of itself. But the rot risk
is real — several point at sprints that are now finished.

Three options, needing a decision before this lands:

| option                                     | cost |
| ------------------------------------------ | ---- |
| Rule applies to `TUTORIAL.md` only          | Cheapest. Leaves the existing citations alone, and leaves the rot |
| Rule applies to all prose; strip the thirteen | Most consistent. The rationale has to move *into* the comments, which is where it should have been |
| Rule applies to all prose; grandfather them | Worst of both — a rule with exceptions nobody can remember |

The second is the honest one, and it is more work than it looks: several of
those references are load-bearing, so the reasoning has to be inlined rather
than just deleted.

### Worth machine-checking

This repo checks its rules rather than trusting them. Rule 1 is a one-line
regex over source comments — a docs path appearing anywhere under `src/`,
`ui/`, or `bin/` is an error — and it belongs in `tools/` beside the other
three. It should land with the rule, not after it.

## The spine

**One domain throughout: booking a flight.** It is the canonical
durable-execution problem, and it earns every concept honestly rather than
manufacturing a reason for each one:

-   reserve → charge → ticket is a sequence where a crash halfway matters
-   charging a card is the idempotency example, not a hypothetical one
-   approval is a signal with an obvious reason to exist
-   a fare feed is a poller with an obvious reason to exist
-   compensation has somewhere real to happen

It also fills `examples/flights/`, which is an empty directory someone created
with this in mind.

## Chapters

Each is one runnable example plus enough prose to say why. **Part I is the
vertical slice**: if the format is wrong, it is wrong by chapter three.

### Part I — the model

| #   | Chapter                  | What it has to earn                                                 |
| --- | ------------------------ | ------------------------------------------------------------------- |
| 1   | Run one workflow         | One command brings up a server, a worker, and an execution          |
| 2   | Activities: where I/O lives | Why workflow code cannot `fetch`, and what the proxy is for      |
| 3   | Replay, and the rules    | Your function ran three times and that is fine. No clock, no random |

### Part II — durability

| #   | Chapter            | What it has to earn                                                        |
| --- | ------------------ | -------------------------------------------------------------------------- |
| 4   | Crash it           | Kill the server mid-booking, restart, watch it carry on. **The chapter that sells the project** |
| 5   | Waiting            | A workflow that waits a week costs nothing while it waits                  |
| 6   | Failure and retry  | The server decides retries — and why an activity must be safe to run twice |

### Part III — interaction and composition

| #   | Chapter            | What it has to earn                                                    |
| --- | ------------------ | ---------------------------------------------------------------------- |
| 7   | Signals and waiting on them | Hold a booking until someone approves it                       |
| 8   | Child workflows    | Fan out per passenger; a failed child's id is spent for good           |
| 9   | Running forever    | Rolling over, what survives it, and watching a fare feed               |

### Part IV — operating

| #   | Chapter             | What it has to earn                                                        |
| --- | ------------------- | -------------------------------------------------------------------------- |
| 10  | Going distributed   | Server and workers as separate processes, and the failure semantics that **change** |
| 11  | When it goes wrong  | Break determinism deliberately, find it, fix it, resume                    |

**Chapter 11 is the one worth fighting for.** Rules become intuition only after
you have broken one and recovered. It is also the only chapter that exercises
the observability surface end to end — a wedged execution reporting `running`,
the badge that says so, and the queue view that answers "is anything even
serving this?", which is the failure most often misdiagnosed as a code bug.

## What every chapter must not do

-   **Explain a module's contract.** That is reference, it already exists, and a
    second copy is the thing this whole convention is about.
-   **Name a file, a symbol, or a line** unless a command genuinely cannot stand
    in for it.
-   **Teach internals.** How replay works belongs to `core/replay.ts` and to the
    README's reading order. A tutorial reader needs the rules, not the mechanism.
-   **Grow a snippet that no spec runs.** Every line of code in the tutorial
    comes from an example CI exercises, or it is not in the tutorial.

## Risks

-   **Duplication with module comments.** The likeliest failure, and the reason
    for the "must not" list. The split to hold: the tutorial owns *sequence and
    motivation*, the module owns *contract and caveat*. When a chapter starts
    listing options, it has crossed over.
-   **Abandonment.** Eleven chapters is a lot to keep true. Mitigated by the
    examples carrying the code and the specs carrying the examples, so what can
    rot is prose about *why*, which changes far more slowly than code.
-   **Two audiences in one repo.** The README's reading order and this have
    different readers, and each needs a line at the top saying which it is for.

## Not in scope

An API reference (the modules have it), internals (the reading order has it),
migration guides, and deployment beyond what chapter 10 needs to make the
distributed failure semantics concrete.

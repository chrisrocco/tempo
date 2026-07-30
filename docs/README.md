# Documentation

The design and reference material for the workflow engine, organized by **what
you're trying to do** — and, underneath that, by **where each kind of truth
lives**, so docs decay slowly and visibly.

| Bucket                         | Answers                               | Source of truth                                        |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------ |
| [concepts/](concepts/)         | _Why does it work this way?_          | design intent (prose)                                  |
| [architecture/](architecture/) | _Where is X / how is it built?_       | the code layout (see [`PROJECT.md` §3](../PROJECT.md)) |
| [behavior/](behavior/)         | _What exactly is guaranteed?_         | the specs (`spec/`, executable)                        |
| [guides/](guides/)             | _How do I…?_                          | runnable examples (`examples/`) + narration            |
| [contributing/](contributing/) | _How do I change the code correctly?_ | project conventions                                    |

Two companion docs live at the repo root, not here, because they track the
_moving_ state rather than the stable design:

- **[`PROJECT.md`](../PROJECT.md)** — the "you are here": current build status, the
  live annotated file tree (§3), and a doc-vs-code divergence table (§4). **Read
  this first on a fresh session**, and trust it over any concept doc where they
  disagree.
- **[`ROADMAP.md`](../ROADMAP.md)** — the phased implementation plan.

## Reading order

New to the codebase? Read the concepts top-to-bottom, then skim the architecture:

1. [Overview](concepts/overview.md) — what the engine is and the core loop.
2. [The Determinism Boundary](concepts/determinism-boundary.md) — _the_ organizing idea; everything is downstream of it.
3. [Replay & Execution Model](concepts/replay-and-execution.md) — how a workflow actually advances.
4. [Conditions, Signals & Timers](concepts/conditions-signals-timers.md) — the three ways a workflow waits.
5. [Continue-As-New](concepts/continue-as-new.md) — bounding history for long-lived workflows.
6. [Type Model](concepts/type-model.md) — the `protocol/` contract both sides speak.
7. [Structure & Layers](architecture/structure-and-layers.md) — the layered code map and the two rules that keep it honest.
8. [Distribution](architecture/distribution.md) — scaling to three resilient tiers, and the failure-semantics caveat.
9. [Task Execution & Concurrency](architecture/task-execution-and-concurrency.md) — the two concurrency bugs the design prevents.

Then: **[behavior/](behavior/README.md)** to see the guarantees proven in the
suite, **[guides/](guides/README.md)** to build something, and
**[contributing/](contributing/)** before you change the code.

## How the buckets relate

- **concepts** explain _why_; **behavior** points at the specs that _prove_ the
  resulting guarantees. A capability (say, `condition`) can appear in both — the
  concept doc explains the `blockedConditions` mechanism, the behavior entry links
  to the spec that pins its observable behavior.
- **architecture** describes _principles_ (layers, seams, dependency direction).
  The exact live file tree lives in [`PROJECT.md` §3](../PROJECT.md) so it's
  maintained in one place instead of duplicated here.
- **guides** are anchored to runnable, spec-covered examples in `examples/` — see
  [testing conventions](contributing/testing-conventions.md) for that rule and
  why it's the anti-rot mechanism for how-to docs.

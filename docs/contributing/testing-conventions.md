# Testing Conventions

The suite is not just a correctness gate — for behavior, it **is** the
documentation ([behavior/](../behavior/README.md)). These conventions keep it
readable as a specification and keep the guides that lean on it from rotting.

## Two kinds of spec, on purpose

Not every test is documentation, and forcing it to be makes both worse.

- **Documentation specs** — the author-facing programming model. These are meant
  to be *read* as the spec of what the engine does:
  [`spec/integration/local.spec.ts`](../../spec/integration/local.spec.ts) and
  [`spec/examples/`](../../spec/examples/). Hold them to the conventions below.
- **Correctness / internals specs** — [`spec/server/`](../../spec/server/) and the
  distributed/resume integration specs. These prove invariants behind the
  [architecture](../architecture/) docs (version CAS, lease redelivery, durable
  timers). Keep them rigorous, but don't contort them into English prose; they
  document *for contributors*, not for authors.

## Conventions for documentation specs

1. **`describe` names one capability** — ideally matching a heading a reader would
   look for (`local runtime — signals and condition`). One concept per block.
2. **Each `it` is a full declarative sentence stating one guarantee.** Present
   tense, active voice, no "should", no test-jargon. It should read as a line of
   the manual:
   - ✅ `it('parks on a condition and wakes when a signal makes it true')`
   - ✅ `it('retries a flaky activity and succeeds within maximumAttempts')`
   - ❌ `it('should work with signals')`
   - ❌ `it('test condition 2')`
3. **One guarantee per test.** If the name needs "and" between two *different*
   behaviors, split it. (An "and" describing a single cause→effect is fine — see
   the first example above.)
4. **Each test is a minimal, self-contained example.** Define the workflow inline
   in the test (as `local.spec.ts` does) so the reader sees the whole example in
   one place; avoid shared mutable fixtures in documentation specs.
5. **Order simple → advanced** within a `describe`, so reading straight down
   teaches the capability.

[`spec/integration/local.spec.ts`](../../spec/integration/local.spec.ts) is the
reference example of all five.

## Keep docs and specs cross-linked

Drift becomes visible when prose and specs point at each other:

- Each capability in [behavior/](../behavior/README.md) links to the `describe`
  block that proves it.
- Concept docs link out to the behavior entry for their guarantees rather than
  restating them.

Behavior lives in the specs (executable); rationale lives in the concept docs
(prose). Neither should duplicate the other.

## The example-anchor rule (for guides)

**Every how-to [guide](../guides/README.md) must be anchored to a runnable file in
[`examples/`](../../examples/) that a spec exercises.** The guide narrates
motivation, sequencing, and gotchas around that example; it does **not** embed a
second copy of the code.

This is the anti-rot mechanism for task-oriented docs — the highest-rot category,
because they contain concrete snippets and step orders. If the example breaks, CI
catches it, so the guide's spine can't silently go stale. A how-to with no
spec-covered example behind it doesn't meet the bar yet: write (or extend) the
example and its spec first.

[`examples/bug_hotlist_monitor.ts`](../../examples/bug_hotlist_monitor.ts), covered
by [`spec/examples/bug_hotlist_monitor.spec.ts`](../../spec/examples/bug_hotlist_monitor.spec.ts),
is the model anchor.

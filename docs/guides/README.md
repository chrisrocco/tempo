# Guides

Task-oriented docs: _how do I…?_ Where [concepts](../concepts/) explain **why** and
[behavior](../behavior/README.md) states **what's guaranteed**, guides walk you
through **doing** something.

## Split by audience

The task surface splits along the same line as the two entrypoints — which is the
[determinism boundary](../concepts/determinism-boundary.md) itself:

- **[authoring/](authoring/)** — for **workflow authors** writing code against the
  deterministic surface (`workflow.ts`): run activities, wait on signals, spawn and
  cancel children, roll over with continue-as-new.
- **[extending/](extending/)** — for **engine contributors** changing the engine
  itself (`index.ts` / `core` / `server`): add a durable adapter, add a primitive,
  deploy distributed.

Plus one on-ramp for everyone:

- **[Getting Started](getting-started.md)** — build and run your first workflow,
  end to end, using the motivating example.

## Two kinds of guide

- **Tutorial** — a single guided first experience ([Getting Started](getting-started.md)).
  There is deliberately only one; tutorials are expensive to maintain.
- **How-to guides** — goal-oriented recipes (everything under `authoring/` and
  `extending/`). These are the workhorse.

## The rule every how-to follows

**Each how-to is anchored to a runnable, spec-covered example in
[`examples/`](../../examples/).** The guide narrates around the example; it never
becomes a second, un-tested copy of the code. See
[testing conventions](../contributing/testing-conventions.md#the-example-anchor-rule-for-guides)
— this is what stops task docs (the fastest-rotting kind) from going stale. A
how-to without a spec-covered example behind it isn't ready to write yet.

# 03 — Document: activities must not do I/O at module scope

**Type:** docs · **Size:** small · **Relates to:**
[`planning/sprints/01-deployment-api.md`](../sprints/01-deployment-api.md)

## Problem

Under the deployment API, an activity module's **top-level code runs in processes
that never execute activities**, and users have no way to guess this.

`worker.ts` value-imports both namespaces into one binary:

```ts
import * as activities from './activities';
import * as workflows from './workflows';
```

So module-scope side effects in `activities.ts` execute:

1. in the **workflow-role** process (`TEMPO_ROLE=workflow`) — it loads the whole
   bundle even though it never calls an activity,
2. during **`tempo deploy`**, which runs `<binary> --describe` to interrogate the
   artifact,
3. in every activity replica, as expected.

A connection pool, network client, or file handle opened at module top level is
therefore created in the workflow worker and on the deploy machine — connections
nobody closes, and a deploy that fails when a database happens to be unreachable.

## Work

Add a short constraint note — a paragraph, not a section — stating that activity
modules must keep top-level code side-effect-free, and that connection setup
belongs **inside** the activity function (lazily memoized on first call if it
needs to be shared).

Place it in:

- [`docs/guides/build-and-deploy.md`](../../docs/guides/build-and-deploy.md) — at
  step 1, where activities are introduced.
- [`docs/concepts/determinism-boundary.md`](../../docs/concepts/determinism-boundary.md)
  — if it fits the existing framing; the boundary doc already governs where I/O
  is allowed, and this is a statement about _when_ it happens.

## Acceptance criteria

- [ ] The constraint is stated where an author writing their first activity will
      see it.
- [ ] It says what to do instead (lazy init inside the function), not just what
      to avoid.
- [ ] It stays short — this is a footnote-weight rule, not a new concept.

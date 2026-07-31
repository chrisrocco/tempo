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

- [`src/tempo.ts`](../../src/tempo.ts) — the `startWorker` fileoverview, since it
  is that call's value-import of both namespaces that causes the problem.
- [`examples/greeter.ts`](../../examples/greeter.ts) — beside the existing note
  about splitting activities and workflows into separate modules, which is where
  an author writing their first activity is looking.
- [`src/worker/activity_registry.ts`](../../src/worker/activity_registry.ts) — if
  it fits; that module already states activities register there and nowhere else,
  and this is a statement about _when_ their module-scope code runs.

## Acceptance criteria

- [ ] The constraint is stated where an author writing their first activity will
      see it.
- [ ] It says what to do instead (lazy init inside the function), not just what
      to avoid.
- [ ] It stays short — this is a footnote-weight rule, not a new concept.

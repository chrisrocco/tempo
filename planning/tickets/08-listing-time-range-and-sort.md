# 08 — The executions listing cannot answer "what broke in the last hour"

**Type:** gap (protocol + dashboard) · **Size:** small

## Problem

[`ExecutionFilter`](../../src/protocol/service.ts) has five fields — `status`,
`name`, `taskQueue`, `workflowIdPrefix`, `stuck` — and none of them is time. So
the most ordinary triage question there is cannot be asked, and the only way to
approximate it is to read the age column and stop scrolling when it looks old
enough.

The sort key already exists: the listing is newest-first on `createdAt`, and the
cursor encodes it.

## Shape

Add `createdAfter` / `createdBefore` to `ExecutionFilter` and honour them in
[`execution_query.ts`](../../src/server/execution_query.ts), then add the fields to
`RouteFilter` in [`routes.ts`](../../dashboard/app/routes.ts) so the filtered view
stays a link — that is the property the whole filter bar is built around.

A **sort control** is the smaller sibling and may not be wanted at all: newest
first is right nearly always, and an option that is nearly always wrong is
clutter. Decide rather than assume.

## Watch for

The counts strip and the listing poll independently. A time filter on the listing
does not narrow the counts above it, which is correct but reads oddly the first
time — "3 failed" over a filtered table showing one. Worth a moment's thought
about whether the strip should say it is unfiltered.

## Acceptance criteria

- [ ] `ExecutionFilter` carries a time range and the server honours it.
- [ ] The filter round-trips through the URL like the existing five.
- [ ] A decision is recorded on whether a sort control is wanted.
- [ ] `npm run typecheck` clean; `npm test` green.

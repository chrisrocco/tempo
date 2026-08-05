# 08 — The executions listing cannot answer "what broke in the last hour"

**Type:** gap (protocol + dashboard) · **Size:** small

> **Status: landed.** `ExecutionFilter` carries `createdAfter`/`createdBefore`
> as a half-open interval, honoured in
> [`execution_query.ts`](../../src/server/execution_query.ts); the dashboard has
> a range control backed by [`time_range.ts`](../../dashboard/app/time_range.ts).
>
> Three decisions, two of them deviations from the shape below:
>
> - **No sort control.** The cursor _is_ the sort key, so a second ordering
>   needs a second cursor encoding, and a link built under one silently resolves
>   into the middle of a differently-ordered set under the other. Paid on every
>   page, for an option that is close to always wrong. Reasoning is in the
>   `execution_query.ts` fileoverview, which owns ordering.
> - **The URL holds the duration, not the resolved instant** — `?since=1h`, not
>   `?after=<ms>`. So `RouteFilter` is no longer a plain `Pick` of
>   `ExecutionFilter`: the two differ by one field and `queryFilter` converts.
>   The deciding argument was not link readability but that a frozen window in a
>   view polling every two seconds is a live display that has quietly stopped
>   being live. Full reasoning in `time_range.ts`.
> - **The counts strip stays unfiltered and stays unlabelled.** The oddness the
>   ticket predicted is real but pre-existing — it applies to `name` just as
>   much as to time. Narrowing the strip would break what it is _for_: it is how
>   a reader gets out of a filter that is hiding the problem. Recorded in the
>   `counts_strip.ts` fileoverview.
>
> **Not done:** no lower-bound control (`createdBefore` is in the protocol and
> honoured, but no UI writes it — a date picker is a lot to build for "what
> broke _then_"), and `tempo list` gained no `--since`. The CLI would need a
> duration vocabulary of its own, since `time_range.ts` lives in the dashboard
> package and the engine cannot import it.

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

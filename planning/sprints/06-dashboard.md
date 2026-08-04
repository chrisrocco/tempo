# 06 — The observability dashboard

**Type:** scoping · **Input:** the read surface in
[`protocol/service.ts`](../../src/protocol/service.ts), the RPC transport in
[`services/rpc_server.ts`](../../src/services/rpc_server.ts), and the log events
in [`server/server_core.ts`](../../src/server/server_core.ts)

## Objective

A dashboard that answers "what is running, what is broken, and why" without
reading JSON by hand. Served by the tempo server itself at `/ui`, built with Lit
and nothing else.

## Status

**Phase 0 is complete**, and the two views built on it are in: the executions
list (filter bar, paging, `STUCK` badge) and the execution detail view (the two
failure panels, pending work, carryover, paged history, and the control
actions). What is left from the plan below is the **Queues & types** view, plus
the two deferred items — SSE and the worker registry.

Two things the sprint did not anticipate, both landed here:

-   **`ui/` was not type-checked at all.** The root `tsconfig.json` never
    included it and has no DOM lib, so the claim that a field added to a
    projection becomes a compile error in the dashboard was aspirational. There
    is now a second config (`ui/tsconfig.json`), and `npm run typecheck` and the
    style checker both run over both.
-   **Filters live in the URL**, not in component state — see `ui/routes.ts`.
    The most useful thing an operator produces is a link pointing at the
    problem, and filter state held in a component cannot be pasted into a
    ticket.

## The finding

**This is a read-API project wearing a UI.** The Lit half is the easy half, and
scoping it as a frontend task would produce a JSON pretty-printer.

The decisive gap: **history events carry no timestamps.** `CompletionEventBase`
is `{seq: number}`. No event knows when it happened, so there is no duration, no
timeline axis, no "started 3 minutes ago", no slow-activity view. Nearly every
question an observability tool exists to answer is a question about time.

The irony is that the richest data in the system is already produced and then
thrown away: `activity.settled` carries `durationMs`, and `activity.retry_scheduled`,
`workflow_task.failed`, and nine others each carry a `ts` — emitted as JSON Lines
to **stderr**, where nothing can query them.

| capability                          | today                                  |
| ----------------------------------- | -------------------------------------- |
| list executions                     | ✅ all of them, no filter, no paging   |
| describe one                        | ✅ history, carryover, failure + stack |
| start / signal / cancel / terminate | ✅                                     |
| timestamps on history events        | ❌ none                                |
| browser access (CORS)               | ❌ POST-only handler, no preflight     |
| streaming                           | ❌ polling only                        |
| worker / queue introspection        | ❌ nothing exists                      |
| `taskQueue` on the summary          | ❌ on the record, not the projection   |
| auth                                | ❌                                     |

## Decisions taken

1. **Served from the tempo server at `/ui`.** One binary, nothing to install,
   and same-origin — which removes the CORS problem rather than solving it.
2. **Control actions included.** Signal, cancel, and terminate are one call each
   and are most of the value. This is an internal tool on a trusted network.
   **It is not safe to expose**, because the RPC has no auth: anyone who can
   reach the port can terminate any execution. That is a pre-existing property
   of the server, and `--host` already warns about it, but shipping a UI makes
   it easier to forget.
3. **Phase 0 lands first, as its own PR.** Timestamps are a durable-format
   change and deserve review that is not tangled with a UI diff.
4. **Lit and nothing else.** No `@lit-labs/*`, no `@lit/*`, no bundler. Enforced
   by [`tools/dependencies.ts`](../../tools/dependencies.ts).

## What the no-dependency rule costs, and what replaces it

Each of these would ordinarily be a package. None is more than a modest amount
of code, and the constraint pushes the design somewhere better in two of the
three cases.

| would have used         | instead                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@lit-labs/router`      | hash routing over `popstate`, ~40 lines. Three routes.                                                                                                                      |
| `@lit-labs/virtualizer` | **server-side paging** (Phase 0 item 3). Better anyway: the client stops downloading 100k records to show 50.                                                               |
| `@lit/context`          | one module-level client instance, imported directly. Context solves a problem this app does not have.                                                                       |
| a bundler               | the server transpiles `.ts` on request with `ts.transpileModule` — `typescript` is already a dependency and `tools/style.ts` already uses the compiler API. Cache by mtime. |

Serving Lit itself needs an **import map**: `lit` resolves internally to
`lit-html` and `@lit/reactive-element`, so the server exposes `node_modules/lit`,
`lit-html`, `lit-element`, and `@lit/reactive-element` under `/ui/vendor/` and
emits a map naming all four. That is the one genuinely fiddly part of the
no-bundler choice, and it is confined to one module.

**Lit without decorators.** `static properties` and `customElements.define`
rather than `@customElement`/`@property`, so the served TypeScript is
type-annotations-only. Keeps transpilation trivial and leaves the door open to
Node's native type stripping later.

## Phase 0 — make the server answerable

Not optional; nothing below works without it.

1. **`ts` on every history event.** Set server-side at append. Optional field, so
   existing data dirs stay readable. Deterministic because it is recorded once
   and replayed identically — the same approach Temporal takes, and the same
   field that would later support a `workflow.now()` primitive. **Highest value
   item in the project.**
2. **Static serving + `/ui`.** File serving, the import map, and on-request
   transpilation. No CORS needed once same-origin.
3. **`listExecutions(filter)`** — status, name, `taskQueue`, id prefix, plus
   `limit`/`cursor`. Today it returns every execution with its full record.
4. **`taskQueue` on `ExecutionSummary`** — one line, exactly like the
   `taskFailures` change that made `tempo list --stuck` possible.
5. **Paged history** on `describeExecution`. A 4096-event history is now the
   _expected_ size, since that is the rollover threshold.

Deferred, and worth their own sprint: an SSE endpoint so the UI stops polling,
and a worker registry so "is anything actually serving my queue" becomes
answerable at all.

## Views

| view                  | answers                               | needs               |
| --------------------- | ------------------------------------- | ------------------- |
| **Executions** (home) | what is running, what is broken       | Phase 0 (3) (4)     |
| **Execution detail**  | why is _this_ one doing that          | nothing new         |
| **History timeline**  | what happened, in order, how long     | Phase 0 (1) (5)     |
| **Queues & types**    | which pools and workflows are failing | Phase 0 (4)         |
| **Live feed**         | what is happening right now           | SSE (deferred)      |
| **Workers**           | is anything serving my queue          | registry (deferred) |

The **executions list** is where this session's real pain lives: a `STUCK` badge
driven by `isStuck`, a filter for it, and a failed filter — recall that a failed
child permanently burns its workflow id and _nothing_ surfaces that today.

The **execution detail** view is nearly free: `describeExecution` already returns
status, args, pending work, result, failure with its stack, carryover, and the
task-failure count with its reason. A good detail page with no new API.

## Components

```
<tempo-app>            shell, hash router, owns the client
  <execution-list>     filter bar + paged table
    <status-badge>     running · stuck · failed · terminated
    <execution-row>
  <execution-detail>
    <pending-work>     what it is waiting on
    <history-timeline> seq-grouped, scheduled → completed pairs
      <history-event>  expandable payload
    <stack-trace>      collapsed frames
    <carryover-view>   the poller's cursor, made visible
    <action-bar>       signal · cancel · terminate, confirm-gated
  <json-view>          shared collapsible renderer
```

**A polling controller, not per-component timers.** One Lit
[reactive controller](https://lit.dev/docs/composition/controllers/) owning the
interval, backoff on error, pause when the tab is hidden, and abort on
disconnect. Every view reuses it, and the components stay dumb. This is the piece
most likely to be reinvented three times if it is not built first.

**The client is generated from the protocol types.** `WorkflowService` and
`ExecutionDetail` already exist; the dashboard imports them rather than restating
them. A field added to the projection shows up as a type error in the UI, which
is the advantage this project has over a generic tool.

## Risks

- **Auth.** Decision 2 is right for a trusted network and wrong everywhere else.
  If this ever needs to be reachable, auth comes before the UI, not after.
- **The transpile-on-request path** is the least conventional choice here. It is
  small and reversible, but it is where a reader will be most surprised.
- **Timestamps touch durability.** The field is optional and additive, but it is
  written to every event from then on, and the file store rewrites `meta.json`
  on a schedule that has not been sized for it.

## Not in scope

Metrics and aggregation over time, alerting, multi-server views, history search,
and anything requiring a query engine. Those want a real store behind them;
`listExecutions` over a `Map` is not it.

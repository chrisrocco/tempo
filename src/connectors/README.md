# Connectors

Internal services as workflow building blocks. Define a service wrapper once —
its reads, its writes, its events — and every surface a workflow builder needs
is derived from that one definition: a typed API for workflow code, worker
registration, a JSON-Schema catalogue for dashboards, and the obligations a
certification suite enforces against the live service.

**Status: experimental.** The programming model below is settled; the deferred
list at the bottom says what deliberately does not exist yet.

```ts
import * as Tempo from 'workflow-engine/workflow';
import {tracker} from '@yourapp/connectors/tracker';

const trk = tracker.use();

export const awaitResolution = Tempo.createWorkflow({
  key: 'awaitResolution',
  async run({incidentId, summary}: {incidentId: string; summary: string}) {
    const issue = await trk.command.createIssue({
      projectKey: 'OPS',
      summary,
      externalId: `incident/${incidentId}`, // survives any retry or replay
    });

    const resolved = trk.watch.issueTransitioned({
      every: '30 seconds',
      where: {issueKey: issue.key, to: 'resolved'},
    });
    await resolved.next(); // parks durably; wakes when the event arrives

    await trk.command.transitionIssue({issueKey: issue.key, to: 'closed'});
    return {issueKey: issue.key};
  },
});
```

No transport, no auth, no polling machinery, no retry logic, no dedupe — that
is the whole point. The workflow file contains business process only.

## Why

Connecting workflows to internal services is the hardest part of building a new
workflow, and the part where at-least-once execution quietly bites: **any side
effect an activity performs may happen twice.** Connectors exist to make that
safe and boring, three ways:

1. **One vocabulary.** Every operation on every connector is a query, a
   command, or a trigger — and the kind is not a label. It selects the retry
   policy, the idempotency obligations, the naming rules, and the tests the
   operation must pass. Learn three behaviors once; they hold everywhere.
2. **One definition.** Schemas, handlers, and metadata live in a single
   `defineConnector` value. Nothing is maintained twice, so nothing drifts.
3. **Certification, not trust.** Connectors are proven against the **live
   production service** — there are no sandbox environments to simulate — by a
   harness that provisions disposable test resources, double-fires commands,
   and replays trigger cursors. See [Testing](#testing-your-connector).

## The three words

| Kind        | Meaning                        | Naming                         | Contract                                                                                      |
| ----------- | ------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------- |
| **query**   | Reads state. No side effect.   | `get…`, `list…`, `search…`     | Safe to repeat; retried aggressively by default.                                              |
| **command** | Changes state.                 | Imperative verb: `createIssue` | Will eventually be delivered twice, so it is retried only because it is certified idempotent. |
| **trigger** | A fact that happened upstream. | Past tense: `issuePaid`        | Consumed in-workflow as a **watcher**: a poller child delivers each event to its parent once. |

The kind stays visible at every call site — `trk.query.getIssue`,
`trk.command.createIssue`, `trk.watch.issueTransitioned` — so effects are
readable in review and policy applies mechanically.

## Quickstart: your first connector

A connector is one folder with a fixed shape. The definition is the only file
with ideas in it:

```ts
// tracker/connector.ts
import {defineConnector, ops, t, ConnectorError} from 'workflow-engine/connectors';
import {createTrackerRpc} from './client'; // raw transport — the only file that knows the wire

const {query, command, trigger} = ops<{rpc: TrackerRpc}>();

const Status = t.enum('open', 'in_progress', 'resolved', 'closed');
const Issue = t.object({
  key: t.string({description: 'The issue key, e.g. OPS-1.'}),
  projectKey: t.string(),
  summary: t.string(),
  status: Status,
});

export const tracker = defineConnector({
  name: 'tracker',
  title: 'Tracker',
  description: 'Issues and transitions from the internal Tracker service.',

  // Resolved once per worker process; handlers never read process.env.
  config: t.object({TRACKER_RPC_URL: t.string(), TRACKER_RPC_TOKEN: t.string()}),
  context: (cfg) => ({rpc: createTrackerRpc(cfg)}),

  queries: {
    getIssue: query({
      description: 'Fetch one issue by key.',
      input: t.object({issueKey: t.string()}),
      output: Issue,
      handler: ({issueKey}, {rpc}) => rpc.issues.get(issueKey),
    }),
  },

  commands: {
    createIssue: command({
      description: 'Create an issue. Upserts on externalId: same id, same issue.',
      idempotency: 'natural',
      input: t.object({
        projectKey: t.string(),
        summary: t.string({minLength: 1}),
        externalId: t.string({minLength: 1}), // the business identity — required
      }),
      output: Issue,
      handler: (input, {rpc}) => rpc.issues.create(input),
    }),
  },

  triggers: {
    issueTransitioned: trigger({
      description: 'An issue changed status.',
      event: t.object({seq: t.integer(), issueKey: t.string(), to: Status}),
      eventId: (e) => e.seq, // stable and ordered — this is the cursor
      filter: t.object({issueKey: t.optional(t.string()), to: t.optional(Status)}),
      poll: ({cursor, filter}, {rpc}) =>
        rpc.events.list({after: cursor, type: 'issue.transitioned', ...filter}),
    }),
  },
});
```

Using it needs no wiring beyond an import: `tracker.use()` registers the
handlers and the watcher on whatever worker loads the workflow module — the
same declaring-is-registering contract as `proxyActivities`. For the explicit
paths (`createLocalRuntime`, a worker that lists everything it serves),
`tracker.registrations()` returns the activity and workflow maps to register by
hand.

## Concepts

### One definition, every surface

Everything is a projection of the `defineConnector` value:

| Surface           | What it is                                                                         |
| ----------------- | ---------------------------------------------------------------------------------- |
| `use()`           | The typed workflow proxy: `query.*`, `command.*`, `watch.*`. Registers by import.  |
| `direct()`        | The same handlers as plain bound calls, for composing inside one custom activity.  |
| `registrations()` | Explicit activity/workflow maps for the local runtime and list-everything workers. |
| `catalogue(...)`  | JSON Schema per operation, for a dashboard to render — Zapier-style.               |
| `planLiveSuite()` | The certification obligations the live harness enforces.                           |

### Schemas: `t`

Operation inputs, outputs, and events are authored with `t`, the repo's own
schema library (`src/libraries/schema/`). One definition does three jobs:
validates at runtime, renders to JSON Schema for the catalogue, and infers the
TypeScript types the proxy exposes. It is deliberately small — the catalogue
can only render what JSON Schema can say, so the vocabulary is exactly the
language of JSON-over-RPC shapes:

| Builder                  | Type               | Notes                                             |
| ------------------------ | ------------------ | ------------------------------------------------- |
| `t.string(opts?)`        | `string`           | `pattern`, `minLength`, `maxLength`, `format`     |
| `t.number` / `t.integer` | `number`           | `min`, `max`                                      |
| `t.boolean(opts?)`       | `boolean`          |                                                   |
| `t.literal(v)`           | that value         | renders as `const`                                |
| `t.enum('a', 'b', …)`    | `'a' \| 'b'`       | string unions                                     |
| `t.array(inner)`         | `Inner[]`          |                                                   |
| `t.object({…})`          | object             | `required` derived from presence; strips unknowns |
| `t.record(value)`        | `Record<string,…>` | renders as `additionalProperties`                 |
| `t.union(a, b, …)`       | `A \| B`           | first branch that validates wins                  |
| `t.nullable(inner)`      | `T \| null`        |                                                   |
| `t.optional(inner)`      | `T \| undefined`   | optional key; absent stays absent                 |
| `t.defaulted(inner, v)`  | `T`                | optional for callers, **present for handlers**    |
| `t.unknown()`            | `unknown`          | accepts anything; renders unconstrained           |

Three behaviors worth knowing:

- **`description` renders.** Every builder takes one, and the dashboard shows
  it as field help. Documentation is part of the schema, not beside it.
- **`t.defaulted` fills at parse.** The field is optional on the way in and
  guaranteed on the way out (`InferInput` vs `InferOutput` carry the
  difference), so handlers never write `input.limit ?? 20`.
- **Tolerant in production, strict in certification.** `t.object` strips
  unknown keys, so workflows survive a service adding a field. The live
  harness separately checks raw responses for undeclared keys
  (`strictProblems`), so drift turns a nightly test red instead of surprising
  a workflow.

Transforms, closure refinements, and coercion are deliberately absent: a shape
they would express is a shape no form can render. Beneath `t` sits a
one-interface validator port — invisible to authors, kept as the seam through
which an external schema vendor could return as an adapter if one ever earns
its place.

### Commands and idempotency

The engine delivers activities at least once, so **every command will
eventually run twice.** A command therefore declares how it survives that:

- **`idempotency: 'natural'`** — idempotent by shape. Three recurring stories:
  - _Delegation_: the service dedupes on a business identity the input carries
    (`externalId` on `createIssue` — and it is **required**, so no caller can
    opt out of the protection).
  - _Convergence_: the command's contract is an end state, not an action count.
    A retry landing after success sees `conflict`, checks whether the target
    state already holds, and reports success.
  - _Upsert/set/delete_: naturally repeatable.
- **`idempotency: 'unsafe'`** — no protection exists. The framework forces
  `maximumAttempts: 1`, the catalogue flags it, and a written `unsafeBecause`
  is required. Unsafe is legal but never silent — and the flags are the running
  inventory of what a future keyed mode would buy.

The live harness fires every natural command **twice with one identity** and
asserts a single effect. That test is what turns "at-least-once" from a caveat
into a guarantee.

### Triggers and watchers

`trk.watch.someTrigger(opts)` is the one trigger surface: it spawns a poller
child under a deterministic id, the child polls through a cursor and signals
the parent **once per event**, and the returned handle wraps the engine's
signal stream:

```ts
const resolved = trk.watch.issueTransitioned({
  every: '30 seconds',            // poll interval (ms or duration text)
  where: {to: 'resolved'},        // forwarded to poll, so the service filters
  start: 'new',                   // 'new' | 'all' | {cursor} — where to begin
});
const evt = await resolved.next(); // or: for await (const evt of resolved)
resolved.stop();                   // cancel the child (parent close also does)
```

Everything here is assembled from engine primitives (`pollForever`,
`signalWorkflow`, `signalStream`, parent-close policies) — "once per event"
falls out of engine guarantees, not new machinery. Two rules keep watchers
honest:

- **`eventId` is the cursor**, so it must be stable per event and strictly
  increasing in feed order. A service without an ordered event feed will fail
  delivery-truth certification on day one — that is the forcing function, and
  the ask to take to the service team.
- **A long-lived parent owns its history.** Each event is one signal in the
  parent's log; an unbounded stream pairs its watcher with `continueAsNew`,
  passing `{cursor}` forward as its `start`.

### Errors

Handlers map transport failures into one closed taxonomy; workflow authors
catch a single type, `ConnectorError`, with a `kind` to switch on:

| Kind          | Meaning                                 | Retried? |
| ------------- | --------------------------------------- | -------- |
| `invalid`     | Input failed validation / rejected      | no       |
| `notFound`    | The addressed resource does not exist   | no       |
| `conflict`    | The operation contradicts current state | no       |
| `denied`      | Authn/authz failure                     | no       |
| `unavailable` | Service unreachable right now           | **yes**  |
| `upstream`    | Service failed internally               | **yes**  |
| `drift`       | Response no longer matches the schema   | no       |

The engine's retry policy is attempts-and-backoff only, so the framework adds
the classification: a non-retryable error completes the activity with a
structured `{ok: false, error}` envelope (visible in history, renderable by a
dashboard) and is rethrown typed in workflow code; retryable errors throw
through to the server's policy.

### Config and context

A connector declares its config as a schema over the environment; `context()`
builds the authenticated client once per process; every handler receives it.
Handlers never read `process.env` — where credentials flow is answerable by
reading one function per connector.

### Retry defaults by kind

| Kind           | Retry                                                    | Timeout            |
| -------------- | -------------------------------------------------------- | ------------------ |
| query          | 5 attempts, 500ms initial, 2× backoff, 30s cap           | `startToClose` 30s |
| command        | 5 attempts — _only because certified idempotent_         | `startToClose` 2m  |
| unsafe command | forced to 1 attempt                                      | `startToClose` 2m  |
| trigger poll   | query policy; the watcher loop itself runs until stopped | `startToClose` 30s |

Overridable per operation (`options` on the def) and per `use()` call, in that
order — but defaults this considered are meant to go untouched.

### `direct()`: composing inside one activity

The pre-built proxy makes each operation its own activity. When several calls
belong in **one** activity — steps sharing a session, a chatty loop, huge
intermediates — `direct()` hands you the same certified handlers as plain
bound functions:

```ts
// an ordinary custom activity
const trk = tracker.direct();
export async function closeStale({projectKey}: {projectKey: string}) {
  const stale = await trk.query.searchIssues({projectKey, status: 'resolved'});
  for (const issue of stale) {
    await trk.command.transitionIssue({issueKey: issue.key, to: 'closed'});
  }
  return {closed: stale.length};
}
```

Idempotence composes: a sequence of `natural` steps is retry-safe as a unit.
One `unsafe` step makes the whole composite one-attempt. The trade is
granularity — one history event, no per-step recovery — so compose in the
workflow unless one of the three reasons above genuinely applies. And
`direct()` belongs in activities only: in workflow code it would be raw I/O
inside replay.

## Testing your connector

### The fast tier

Workflows using a connector run on `createLocalRuntime()` in milliseconds:
register `tracker.registrations()` plus your workflows, and drive the fake or
the fixture from the host side. `spec/connectors/connectors.spec.ts` is the
worked pattern, watcher path included.

### Live certification

There are no sandbox environments; connectors are proven **against the
production service**, using disposable, namespaced test resources. The harness
enforces four properties:

1. **Schema truth** — every live response matches its declared output and
   carries nothing undeclared.
2. **Retry safety** — every natural command, double-fired with one identity,
   produces exactly one effect.
3. **Delivery truth** — a caused event appears exactly once past the prior
   cursor, ids ordered and stable, and never again once the cursor advances.
4. **Replay safety** — outputs survive a JSON round-trip, because activity
   results live in history.

You write only what the harness cannot know — how to stage, cause, and observe:

```ts
const plan = planLiveSuite(tracker, trackerFixtures, (s) => {
  s.query('getIssue', async ({direct, fx, uniqueId}) => {
    const made = await direct.command.createIssue({
      projectKey: fx.projectKey, summary: 'schema truth', externalId: uniqueId('q'),
    });
    return {issueKey: made.key};
  });
  s.command('createIssue', {
    act: ({direct, fx, key}) => direct.command.createIssue({
      projectKey: fx.projectKey, summary: 'once', externalId: key, // same key, fired twice
    }),
    probe: async ({direct, fx, key}) => ({
      effects: (await direct.query.searchIssues({projectKey: fx.projectKey}))
        .filter((i) => i.externalId === key).length,
    }),
  });
  // s.trigger(...) — cause the event, say which one is yours
});
const failures = await runLivePlan(plan); // [] means certified
```

The `fixtures` module answers one question per connector — _what is your
disposable container?_ (a project, a test customer, a muted channel) — via
`provision(ns)` / `destroy(ns)` / `sweep(olderThanMs)`. The janitor `sweep`
runs before every suite because teardown will sometimes fail; leaks are
managed, not forbidden. A generated final case fails naming every uncertified
operation, so **the suite being green is the definition of done.** Run it on
connector PRs and nightly: the nightly is also your drift monitor — a service
team's breaking change turns a test red before it surprises a workflow.

## Authoring checklist

1. `client.ts` — raw transport; map HTTP/RPC failures into the error taxonomy.
   The only file that knows the wire.
2. `schemas.ts` — shapes with `t`, descriptions included.
3. `connector.ts` — every operation gets a kind, a description, and (commands)
   an idempotency story. Can't make it natural? Declare `unsafe` honestly and
   say why.
4. `fixtures.ts` — provision/destroy/sweep. If you cannot provision a
   namespaced, sweepable resource, stop and raise it: that is a design gap.
5. Live spec — one `s.query`/`s.command`/`s.trigger` per operation until
   `runLivePlan` returns no failures.

## Deferred, deliberately

- **Keyed idempotency** — a derived key for commands that are not naturally
  idempotent; today they ship as `unsafe`, and the flags are the backlog.
- **Trigger-starts-workflow** — a scheduler entrypoint dispatching a fresh
  workflow per event; watchers are the one trigger surface for now.
- **Push transport** — webhooks feeding watcher streams.
- **Golden persistence and `stub()`** — live-run recordings exist in-memory
  (`plan.recordings()`); the checked-in-goldens fast tier is not built yet.

Design history and rationale live in the Connector Contract RFC; the in-repo
ground truth is `spec/connectors/` — every claim above runs in CI.

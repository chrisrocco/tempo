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

Operation inputs, outputs, and events are authored with `t`, which one
definition makes do three jobs: validate at runtime, render to JSON Schema for
the catalogue, and infer the TypeScript types the proxy exposes.

`t` is not a connectors idea. It is a library of its own —
[`workflow-engine/schema`](../libraries/schema/index.ts) — published
separately and knowing nothing about this repo, so **the vocabulary, the three
behaviours to know before authoring, and what it deliberately cannot express
are all documented there**. Read that first; this section is only what
connectors add on top.

`workflow-engine/connectors` re-exports the schema surface, so a connector
author has one import root and does not need both paths.

Two things the connector runtime does with a schema that the library does not:

- **The catalogue is the reason the vocabulary is small.** A dashboard renders
  a form from the emitted JSON Schema, so an operation's input can only say
  what JSON Schema can say. That constraint is the library's, but this is where
  you feel it.
- **Tolerant in production, strict in certification.** `t.object` strips
  unknown keys, so a workflow survives a service adding a field. The live
  harness separately runs `strictProblems` over raw responses, so that same
  drift turns a nightly test red instead of surprising a workflow later.

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

Under the hood this is the engine's own `createWatcher` primitive
(`src/patterns/watcher.ts` holds the deterministic half and its guarantees) —
one watcher per trigger, declared at `use()` time. `createWatcher` in turn is
the composition of `pollForever`, `signalWorkflow`, and `signalStream`, so
"once per event" falls out of engine guarantees, not new machinery. Two rules
keep watchers honest:

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

## Deferred, deliberately

- **Keyed idempotency** — a derived key for commands that are not naturally
  idempotent; today they ship as `unsafe`, and the flags are the backlog.
- **Trigger-starts-workflow** — a scheduler entrypoint dispatching a fresh
  workflow per event; watchers are the one trigger surface for now.
- **Push transport** — webhooks feeding watcher streams.
- **Golden persistence and `stub()`** — live-run recordings exist in-memory
  (`plan.recordings()`); the checked-in-goldens fast tier is not built yet.

## Authoring a new connector

This section is the operating manual: follow it top to bottom and the result is
a connector indistinguishable in style from every existing one. It is written
to be executable by an agent — each step says what to do and how to know it is
done — and the consistency rules at the end are requirements, not suggestions.
**Definition of done: `runLivePlan` returns zero failures, and every rule below
holds.** Before writing anything, read one existing connector end to end —
new connectors are written by resemblance, not invention. The reference is
[`examples/github/`](examples/github/README.md), a complete real connector in
exactly the prescribed folder shape, with each of its operations chosen to
demonstrate one decision from this guide (an honest `unsafe`, both natural
idempotency stories, a real event-feed trigger).

### The folder

One directory per connector, named after the service, lowercase, singular.
The file set is fixed; every connector has exactly these files, so "where does
X go" always has one answer:

```
connectors/
  registry.ts              every connector, by name — feeds the catalogue
  tracker/
    connector.ts           the definition — the only file with ideas in it
    client.ts              raw transport; the only file that knows the wire
    schemas.ts             t shapes shared by operations and tests
    fixtures.ts            provision/destroy/sweep for live certification
    tracker.live.spec.ts   the certification registrations
    README.md              service owner, quirks, fixture notes (short)
```

### Step 1 — Scout the service

Before any code, answer two questions about the service; the answers decide
what kind of connector is even possible.

1. **Do creates have a dedupe identity?** An `externalId`-style field the
   service upserts on. Without it, creation commands cannot be `'natural'` and
   must ship `'unsafe'` (one attempt). If missing, file the ask with the
   service team now — it is the single highest-value change they can make.
2. **Is there an ordered event feed?** Events with a stable, strictly
   increasing id. Without it there are no trustworthy triggers. Same ask.

Also collect: base URL and auth env vars, the operations workflows actually
need (start narrow — operations are cheap to add, expensive to remove), and
what disposable container the service offers for test fixtures.

**Done when:** you can name the dedupe identity (or its absence), the event
feed (or its absence), and the fixture container.

### Step 2 — `client.ts`

Raw transport only: base URL and auth from the config object (never
`process.env`), one function per wire call, and the single mapping from
transport failures to the error taxonomy. No schemas, no validation, no retry,
no sleep — the engine owns retry, and validation belongs to the definition.

```ts
// The whole error policy of the connector, in one place:
// 400 invalid · 401/403 denied · 404 notFound · 409 conflict
// 429/503 unavailable · other 5xx upstream
function mapError(status: number, body: string): ConnectorError { … }
```

**Done when:** every exported function either returns parsed JSON or throws a
`ConnectorError`, and no other file in the folder mentions a status code.

### Step 3 — `schemas.ts`

Shapes with `t`, exported for reuse by the definition and the tests. Rules
that keep schemas consistent everywhere:

- **`description` on every object field** — the dashboard renders it as field
  help. Sentence case, ends with a period, says what a human filling a form
  needs (`'The issue key, e.g. OPS-1.'`), not what the code does.
- **JSON-safe outputs only.** Timestamps are ISO strings
  (`t.string({format: 'date-time'})`), never `Date`s — outputs live in
  workflow history and are replayed. The harness's round-trip check enforces
  this; write it correctly the first time.
- **Model what workflows read, not everything the service returns.** `t.object`
  strips undeclared keys, so omitting a field is safe; declaring one you don't
  need is maintenance.
- Reuse shapes — a `Status` enum declared once, imported everywhere. Never
  redeclare a shape inline that `schemas.ts` already exports.

**Done when:** the definition and the live spec import every shape from here.

### Step 4 — `connector.ts`

One `defineConnector` value, groups in this order: `config`/`context`, then
`queries`, `commands`, `triggers`. Get `ops<Ctx>()` at the top so handlers
infer a typed context. Then one operation at a time:

**For every operation:** a `description` (one sentence, present tense, says
what it does and any contract worth knowing: `'Create an issue. Upserts on
externalId: same id, same issue.'`), an `input`/`output` from `schemas.ts` or
inline `t`, and a handler that is **thin** — one client call, plus only the
logic its idempotency story requires.

**Choosing the kind:** reads state with no observable side effect → query
(name `get…`/`list…`/`search…`/`count…`; list queries take a bounded
`limit: t.defaulted(t.integer({min: 1, max: N}), d)` — results ride history).
Changes state → command (imperative verb). A fact to react to → trigger
(past-tense event name).

**For every command, pick its idempotency story — in this order:**

1. **Delegation**: the service dedupes on an identity the input carries. Make
   that field **required** in the input schema so no caller can opt out, and
   say so in the description.
2. **Convergence**: the contract is an end state. Catch `conflict`, check
   whether the target state already holds, return success if it does:
   ```ts
   try {
     return await rpc.issues.transition(issueKey, to);
   } catch (e) {
     if (e instanceof ConnectorError && e.kind === 'conflict') {
       const issue = await rpc.issues.get(issueKey);
       if (issue.status === to) return issue; // a retry after success
     }
     throw e;
   }
   ```
   (Converge on the conflict — never check-then-act up front; that races.)
3. **Naturally repeatable**: upsert, set, delete, cancel.
4. **None of the above** → `idempotency: 'unsafe'` with an `unsafeBecause`
   naming the consequence and the fix
   (`'Comments have no identity; a retry would post a duplicate.'`). Unsafe is
   honest, never a workaround to avoid thinking.

**For every trigger:** `eventId` must be stable per event and strictly
increasing in feed order — it is the cursor. Give it a `filter` schema of
optional fields the service can apply server-side. If the feed cannot provide
an ordered id, do not ship the trigger; file the ask instead.

**Done when:** the file typechecks, every operation has a kind, a description,
and (commands) an idempotency declaration.

### Step 5 — `fixtures.ts`

Answer the connector's one testing question — _what is your disposable
container?_ — and implement the three-function protocol:

- `provision(ns)`: create the container, tagged with a sweepable marker that
  embeds `ns` (label, name prefix — whatever the service can filter by later).
- `destroy(ns)`: remove it. Best effort; failures here are expected sometimes.
- `sweep(olderThanMs)`: find and remove leaked containers older than the
  cutoff **by the marker**. This is the guarantee; `destroy` is the polite
  case.

**If the service offers no provisionable, sweepable container, stop and raise
it** — that is a design gap to resolve with the service team, not a testing
chore to work around.

**Done when:** two suite runs can execute concurrently against production
without touching each other's resources.

### Step 6 — the live spec

`planLiveSuite(connector, fixtures, (s) => {…})` with one registration per
operation: `s.query` for every query (stage the world, return the input),
`s.command` for every **natural** command (`act` uses `ctx.key` as the
business identity — the harness fires it twice; `probe` counts effects
attributable to that key and must find exactly 1), `s.trigger` for every
trigger (`cause` the event via commands, `expect` says which event is yours).
Do **not** write a double-fire for unsafe commands — the harness refuses it;
their flag is their certification. Mint every identity from `ctx.uniqueId()`
or `ctx.key`, and touch only resources under `fx` — never fixed production
ids.

Run `runLivePlan` until it returns `[]`. The generated coverage case fails
naming anything you skipped, so there is no silent partial credit.

**Done when:** zero failures, from a clean environment, twice in a row.

### Step 7 — register and review

Add the connector to `registry.ts`, then render `catalogue([…])` and read it
as a user: every operation listed, descriptions that make sense in a form,
unsafe commands flagged with reasons you would accept from someone else.
Finish the folder's `README.md`: the owning team, auth env vars, the fixture
container, and any service quirks the next author needs.

### Consistency rules

The invariants reviewers hold every connector to. When an existing connector
and this list disagree, this list wins — fix the connector.

- **Naming.** Folder and connector `name`: the service, lowercase, singular.
  Operations: `camelCase`; queries prefixed `get`/`list`/`search`/`count`;
  commands start with an imperative verb; triggers are past-tense facts
  (`issueTransitioned`, never `onIssueTransition`).
- **One wire, one file.** Only `client.ts` imports transport or knows a status
  code. Only `context()` sees config values. `process.env` appears nowhere.
- **Handlers are thin.** One client call plus idempotency logic. No retries,
  no sleeps, no logging, no cross-connector imports — composition happens in
  workflows, or in a custom activity via `direct()`.
- **Errors speak the taxonomy.** Only `ConnectorError`, only the seven kinds,
  mapped in `client.ts`. Never catch-and-swallow in a handler except the
  convergence pattern.
- **Every description is written for the dashboard**, not for the code review.
- **Defaults are the norm.** Override per-operation `options` only with a
  comment saying why; an override without a reason is a bug.
- **Size.** `connector.ts` past ~400 lines splits into `operations/*.ts`, one
  definition per file, composed in `connector.ts` — nothing else moves.
- **Tests touch only what they minted.** Identities come from
  `ctx.uniqueId()`/`ctx.key`; targets live under `fx`; fixtures are sweepable
  by marker or they do not pass review.

---

Design history and rationale live in the Connector Contract RFC; the in-repo
ground truth is `spec/connectors/` — every claim above runs in CI.

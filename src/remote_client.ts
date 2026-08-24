/**
 * @fileoverview
 * ★ CLIENT ENTRYPOINT — reaching a running server from outside it, and the
 * guide for building a dashboard on top of it.
 *
 * Safe to import from anywhere: a dashboard, a CLI, a desktop app, a browser.
 * Nothing reachable from here opens a port, touches a filesystem, evaluates
 * workflow code, or registers an activity as an import side effect. It is
 * `fetch` and pure data, and that is the whole of it.
 *
 * ```ts
 * import {createRemoteClient, createRemoteService} from 'workflow-engine/client';
 * const client = createRemoteClient(createRemoteService('/api'));
 * ```
 *
 * # Building a dashboard
 *
 * ## Three import paths, and a reason to stop there
 *
 * | Path | What it is for |
 * | --- | --- |
 * | `workflow-engine/client` | talking to the engine — this file |
 * | `workflow-engine/protocol` | the wire types, and the predicates that read them |
 * | `workflow-engine/sandbox` | a whole engine inside the page, for demos, local development and tests |
 *
 * All three are browser-safe, and the first two are checked to stay that way
 * (`BROWSER_SAFE_ENTRYPOINTS` in `tools/boundaries.ts`). A fourth import is the
 * moment to stop: everything else on the `exports` map is a host concern, and
 * reaching for one pulls `node:http` or `node:fs` into the bundle. The symptom
 * is a build error, but the cause is a layering mistake — whatever was wanted
 * is either derivable from a read below, or it is the server's job.
 *
 * ## The reads, and the question each one answers
 *
 * | Call | Answers |
 * | --- | --- |
 * | `list(filter)` | one page of executions, newest first |
 * | `getHandle(id).describe()` | one execution — history, pending work, parked conditions |
 * | `queues()` | which queues are polled, per role, and by whom |
 * | `counts()` | every execution counted by status, grouped by queue and name |
 * | `workflows()` | what the fleet says it can run |
 *
 * Give `list` the filter rather than narrowing a page after it arrives: the
 * page cap (`MAX_PAGE_SIZE`) means a filter applied here reports on one page
 * while looking like it reported on the server.
 *
 * `queues()` is the read that does not come from history, and the one a
 * dashboard most often leaves out. An execution waiting on an activity looks
 * identical whether a worker is about to claim it or nothing has ever polled
 * its queue — and the second is a deployment mistake that every other read
 * here renders as a healthy pause. `isStuck`, `isQueueServed`, `isNameServed`
 * and `workersServing` are exported from `workflow-engine/protocol` so that a
 * UI does not re-derive that judgement and end up using the word "stuck" to
 * mean something the engine does not.
 *
 * ## The writes do not report back
 *
 * `signal`, `cancel`, `terminate` and `reset` return `void`; the service
 * reports their failures later or not at all. A UI that renders "sent" on
 * return is therefore claiming something nothing told it. What it can honestly
 * do is read again and show the effect — the signal landing in history, the
 * condition unparking — and treat `health()` rejecting as the answer to "is
 * anything there at all". `reset` is destructive, and its `keep` is an index
 * into the history from `describe()`, so an operator surface for it should name
 * what is about to be dropped.
 *
 * ## One build, two modes: the transport seam
 *
 * `createRemoteService` takes an optional `transport`, and that is the whole
 * difference between a dashboard talking to a deployed server and the same
 * dashboard hosting its own engine:
 *
 * ```ts
 * const service = sandbox
 *   ? createRemoteService('sandbox', {transport: (request) => call(request)})
 *   : createRemoteService('/api');
 * const client = createRemoteClient(service);
 * ```
 *
 * Everything above that line — every component, every view model, every read
 * described here — is identical in both modes, because both answer the same
 * `RpcRequest` through the same dispatch switch. That is the property to
 * protect when adding to a dashboard: a feature that works in only one mode has
 * reached past the seam.
 *
 * ## Sandbox mode, on the dashboard's side
 *
 * Run the engine in a **Web Worker**. Its loops poll continuously, which on the
 * main thread is a page that never idles.
 *
 * ```ts
 * // engine.worker.ts — the whole engine, off the main thread
 * import {installSetImmediate} from 'workflow-engine/sandbox/shims/microtask';
 * import {createSandbox, type RpcRequest} from 'workflow-engine/sandbox';
 *
 * installSetImmediate();
 * const sandbox = await createSandbox([], {
 *   onScenario: (name, index, total) => postMessage({seeding: {name, index, total}}),
 * });
 * self.onmessage = async (event) => {
 *   const {id, request} = event.data as {id: number; request: RpcRequest};
 *   postMessage({id, result: await sandbox.dispatch(request)});
 * };
 * ```
 *
 * The page's `transport` is then a `postMessage` that resolves when the reply
 * carrying its id arrives — the same shape as the `fetch` it stands in for,
 * which is why nothing above it changes.
 *
 * Seed *after* starting rather than as an argument to `createSandbox`. Seeding
 * is the slow part — several scenarios wait on real state to appear — so a page
 * that seeds up front shows a spinner for as long as the slowest fixture takes,
 * while `createSandbox([])` answers reads in milliseconds. Call
 * `sandbox.seed([...])` behind an already-interactive page and report progress
 * from `onScenario`, which fires as each scenario *begins*: the name a reader
 * wants is the one being worked on, not the one just finished.
 *
 * The bundler's side of this — the five `node:` specifiers to alias, the shims
 * that replace them, and the concurrency constraint the `async_hooks` one
 * carries — is documented where it lives, in
 * [`src/sandbox/index.ts`](sandbox/index.ts). Read that before trusting a
 * sandbox with anything, and use the shipped shims rather than writing your own.
 *
 * ## Vocabulary the engine stores but does not interpret
 *
 * A parked condition may carry `awaiting`, and the engine treats it as opaque
 * JSON: it stores it, ships it on `ParkedCondition` and `conditionParked`, caps
 * it at `MAX_AWAITING_BYTES`, and never reads a field of it. The conventions
 * live with the helpers that write them — `patterns/approval.ts` writes
 * `{kind: 'approval', signal, detail}` — so a dashboard rendering approval
 * buttons is honouring a convention, not reading a contract.
 *
 * Two consequences for a UI. It has to recognise the shape defensively, because
 * `awaiting` is equally allowed to be a workflow's own private object. And it
 * should take the signal name off the parked state rather than hardcoding one,
 * which is what lets the same panel answer a workflow this dashboard has never
 * heard of.
 *
 * ## Checking a dashboard's view models against a real engine
 *
 * `createSandbox` runs in a test process as readily as in a page, so the view
 * models — which history events become spans, which mark belongs to which span,
 * what a rolled-over run looks like — can be checked against histories the
 * engine actually wrote:
 *
 * ```ts
 * const sandbox = await createSandbox(['bugfix-agent'], {timeoutMs: 60_000});
 * const detail = await sandbox.dispatch({
 *   method: 'describeExecution',
 *   workflowId: 'scenario-bugfix-agent',
 *   options: {},
 * });
 * ```
 *
 * Worth the setup cost rather than writing fixtures, for a specific reason: a
 * fixture records what its author believed the engine emits, so a view model
 * checked against one is checked against that belief twice. The scenario
 * catalogue (`describeScenarios`) is closed on the same principle — a state it
 * cannot produce is a state no dashboard should claim to render.
 *
 * ## Do not point a browser straight at the RPC
 *
 * The RPC has no auth and no TLS, so anything that can reach the port can
 * terminate any execution. A UI has users and sessions, and therefore needs a
 * server of its own in the middle holding both. That topology, and why there is
 * deliberately no CORS to make skipping it easy, is in
 * [`README.md`](../README.md#put-your-own-server-in-front-of-a-dashboard).
 *
 * # Why this entrypoint exists when `workflow-engine` already exported all of it
 *
 * It did, and that was the problem. `createRemoteService` was reachable only
 * through the host entrypoint (`src/index.ts`), which also exports `startServer`,
 * `FileHistoryStore` and `createRpcServer` — so a bundler following the import
 * graph pulled `node:fs` and `node:http` into a browser build in order to hand it
 * a function that calls `fetch`. The code was always browser-safe; the *barrel*
 * was not.
 *
 * This is the second time that has happened. `schedule/index.ts` was split from
 * `schedule/worker.ts` for exactly the same reason — *"a dashboard importing
 * `createScheduleClient` also got the workflow runtime"* — and the fix is the same
 * one: put the safe half on its own path and leave the dangerous half unreachable
 * from it. What is new is that it is now **checked** rather than re-argued. See
 * `BROWSER_SAFE_ENTRYPOINTS` in `tools/boundaries.ts`, which walks the value-import
 * graph from this file and fails on the first `node:` specifier it reaches.
 *
 * ## Why it is not `src/client.ts`
 *
 * Because `src/client/` already exists, and `./client` would then resolve to this
 * file rather than to that directory's `index.ts` — silently rebinding every
 * existing internal import of `'./client'`, including the one in `src/index.ts`.
 * A top-level entrypoint file is the right shape (`workflow.ts`, `activity.ts`,
 * `tempo.ts` are all this shape); the name just has to not collide. The published
 * path is still `workflow-engine/client`, which is what a consumer types.
 *
 * ## Why it is not inside `client/`
 *
 * `tools/boundaries.ts` declares `client: ['protocol', 'core']`, so a file in that
 * layer may not import `services/` — and `createRemoteService` lives there because
 * workers use it too. Composing across layers is what entrypoints are for, and
 * they sit at the top level where the layering rules deliberately do not apply.
 *
 * ## What is deliberately absent
 *
 * No `startServer`, no `FileHistoryStore`, no `createLocalRuntime`, no
 * `startWorker`. Those are host concerns and they stay on `workflow-engine`.
 * A consumer that needs both — a dashboard's own server process, say — imports
 * both paths; nothing stops it, and the split costs it one extra import line.
 *
 * The wire types and the shared predicates (`isStuck`, `isQueueServed`,
 * `isNameServed`, `workersServing`) are **not** re-exported here. They live on
 * `workflow-engine/protocol`, which is already dependency-free and browser-safe,
 * and duplicating the surface would give the same symbol two import paths.
 */

export {
  createClient,
  createRemoteClient,
  type Client,
  type RemoteClient,
  type WorkflowHandle,
} from './client/client';

// Imported from the module rather than from `services/index.ts`: that barrel also
// re-exports `rpc_server`, which imports `node:http`, and a barrel is followed
// whole by a bundler however little of it is used. This deep path is the entire
// mechanism by which this entrypoint stays browser-safe.
export {
  createRemoteService,
  type RemoteServiceOptions,
  type RemoteWorkflowService,
} from './services/remote_service';

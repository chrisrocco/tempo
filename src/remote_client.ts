/**
 * @fileoverview
 * ★ CLIENT ENTRYPOINT — reaching a running server from outside it.
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
 * ## Why this exists when `workflow-engine` already exported all of it
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
 * `Tempo.startWorker`. Those are host concerns and they stay on `workflow-engine`.
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

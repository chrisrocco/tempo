/**
 * @fileoverview
 * ★ SANDBOX ENTRYPOINT — the whole engine, hosted wherever the caller is,
 * reached without a socket.
 *
 * ```ts
 * import {createSandbox} from 'workflow-engine/sandbox';
 *
 * const sandbox = await createSandbox(['bugfix-agent', 'schedules']);
 * const detail = await sandbox.dispatch({
 *   method: 'describeExecution',
 *   workflowId: 'scenario-bugfix-agent',
 *   options: {},
 * });
 * ```
 *
 * ## What this is for
 *
 * `startScenario` is the same fixture behind an HTTP port, which is right for a
 * consumer's test process and wrong for a browser: there is no socket to bind,
 * and a public sandbox that *did* bind one would be handing the internet an
 * unauthenticated engine (see `rpc_server.ts`, which says never to do that).
 * This composes the identical harness — same server core, same worker loops,
 * same seeded states — and exposes the one thing a caller actually needs: a
 * `dispatch` that takes an `RpcRequest` and answers it.
 *
 * A page hosting this in a Web Worker gets an engine per visitor with no
 * backend at all: nothing to isolate, no session broker, no port to protect,
 * and "reset the sandbox" is a reload.
 *
 * ## The workers still talk over the service seam
 *
 * The loops poll `createRemoteService(url, {transport})` rather than reaching
 * into the host, so the fleet is real: workers named, manifests reported,
 * queues polled, leases taken. That is what keeps a catalogue view and a fleet
 * view honest here rather than empty. Only the wire is different, and the wire
 * is the one thing a dashboard should not be able to tell apart.
 *
 * ## Four Node builtins to alias
 *
 * This entrypoint is **not** on `BROWSER_SAFE_ENTRYPOINTS`, and the claim it
 * cannot make is worth stating plainly rather than hiding. Reaching the engine
 * pulls four builtins, none of them load-bearing in a single-visitor sandbox:
 *
 * - **`node:async_hooks`** (`core/context.ts`, `worker/activity_context.ts`) —
 *   carries workflow context across `await`. A shim that keeps one current
 *   store is correct **only while one replay runs at a time**, which is what
 *   the local drain loop does. Shipping that shim into a real worker, where
 *   two executions interleave, silently mixes their contexts.
 * - **`setImmediate`** (`core/microtask_scheduler.ts`) — use a `MessageChannel`
 *   polyfill, not `setTimeout(0)`: `settle` runs once per history event and
 *   timeouts clamp to 4ms, which turns a long replay into a visible stall.
 * - **`node:crypto`** (`worker/workflow_reporter.ts`) — a manifest digest,
 *   compared for equality and nothing else. Any stable hash does.
 * - **`node:os`** (`worker/worker_loops.ts`) — a hostname, for a worker's
 *   display identity.
 *
 * Nothing here reaches `node:http` or `node:fs`: the history store is in
 * memory, and the transport is a function call.
 */

import {
  createRemoteService,
  createServerHost,
  dispatch,
  type ServerHost,
} from './services';
import {startHarnessOn, type HarnessOptions} from './testing/harness';
import type {
  RemoteWorkflowService,
  RpcRequest,
  ServerEndpoint,
} from './protocol';
import type {ScenarioName} from './testing/scenarios';

export {
  describeScenarios,
  SCENARIO_IDS,
  SCENARIO_WORKFLOWS,
  type ScenarioName,
} from './testing/scenarios';
export {SCENARIO_QUEUE, UNSERVED_QUEUE} from './testing/harness';
export type {RpcRequest, RpcResponse} from './protocol';

/** A running in-process engine, seeded and answering. */
export interface Sandbox {
  /**
   * Answer one `RpcRequest` — the same switch the HTTP server dispatches
   * through, so a caller's client code is identical either way.
   */
  dispatch(request: RpcRequest): Promise<unknown>;
  /** The queue the sandbox's workers serve. */
  readonly taskQueue: string;
  /** Stop the workers. The history goes with the process. */
  stop(): Promise<void>;
}

export interface SandboxOptions extends HarnessOptions {
  /**
   * What `health()` reports as this server's address. There is no socket, so
   * this is a label rather than somewhere to dial — but a dashboard reads it,
   * and leaving it empty sends one down its "cannot find the server" path,
   * which is a state no deployment produces.
   */
  endpoint?: ServerEndpoint;
}

/**
 * Build an engine, seed it with the named scenarios, and resolve once every one
 * of them is observable — the browser's `startScenario`.
 */
export async function createSandbox(
  scenarios: readonly ScenarioName[] = [],
  options: SandboxOptions = {},
): Promise<Sandbox> {
  const endpoint: ServerEndpoint = options.endpoint ?? {
    host: 'sandbox',
    port: 0,
    hostname: 'sandbox',
  };
  const host: ServerHost = createServerHost(undefined, {
    endpoint: () => endpoint,
  });

  const call = (request: RpcRequest): Promise<unknown> =>
    dispatch(host, request);
  // The URL is a label here — `transport` is what actually carries a request —
  // but it is what `health()` and anything reporting the server's address read.
  const service: RemoteWorkflowService = createRemoteService(
    `sandbox://${endpoint.hostname}`,
    {transport: call},
  );

  const harness = await startHarnessOn(service, scenarios, options);

  return {
    dispatch: call,
    taskQueue: harness.taskQueue,
    stop: () => harness.stop(),
  };
}

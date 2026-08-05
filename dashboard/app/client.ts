/**
 * @fileoverview
 * The dashboard's side of the RPC — the same one-endpoint protocol the CLI
 * speaks, from the browser.
 *
 * It is deliberately not a copy of `services/remote_service.ts`. That client is
 * written for a worker: it polls, it retries, it keeps a status cache, and none
 * of that is wanted here. What both share is the *protocol*, and the types for
 * it are imported from `src/protocol` rather than restated — so a field added to
 * `ExecutionDetail` shows up in the dashboard as a type error rather than as
 * `undefined` at runtime.
 *
 * Same-origin by construction: the page is served from `/ui` by the server it
 * calls, so the endpoint is `/` on whatever host loaded the page. There is no
 * base URL to configure and no CORS to arrange, which was the reason for
 * serving the two from one listener.
 */

import type {
  DescribeOptions,
  ExecutionDetail,
  ExecutionFilter,
  ExecutionGroups,
  ExecutionPage,
  QueueWorkers,
  StartWorkflowOptions,
} from 'workflow-engine/protocol';

/** The RPC envelope: every response is one of these two shapes. */
type RpcResponse = {ok: true; value: unknown} | {ok: false; error: string};

/**
 * One round trip.
 *
 * A server-side failure comes back as `{ok: false}` with HTTP 200 — the
 * transport succeeded, the call did not — so both that and a genuine network
 * error are turned into a thrown Error here. A caller should not have to know
 * which layer disappointed it.
 *
 * The optional `signal` is what makes `Poller`'s cancellation real: without it
 * an aborted poll still runs to completion on the server and still occupies a
 * connection, and only its *result* is discarded.
 */
async function call<T>(body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`server returned ${response.status}`);
  const envelope = (await response.json()) as RpcResponse;
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.value as T;
}

export const client = {
  listExecutions(
    filter: ExecutionFilter = {},
    signal?: AbortSignal,
  ): Promise<ExecutionPage> {
    return call<ExecutionPage>({method: 'listExecutions', filter}, signal);
  },

  /** Which task queues are being polled — see `isQueueServed`. */
  listQueues(signal?: AbortSignal): Promise<QueueWorkers[]> {
    return call<QueueWorkers[]>({method: 'listQueues'}, signal);
  },

  /**
   * Counts by status, grouped. Server-side because a client tallying a capped
   * page would be reporting on the page rather than on the server.
   */
  groupExecutions(signal?: AbortSignal): Promise<ExecutionGroups> {
    return call<ExecutionGroups>({method: 'groupExecutions'}, signal);
  },

  /** `null` rather than undefined on the wire — an unknown id, not an error. */
  async describeExecution(
    workflowId: string,
    options: DescribeOptions = {},
    signal?: AbortSignal,
  ): Promise<ExecutionDetail | undefined> {
    return (
      (await call<ExecutionDetail | null>(
        {method: 'describeExecution', workflowId, options},
        signal,
      )) ?? undefined
    );
  },

  start(
    name: string,
    args: unknown[] = [],
    opts: StartWorkflowOptions = {},
  ): Promise<{workflowId: string}> {
    return call<{workflowId: string}>({method: 'start', name, args, opts});
  },

  signal(workflowId: string, signalName: string, payload?: unknown) {
    return call<null>({method: 'signal', workflowId, signalName, payload});
  },

  cancel(workflowId: string): Promise<null> {
    return call<null>({method: 'cancel', workflowId});
  },

  terminate(workflowId: string, reason: string): Promise<null> {
    return call<null>({method: 'terminate', workflowId, reason});
  },

  /**
   * Drop every event from `keep` onward and replay from there. Destructive: the
   * dropped events do not come back.
   */
  reset(workflowId: string, keep: number): Promise<null> {
    return call<null>({method: 'reset', workflowId, keep});
  },
};

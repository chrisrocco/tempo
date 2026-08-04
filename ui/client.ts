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
  ExecutionDetail,
  ExecutionSummary,
  StartWorkflowOptions,
} from '../src/protocol/service';

/** The RPC envelope: every response is one of these two shapes. */
type RpcResponse = {ok: true; value: unknown} | {ok: false; error: string};

/**
 * One round trip.
 *
 * A server-side failure comes back as `{ok: false}` with HTTP 200 — the
 * transport succeeded, the call did not — so both that and a genuine network
 * error are turned into a thrown Error here. A caller should not have to know
 * which layer disappointed it.
 */
async function call<T>(body: unknown): Promise<T> {
  const response = await fetch('/', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`server returned ${response.status}`);
  const envelope = (await response.json()) as RpcResponse;
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.value as T;
}

export const client = {
  listExecutions(): Promise<ExecutionSummary[]> {
    return call<ExecutionSummary[]>({method: 'listExecutions'});
  },

  /** `null` rather than undefined on the wire — an unknown id, not an error. */
  async describeExecution(
    workflowId: string,
  ): Promise<ExecutionDetail | undefined> {
    return (
      (await call<ExecutionDetail | null>({
        method: 'describeExecution',
        workflowId,
      })) ?? undefined
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
};

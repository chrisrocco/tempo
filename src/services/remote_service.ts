/**
 * @fileoverview
 * The networked WorkflowService: an HTTP+JSON client to a server host. Workers
 * poll it (pollWorkflowTask/pollActivityTask over the wire); clients start + await
 * results through it. `bin/*-worker-main` and networked clients use this.
 *
 * The client-facing sync methods can't block on a round trip, so writes are fire-
 * and-forget (errors surface via getResult) and getStatus returns a cached value;
 * getResult is the authoritative await — it polls `getOutcome` until terminal.
 *
 * Unlike `LocalService` this path is **at-least-once**: a crashed worker's leased
 * task redelivers, so an activity's side effect can run more than once. Activities
 * driven through here must be idempotent (use an idempotency key). The seam is the
 * same; the failure semantics are not.
 */

import type {
  ActivityResult,
  ExecutionDetail,
  ExecutionStatus,
  ExecutionSummary,
  LeasedActivityTask,
  RpcRequest,
  RpcResponse,
  StartWorkflowOptions,
  TaskToken,
  WorkflowOutcome,
  WorkflowService,
  WorkflowTask,
  WorkflowTaskResult,
} from '../protocol';

// Ref'd on purpose: when a standalone client is awaiting getResult, this poll
// backoff is often the only thing keeping the process alive — an unref'd timer
// would let the process exit mid-poll (an unsettled top-level await, exit code 13).
function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface RemoteServiceOptions {
  /** How often getResult/pollers back off when there's nothing yet. */
  pollIntervalMs?: number;
}

export function createRemoteService(
  baseUrl: string,
  options: RemoteServiceOptions = {},
): WorkflowService {
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  const statusCache = new Map<string, ExecutionStatus>();
  let idCounter = 0;

  async function call(request: RpcRequest): Promise<unknown> {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const response = (await res.json()) as RpcResponse;
    if (!response.ok) throw new Error(response.error);
    return response.value;
  }

  return {
    start(name, args = [], opts = {}) {
      // Generate the id client-side so the handle is usable before the round trip lands.
      const workflowId = opts.workflowId ?? `wf-${Date.now()}-${++idCounter}`;
      statusCache.set(workflowId, 'running');
      void call({ method: 'start', name, args, opts: { workflowId } }).catch(
        () => {},
      );
      return { workflowId };
    },
    signal(workflowId, signalName, payload) {
      void call({ method: 'signal', workflowId, signalName, payload }).catch(
        () => {},
      );
    },
    cancel(workflowId) {
      void call({ method: 'cancel', workflowId }).catch(() => {});
    },
    terminate(workflowId, reason) {
      void call({ method: 'terminate', workflowId, reason }).catch(() => {});
    },
    getStatus(workflowId): ExecutionStatus {
      return statusCache.get(workflowId) ?? 'running';
    },
    async getResult(workflowId) {
      while (true) {
        const outcome = (await call({
          method: 'getOutcome',
          workflowId,
        })) as WorkflowOutcome;
        statusCache.set(workflowId, outcome.status);
        if (outcome.status === 'completed') return outcome.result;
        // Any non-running status is terminal and must break the loop. Testing for
        // 'failed' alone would poll a terminated execution forever, since nothing
        // will ever move it to a status this knows about.
        if (outcome.status !== 'running')
          throw new Error(outcome.failure ?? `workflow ${outcome.status}`);
        await sleep(pollIntervalMs);
      }
    },
    async describeExecution(
      workflowId: string,
    ): Promise<ExecutionDetail | undefined> {
      return (
        ((await call({
          method: 'describeExecution',
          workflowId,
        })) as ExecutionDetail | null) ?? undefined
      );
    },
    async listExecutions(): Promise<ExecutionSummary[]> {
      return (await call({ method: 'listExecutions' })) as ExecutionSummary[];
    },
    async pollWorkflowTask(): Promise<WorkflowTask | undefined> {
      return (
        ((await call({ method: 'pollWorkflowTask' })) as WorkflowTask | null) ??
        undefined
      );
    },
    async completeWorkflowTask(
      token: TaskToken,
      result: WorkflowTaskResult,
    ): Promise<void> {
      // An Error does not survive JSON — `JSON.stringify(new Error('x'))` is
      // `{}`, so the client would see "[object Object]" instead of the reason a
      // workflow failed. Flatten it to its message here, at the wire boundary,
      // rather than in the worker: LocalService hands the failure over in-process
      // and callers there expect the original Error.
      await call({
        method: 'completeWorkflowTask',
        token,
        result: result.failed
          ? { ...result, failure: errorMessage(result.failure) }
          : result,
      });
    },
    async failWorkflowTask(token: TaskToken, reason: string): Promise<void> {
      await call({ method: 'failWorkflowTask', token, reason });
    },
    async pollActivityTask(): Promise<LeasedActivityTask | undefined> {
      return (
        ((await call({
          method: 'pollActivityTask',
        })) as LeasedActivityTask | null) ?? undefined
      );
    },
    async completeActivityTask(
      token: TaskToken,
      result: ActivityResult,
    ): Promise<void> {
      await call({ method: 'completeActivityTask', token, result });
    },
  };
}

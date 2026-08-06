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
  DescribeOptions,
  ExecutionDetail,
  ExecutionFilter,
  ExecutionGroups,
  ExecutionPage,
  QueueWorkers,
  ServerHealth,
  ExecutionStatus,
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

/**
 * A `WorkflowService` that is talking to a server, plus the things only such a
 * client can ask.
 *
 * `health` is here rather than on `WorkflowService` because there is no server
 * in the local case: `LocalService` is the engine running in your own process,
 * and asking it for its uptime and data directory would be asking it to invent
 * answers about a tier that does not exist. The seam that both implement stays
 * the workflow operations; this is the extra reach a remote client has.
 */
export interface RemoteWorkflowService extends WorkflowService {
  /** Liveness and what the server is. See `ServerHealth`. */
  health(): Promise<ServerHealth>;
}

export function createRemoteService(
  baseUrl: string,
  options: RemoteServiceOptions = {},
): RemoteWorkflowService {
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  const statusCache = new Map<string, ExecutionStatus>();
  let idCounter = 0;

  async function call(request: RpcRequest): Promise<unknown> {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
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
      // Forward the whole options bag, not just the id. Rebuilding it here meant
      // every option added later was silently dropped on the way to the server —
      // `taskQueue` went missing exactly that way, and the symptom was a workflow
      // that started on the default queue and waited forever for a worker.
      void call({
        method: 'start',
        name,
        args,
        opts: {...opts, workflowId},
      }).catch(() => {});
      return {workflowId};
    },
    signal(workflowId, signalName, payload) {
      void call({method: 'signal', workflowId, signalName, payload}).catch(
        () => {},
      );
    },
    cancel(workflowId) {
      void call({method: 'cancel', workflowId}).catch(() => {});
    },
    terminate(workflowId, reason) {
      void call({method: 'terminate', workflowId, reason}).catch(() => {});
    },
    reset(workflowId, keep) {
      void call({method: 'reset', workflowId, keep}).catch(() => {});
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
        if (outcome.status !== 'running') {
          const error = new Error(
            outcome.failure ?? `workflow ${outcome.status}`,
          );
          // The stack from where it broke, not from this poll loop.
          if (outcome.failureStack !== undefined)
            error.stack = outcome.failureStack;
          throw error;
        }
        await sleep(pollIntervalMs);
      }
    },
    async describeExecution(
      workflowId: string,
      options?: DescribeOptions,
    ): Promise<ExecutionDetail | undefined> {
      return (
        ((await call({
          method: 'describeExecution',
          workflowId,
          options,
        })) as ExecutionDetail | null) ?? undefined
      );
    },
    async listExecutions(filter?: ExecutionFilter): Promise<ExecutionPage> {
      return (await call({method: 'listExecutions', filter})) as ExecutionPage;
    },
    async listQueues(): Promise<QueueWorkers[]> {
      return (await call({method: 'listQueues'})) as QueueWorkers[];
    },
    async health(): Promise<ServerHealth> {
      return (await call({method: 'health'})) as ServerHealth;
    },
    async groupExecutions(): Promise<ExecutionGroups> {
      return (await call({method: 'groupExecutions'})) as ExecutionGroups;
    },
    async pollWorkflowTask(
      taskQueue?: string,
      identity?: string,
    ): Promise<WorkflowTask | undefined> {
      return (
        ((await call({
          method: 'pollWorkflowTask',
          taskQueue,
          identity,
        })) as WorkflowTask | null) ?? undefined
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
          ? {
              ...result,
              failure: errorMessage(result.failure),
              // Sent alongside, because the flattening above is exactly what
              // loses it: an Error JSON-serializes to `{}`.
              failureStack:
                result.failureStack ??
                (result.failure instanceof Error
                  ? result.failure.stack
                  : undefined),
            }
          : result,
      });
    },
    async failWorkflowTask(token: TaskToken, reason: string): Promise<void> {
      await call({method: 'failWorkflowTask', token, reason});
    },
    async pollActivityTask(
      taskQueue?: string,
      identity?: string,
    ): Promise<LeasedActivityTask | undefined> {
      return (
        ((await call({
          method: 'pollActivityTask',
          taskQueue,
          identity,
        })) as LeasedActivityTask | null) ?? undefined
      );
    },
    async completeActivityTask(
      token: TaskToken,
      result: ActivityResult,
    ): Promise<void> {
      await call({method: 'completeActivityTask', token, result});
    },
    async heartbeatActivityTask(token: TaskToken): Promise<void> {
      await call({method: 'heartbeatActivityTask', token});
    },
  };
}

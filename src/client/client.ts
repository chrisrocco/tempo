/**
 * @fileoverview
 * The client: turns the flat `WorkflowService` surface into ergonomic handles
 * (start -> a handle with result()/status()/signal()). Written once against the
 * service seam, so it is identical for local and remote. The `SignalDef`
 * convenience (accepting a defined signal or a bare name) lives here rather than
 * in `protocol`, keeping the wire contract free of any `core` dependency.
 *
 * ## It covers the whole client-facing surface, deliberately
 *
 * This used to wrap six of the service's eleven client-facing methods — the ones
 * that drive a single execution — and leave the reads (`describeExecution`,
 * `listExecutions`, `listQueues`, `groupExecutions`) and `reset` to be reached by
 * dropping down to a raw `WorkflowService`.
 *
 * That split was an accident of what got built first, and it made this the
 * ergonomic layer for exactly the calls that needed one least. Anything assembling
 * an operator tool wants all eleven, and half of them arriving through a different
 * object — with a different shape, no handle, and no type parameter — is a seam
 * for a distinction nobody is making.
 *
 * So the division here is by *what the call is about* rather than by when it was
 * written:
 *
 * - **`WorkflowHandle`** — one execution. Its result, its status, its history, and
 *   the three ways to intervene in it.
 * - **`Client`** — the server. Starting things, and the fleet-wide reads that are
 *   not about any one execution.
 *
 * ## The three interventions, and why `reset` is on the client rather than the handle
 *
 * `cancel`, `terminate`, and `reset` are one family:
 *
 * - **`cancel`** is cooperative, delivered through replay, so it cannot reach an
 *   execution whose replay is what fails.
 * - **`terminate`** ends such an execution, running no workflow code, and throws
 *   away the work.
 * - **`reset`** rewinds it to before whatever the deployed code cannot replay, and
 *   *keeps* the work. Nothing else recovers a wedged execution.
 *
 * All three being reachable matters — an operator who can stop a wedged execution
 * but not recover one has the wrong two out of the three. But `reset` is on
 * `Client` and the other two are on the handle, and that asymmetry is deliberate
 * rather than an oversight.
 *
 * `createLocalRuntime` hands out `WorkflowHandle`s, so anything on the handle is
 * part of the **author-facing** surface — reachable by the person writing
 * workflows and their tests. `Runtime` deliberately does not expose `reset`:
 * whether a workflow author may rewind their own execution is a separate question
 * from whether an operator may, and it has not been answered. That decision is
 * recorded in `spec/server/reset_to_event.spec.ts`, and putting `reset` on the
 * handle would quietly reverse it.
 *
 * `Client` is the operator's object — it is what an assembled tool holds, and
 * `Runtime` never hands one out — so that is where the destructive recovery goes.
 * The day the author-facing question gets an answer, this moves.
 */

import type {SignalDef} from '../core';
import type {
  DescribeOptions,
  ExecutionDetail,
  ExecutionFilter,
  ExecutionGroups,
  ExecutionPage,
  ExecutionStatus,
  QueueWorkers,
  RemoteWorkflowService,
  ServerHealth,
  WorkflowService,
} from '../protocol';

/** One execution: what it did, and the ways to intervene in it. */
export interface WorkflowHandle<T = unknown> {
  workflowId: string;
  result(): Promise<T>;
  status(): ExecutionStatus;
  /**
   * Status, what the execution is waiting on, and its history.
   *
   * Everything here is derived server-side (`server/execution_view.ts`) rather
   * than assembled from separate reads, so every client sees one answer to "what
   * is this execution doing". `undefined` for an id the server has never seen.
   */
  describe(options?: DescribeOptions): Promise<ExecutionDetail | undefined>;
  signal(signalDef: SignalDef | string, payload?: unknown): void;
  /**
   * Ask the workflow to unwind. Cooperative: it is delivered through replay, so
   * the workflow catches `CancelledFailure` and can clean up — and so it cannot
   * reach an execution whose replay is itself failing. Use `terminate` for that.
   */
  cancel(): void;
  /**
   * End the execution outright, running no workflow code. `result()` rejects with
   * the reason. The blunt instrument, for when cancel cannot land.
   */
  terminate(reason?: string): void;
}

/** The server: starting executions, and the reads that span all of them. */
export interface Client {
  start<T = unknown>(
    name: string,
    args?: unknown[],
    opts?: {workflowId?: string; taskQueue?: string},
  ): WorkflowHandle<T>;
  /** A handle to an existing execution (e.g. one picked up by resume). */
  getHandle<T = unknown>(workflowId: string): WorkflowHandle<T>;
  /**
   * One page of executions, newest first.
   *
   * The filter goes to the server, which is the point of it existing: asking for
   * everything and narrowing it here is exactly the cost paging exists to save.
   */
  list(filter?: ExecutionFilter): Promise<ExecutionPage>;
  /**
   * Which task queues are being polled, per role, and by whom.
   *
   * The one question the execution reads cannot answer. An execution parked on an
   * activity looks identical whether a worker is about to claim it or nothing has
   * ever polled its queue, and the second is usually a deployment mistake rather
   * than a code one. Unlike everything else here it is **not derived from
   * history** — worker liveness is an observation the running server made, and
   * nothing durable backs it (see `server/worker_registry.ts`).
   */
  queues(): Promise<QueueWorkers[]>;
  /**
   * Every execution counted by status, grouped by queue and by name.
   *
   * Counted server-side rather than tallied from a listing, which would report on
   * one capped page rather than on the server.
   */
  counts(): Promise<ExecutionGroups>;
  /**
   * Drop every event from `keep` onward and replay from there — the recovery for
   * an execution the deployed code cannot replay, where `terminate` is the
   * write-off.
   *
   * **Destructive**: the dropped events do not come back, and the caller is
   * expected to have said so out loud. `keep` is an index into the history, so
   * event `keep` is the first one dropped; read it off `describe()`, whose history
   * is numbered from the same origin.
   *
   * On `Client` rather than on `WorkflowHandle` on purpose — see the fileoverview.
   * The handle is the author-facing surface and this is an operator's tool.
   */
  reset(workflowId: string, keep: number): void;
}

/**
 * A `Client` talking to a server over a wire, plus the one question only such a
 * client can ask.
 *
 * Mirrors `RemoteWorkflowService` one layer up, and for the same reason: there is
 * no server tier in the local case, so asking an in-process engine for its uptime
 * and data directory would be asking it to invent answers.
 */
export interface RemoteClient extends Client {
  /**
   * Liveness, and what this server is.
   *
   * Doubles as the reachability probe an operator tool needs, which is why there
   * is no separate `ping`. The writes on `WorkflowHandle` are fire-and-forget —
   * `signal`, `cancel`, `terminate`, and `reset` all return `void`, and the
   * service reports their failures later or not at all — so without a probe
   * "sent" and "dropped into a closed port" are the same thing from the caller's
   * side. Rejecting is the answer to "not reachable"; a caller that wants a
   * boolean catches, and one that wants to name the address it tried has the
   * error to do it with.
   *
   * **`durable: false` is the field to read first.** It means the server is
   * keeping history in memory and will lose every execution on its next restart,
   * while looking entirely healthy until then. Nothing else reports that.
   */
  health(): Promise<ServerHealth>;
}

export function createClient(service: WorkflowService): Client {
  function handle<T>(workflowId: string): WorkflowHandle<T> {
    return {
      workflowId,
      result: () => service.getResult(workflowId) as Promise<T>,
      status: () => service.getStatus(workflowId),
      describe: (options) => service.describeExecution(workflowId, options),
      signal: (signalDef, payload) =>
        service.signal(
          workflowId,
          typeof signalDef === 'string' ? signalDef : signalDef.name,
          payload,
        ),
      cancel: () => service.cancel(workflowId),
      terminate: (reason = 'terminated by operator') =>
        service.terminate(workflowId, reason),
    };
  }

  return {
    start<T = unknown>(
      name: string,
      args: unknown[] = [],
      opts: {workflowId?: string; taskQueue?: string} = {},
    ): WorkflowHandle<T> {
      const {workflowId} = service.start(name, args, opts);
      return handle<T>(workflowId);
    },
    getHandle<T = unknown>(workflowId: string): WorkflowHandle<T> {
      return handle<T>(workflowId);
    },
    list: (filter) => service.listExecutions(filter),
    queues: () => service.listQueues(),
    counts: () => service.groupExecutions(),
    reset: (workflowId, keep) => service.reset(workflowId, keep),
  };
}

/**
 * A client over a service that is talking to a server.
 *
 * Everything `createClient` gives, plus `health`. This is what an operator tool
 * holds: it is always remote — a CLI that had the engine in its own process would
 * be the engine — so it always has the whole surface, and never needs to keep a
 * raw service alongside the client to reach one method.
 */
export function createRemoteClient(
  service: RemoteWorkflowService,
): RemoteClient {
  return {
    ...createClient(service),
    health: () => service.health(),
  };
}

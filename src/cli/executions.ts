/**
 * @fileoverview
 * The commands that drive and read workflow executions — `start` and `result`
 * today — over the same `RemoteService` an application client uses. The CLI is a
 * front door onto that seam, not a second protocol.
 *
 * Note the seam's shape: writes are fire-and-forget (`start` returns an id
 * without waiting for the server to accept it) and `getResult` is the
 * authoritative await. So these commands probe the server for reachability
 * first, which is the difference between "sent" and "silently dropped into a
 * closed port".
 *
 * ## Exit codes are part of the contract
 *
 * A command that waits for a workflow exits non-zero when the workflow failed.
 * `--wait` exists mostly so a CI job can run one workflow and be told whether it
 * worked, and a failed workflow that exits 0 makes that check worthless. The
 * mechanism is just letting `getResult`'s rejection reach `runCli`, but it is
 * load-bearing rather than incidental, which is why it is written down.
 */

import {createRemoteService} from '../services';
import {DEFAULT_SERVER_URL} from '../tempo';

/**
 * Where a command talks to when `--server` was not given.
 *
 * No environment variable is consulted, deliberately — see the configuration
 * section of `src/cli/README.md`. An inherited `TEMPO_SERVER_URL` pointing a
 * command at yesterday's server is the failure this avoids, and the cost is
 * typing `--server` when talking to a host that is not this one.
 */
export function resolveServerUrl(flagValue: string | undefined): string {
  return flagValue ?? DEFAULT_SERVER_URL;
}

/**
 * Print a string result bare; anything else as JSON.
 *
 * A workflow returning a string is the common case and quoting it would make the
 * output awkward to pipe. Everything else has to be unambiguous, and JSON is the
 * only shaping that round-trips.
 */
export function formatResult(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Confirm something is listening before issuing a fire-and-forget write. The
 * body is irrelevant — any well-formed HTTP response proves reachability.
 *
 * The error names the command that would fix it, because "connection refused" on
 * a fresh host is almost always "nothing is deployed here yet" rather than a
 * network fault.
 */
async function assertReachable(serverUrl: string): Promise<void> {
  try {
    await fetch(serverUrl, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{}',
    });
  } catch {
    throw new Error(
      `cannot reach a tempo server at ${serverUrl}\n` +
        `  if nothing is deployed there yet: tempo up --server=<path> --worker=<path>`,
    );
  }
}

export interface StartRequest {
  serverUrl: string;
  name: string;
  args: unknown[];
  /** Block for the outcome and print it, instead of printing the id. */
  wait: boolean;
  /** Worker pool to run on. The workers serving it must register this workflow. */
  taskQueue?: string;
}

/**
 * `tempo start` — begin an execution.
 *
 * Without `wait` this prints the id and leaves the workflow running on the
 * server; `tempo result <id>` is how that id is redeemed later. With `wait` it
 * blocks and prints the outcome, and a workflow failure surfaces as a rejection
 * so the process exits non-zero.
 */
export async function startWorkflow(request: StartRequest): Promise<number> {
  await assertReachable(request.serverUrl);
  const service = createRemoteService(request.serverUrl);
  const {workflowId} = service.start(request.name, request.args, {
    // Only sent when asked for: an explicit `undefined` would be indistinguishable
    // here, but the server defaults the queue and saying nothing is what lets it.
    ...(request.taskQueue === undefined ? {} : {taskQueue: request.taskQueue}),
  });

  if (!request.wait) {
    process.stdout.write(`${workflowId}\n`);
    return 0;
  }
  process.stdout.write(
    `${formatResult(await service.getResult(workflowId))}\n`,
  );
  return 0;
}

/**
 * `tempo result` — the outcome of an execution that already exists, blocking
 * until it settles.
 *
 * The counterpart to a bare `start`: that prints an id and exits, and without
 * this the id would lead nowhere. Same formatting and same exit-code rule as
 * `start --wait`, because it is answering the same question later.
 */
export async function fetchResult(
  serverUrl: string,
  workflowId: string,
): Promise<number> {
  await assertReachable(serverUrl);
  const service = createRemoteService(serverUrl);
  process.stdout.write(
    `${formatResult(await service.getResult(workflowId))}\n`,
  );
  return 0;
}

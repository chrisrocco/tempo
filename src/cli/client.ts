/**
 * @fileoverview
 * The workflow-driving CLI commands — `start`, `result`, `signal`, `cancel` —
 * over the same `RemoteService` an application client uses. The CLI is a front
 * door onto that seam, not a second protocol.
 *
 * Note the seam's shape: writes are fire-and-forget (errors surface later) and
 * `getResult` is the authoritative await. So these commands probe the server for
 * reachability first, which is the difference between "sent" and "silently
 * dropped into a closed port".
 */

import { createRemoteService } from '../services';
import { DEFAULT_SERVER_URL } from '../tempo';

/** Print a string result bare; anything else as JSON. */
function formatResult(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Workflow arguments arrive as strings. Parse each as JSON so numbers, booleans,
 * objects and arrays survive, falling back to the raw string — which is what
 * makes `tempo start greeter world` do the obvious thing.
 */
export function parseWorkflowArg(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Confirm something is listening before issuing a fire-and-forget write. The
 * body is irrelevant — any well-formed HTTP response proves reachability.
 */
async function assertReachable(serverUrl: string): Promise<void> {
  try {
    await fetch(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  } catch {
    throw new Error(`cannot reach a tempo server at ${serverUrl}`);
  }
}

export async function startWorkflow(
  serverUrl: string,
  name: string,
  args: unknown[],
  wait: boolean,
): Promise<number> {
  await assertReachable(serverUrl);
  const service = createRemoteService(serverUrl);
  const { workflowId } = service.start(name, args);
  if (!wait) {
    process.stdout.write(`${workflowId}\n`);
    return 0;
  }
  process.stdout.write(formatResult(await service.getResult(workflowId)));
  process.stdout.write('\n');
  return 0;
}

export async function fetchResult(
  serverUrl: string,
  workflowId: string,
): Promise<number> {
  await assertReachable(serverUrl);
  const service = createRemoteService(serverUrl);
  process.stdout.write(formatResult(await service.getResult(workflowId)));
  process.stdout.write('\n');
  return 0;
}

export async function sendSignal(
  serverUrl: string,
  workflowId: string,
  signalName: string,
  payload: unknown,
): Promise<number> {
  await assertReachable(serverUrl);
  createRemoteService(serverUrl).signal(workflowId, signalName, payload);
  return 0;
}

export async function cancelWorkflow(
  serverUrl: string,
  workflowId: string,
): Promise<number> {
  await assertReachable(serverUrl);
  createRemoteService(serverUrl).cancel(workflowId);
  return 0;
}

export function resolveServerUrl(flag: string | undefined): string {
  return flag ?? process.env.TEMPO_SERVER_URL ?? DEFAULT_SERVER_URL;
}

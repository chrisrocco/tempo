/**
 * @fileoverview
 * The workflow-driving CLI commands — `start`, `result`, `signal`, `cancel` — and
 * the read-only ones — `describe`, `list` — over the same `RemoteService` an
 * application client uses. The CLI is a front door onto that seam, not a second
 * protocol.
 *
 * Note the seam's shape: writes are fire-and-forget (errors surface later) and
 * `getResult` is the authoritative await. So these commands probe the server for
 * reachability first, which is the difference between "sent" and "silently
 * dropped into a closed port".
 *
 * The read commands render; they do not decide. Everything they show is derived
 * server-side (see `server/execution_view.ts`) so that the CLI and any other
 * client see one answer, and `--json` hands that answer over unformatted for
 * anything that would rather parse than read.
 */

import type { ExecutionDetail, HistoryEvent } from '../protocol';
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

/** One history event as a line: the type, its seq if it has one, and its payload. */
function formatEvent(ev: HistoryEvent, index: number): string {
  const seq = 'seq' in ev ? ` seq=${ev.seq}` : '';
  const detail =
    ev.type === 'activityScheduled'
      ? ` ${ev.name}(${ev.args.map(formatResult).join(', ')})`
      : ev.type === 'signal'
        ? ` ${ev.name}`
        : ev.type === 'childStarted'
          ? ` ${ev.childId}${ev.detached ? ' (detached)' : ''}`
          : ev.type === 'timerStarted'
            ? ` fireAt=${new Date(ev.fireAt).toISOString()}`
            : ev.type === 'activityFailed' || ev.type === 'childFailed'
              ? ` ${ev.error}`
              : '';
  return `  ${String(index).padStart(3)}  ${ev.type}${seq}${detail}`;
}

/**
 * Why an execution is parked, in the operator's words. A running execution with
 * nothing pending is the interesting case — it is either mid-task or genuinely
 * stuck — so say so explicitly rather than printing an empty section.
 */
function formatPending(detail: ExecutionDetail): string[] {
  const lines: string[] = [];
  for (const a of detail.pending.activities)
    lines.push(`  activity  seq=${a.seq}  ${a.name}`);
  for (const t of detail.pending.timers)
    lines.push(
      `  timer     seq=${t.seq}  fires ${new Date(t.fireAt).toISOString()}`,
    );
  for (const c of detail.pending.children)
    lines.push(
      `  child     seq=${c.seq}  ${c.childId}${c.detached ? ' (detached)' : ''}`,
    );
  if (lines.length > 0) return lines;
  return [
    detail.status === 'running'
      ? '  nothing — mid-task, or stuck'
      : '  nothing',
  ];
}

export async function describeExecution(
  serverUrl: string,
  workflowId: string,
  asJson: boolean,
): Promise<number> {
  await assertReachable(serverUrl);
  const detail =
    await createRemoteService(serverUrl).describeExecution(workflowId);
  if (!detail) throw new Error(`no execution ${workflowId}`);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
    return 0;
  }
  const out = [
    `${detail.workflowId}  ${detail.status}${detail.cancelRequested ? '  (cancel requested)' : ''}`,
    `workflow:  ${detail.name}`,
    `run:       ${detail.runId}`,
    `args:      ${JSON.stringify(detail.args)}`,
  ];
  if (detail.result !== undefined)
    out.push(`result:    ${formatResult(detail.result)}`);
  if (detail.failure !== undefined) out.push(`failure:   ${detail.failure}`);
  out.push('', 'waiting on:', ...formatPending(detail));
  out.push('', `history (${detail.historyLength}):`);
  out.push(...detail.history.map(formatEvent));
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

export async function listExecutions(
  serverUrl: string,
  asJson: boolean,
): Promise<number> {
  await assertReachable(serverUrl);
  const rows = await createRemoteService(serverUrl).listExecutions();
  if (asJson) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write('no executions\n');
    return 0;
  }
  const width = Math.max(...rows.map((r) => r.workflowId.length), 11);
  process.stdout.write(
    `${'WORKFLOW ID'.padEnd(width)}  ${'NAME'.padEnd(12)}  ${'STATUS'.padEnd(9)}  EVENTS\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${r.workflowId.padEnd(width)}  ${r.name.padEnd(12)}  ${r.status.padEnd(9)}  ${r.historyLength}\n`,
    );
  }
  return 0;
}

export function resolveServerUrl(flag: string | undefined): string {
  return flag ?? process.env.TEMPO_SERVER_URL ?? DEFAULT_SERVER_URL;
}

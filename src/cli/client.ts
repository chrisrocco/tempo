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

import {
  isStuck,
  type ExecutionDetail,
  type ExecutionFilter,
  type HistoryEvent,
} from '../protocol';
import {createRemoteService} from '../services';
import {DEFAULT_SERVER_URL} from '../tempo';

/** Two spaces, so a copied stack still reads as one block under its heading. */
function indent(line: string): string {
  return `  ${line}`;
}

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
      headers: {'content-type': 'application/json'},
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
  taskQueue?: string,
): Promise<number> {
  await assertReachable(serverUrl);
  const service = createRemoteService(serverUrl);
  const {workflowId} = service.start(name, args, {taskQueue});
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

/**
 * End an execution without replaying it. Kept distinct from `cancel` in the
 * command surface as well as the code: reaching for the wrong one on a wedged
 * execution looks like nothing happening at all.
 */
export async function terminateWorkflow(
  serverUrl: string,
  workflowId: string,
  reason: string,
): Promise<number> {
  await assertReachable(serverUrl);
  createRemoteService(serverUrl).terminate(workflowId, reason);
  return 0;
}

/**
 * How long after the first event this one landed.
 *
 * Relative rather than absolute, because the question a history answers is
 * "what took the time", and a column of near-identical ISO strings answers it
 * badly. `first` is the execution's own start, so the numbers are readable
 * whether it ran last minute or last month.
 */
function formatOffset(
  ts: number | undefined,
  first: number | undefined,
): string {
  if (ts === undefined || first === undefined) return '        '; // pre-`ts` history
  const seconds = (ts - first) / 1000;
  return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}s`.padStart(
    7,
  );
}

/**
 * One history event as a line: when, the type, its seq if it has one, and its
 * payload. `first` is the execution's earliest timestamp, so the time column
 * reads as an elapsed offset.
 */
function formatEvent(ev: HistoryEvent, index: number, first?: number): string {
  const at = `${formatOffset(ev.ts, first)} `;
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
  return `  ${at}${String(index).padStart(3)}  ${ev.type}${seq}${detail}`;
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
  // Shown whenever there is any: carryover decides what a workflow does next
  // (a poller's cursor, say), so "why did it skip that item" is unanswerable
  // without it. Ambient state that an operator cannot see is hidden state.
  if (detail.carryover && Object.keys(detail.carryover).length > 0)
    out.push(`carryover: ${JSON.stringify(detail.carryover)}`);
  // The stack goes below the summary lines rather than inline: it is multi-line
  // and would wreck the aligned block above it.
  if (detail.failureStack !== undefined)
    out.push('', 'stack:', ...detail.failureStack.split('\n').map(indent));
  // The wedged case. Loud on purpose: a running execution the engine cannot
  // replay looks identical to a healthy parked one without this. Only while it
  // is still running, though — the count outlives the execution, and announcing
  // a retry schedule for something already settled is just wrong.
  if (isStuck(detail)) {
    out.push(
      '',
      `STUCK — ${detail.taskFailures} consecutive task failure${detail.taskFailures === 1 ? '' : 's'}, retrying with backoff`,
      `  last error: ${detail.lastTaskFailure ?? 'unknown'}`,
      '  the execution is not lost: fix the workflow, redeploy the workers, and it resumes',
    );
  }
  out.push('', 'waiting on:', ...formatPending(detail));
  out.push('', `history (${detail.historyLength}):`);
  const firstTs = detail.history.find((e) => e.ts !== undefined)?.ts;
  out.push(...detail.history.map((e, i) => formatEvent(e, i, firstTs)));
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

/** `3m`, `2h`, `4d` — coarse on purpose; a listing wants recency, not precision. */
function formatAge(createdAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

export async function listExecutions(
  serverUrl: string,
  asJson: boolean,
  filter: ExecutionFilter = {},
): Promise<number> {
  await assertReachable(serverUrl);
  // The filter goes to the server, which is the point of it existing: asking for
  // everything and discarding it here is exactly the cost paging exists to save.
  const page = await createRemoteService(serverUrl).listExecutions(filter);
  const rows = page.executions;
  if (asJson) {
    process.stdout.write(`${JSON.stringify(page, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write(
      filter.stuck ? 'no stuck executions\n' : 'no executions\n',
    );
    return 0;
  }
  const width = Math.max(...rows.map((r) => r.workflowId.length), 11);
  process.stdout.write(
    `${'WORKFLOW ID'.padEnd(width)}  ${'NAME'.padEnd(12)}  ${'QUEUE'.padEnd(10)}  ${'STATUS'.padEnd(10)}  ${'AGE'.padStart(4)}  EVENTS\n`,
  );
  for (const r of rows) {
    // The marker goes on the row rather than into STATUS: the status is
    // genuinely `running`, and overwriting it would hide that this execution is
    // still live and still retrying.
    const note = isStuck(r)
      ? `  STUCK (${r.taskFailures} task failures: ${r.lastTaskFailure})`
      : '';
    process.stdout.write(
      `${r.workflowId.padEnd(width)}  ${r.name.padEnd(12)}  ${r.taskQueue.padEnd(10)}  ${r.status.padEnd(10)}  ${formatAge(r.createdAt).padStart(4)}  ${r.historyLength}${note}\n`,
    );
  }
  // Only when there is more: a caller who sees nothing has the whole answer.
  if (page.nextCursor !== undefined)
    process.stdout.write(
      `\n… more. Continue with --cursor=${page.nextCursor}\n`,
    );
  return 0;
}

export function resolveServerUrl(flag: string | undefined): string {
  return flag ?? process.env['TEMPO_SERVER_URL'] ?? DEFAULT_SERVER_URL;
}

/**
 * @fileoverview
 * Telling the server what this worker has registered.
 *
 * A poll says *who is asking* and, once step 3 lands, a digest of what it serves. This is
 * the other half: the descriptions themselves, which are far too large to repeat at the
 * idle poll interval — 5ms, so a few hundred times a second — and change only when the
 * worker binary does.
 *
 * ## Pushed on a slow heartbeat, not announced once
 *
 * The obvious design is to announce at startup and never again. It is wrong for one
 * reason: the server can forget. A restarted server has an empty registry and no way to
 * ask, because nothing in the poll exchange lets it request anything — the response is a
 * task or nothing. So a worker that announced once would be invisible to every server that
 * restarted after it started, which is exactly the moment an operator is looking.
 *
 * Repeating on an interval fixes that without a response channel: the server does not ask,
 * the worker keeps offering. Thirty seconds against five milliseconds is six thousand times
 * less traffic than the poll, and the staleness window after a restart is bounded by it.
 *
 * ## The digest is the reconciliation
 *
 * Every report carries a hash of what it contains, and the worker puts the same hash on
 * every poll. That lets the server answer a question it otherwise could not: *is the copy I
 * hold still what this worker is running?* A mismatch means stale, and stale is reported as
 * **unknown** rather than as fact — the three-valued answer `isNameServed` already has.
 *
 * It is also why a redeployed worker under one identity is not a problem: the hash changes,
 * the server's copy is stale from that instant, and the next report replaces it.
 */

import {createHash} from 'node:crypto';
import type {WorkflowReport, WorkflowService} from '../protocol';

/** How often a worker re-offers its report. See the fileoverview. */
export const REPORT_INTERVAL_MS = 30_000;

/**
 * A stable digest of a report set.
 *
 * Sorted by name first, so two workers running identical code agree regardless of the
 * order their registries happened to be built in — otherwise every worker would look like
 * it disagreed with every other, and the conflict signal would be noise.
 *
 * `node:crypto` rather than a hand-rolled hash: it is a Node builtin, so it costs no
 * dependency, and a real digest removes any need to reason about collisions. Truncated
 * because this is compared, never inverted, and a short string is on every poll once step 3
 * lands.
 */
export function reportHash(workflows: readonly WorkflowReport[]): string {
  const ordered = [...workflows].sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256')
    .update(JSON.stringify(ordered))
    .digest('hex')
    .slice(0, 16);
}

/** Keeps a worker's report in front of the server, and stops when the worker does. */
export interface WorkflowReporter {
  /** The digest of what is being reported — what a poll carries. */
  readonly hash: string;
  /** Stop re-offering. */
  stop(): void;
}

export interface WorkflowReporterOptions {
  identity: string;
  taskQueue?: string;
  intervalMs?: number;
}

/**
 * Report `workflows` now, and keep re-offering until stopped.
 *
 * Failures are swallowed deliberately. This is a description of the fleet, not work: a
 * server that is down will be re-offered to on the next tick, and a worker that crashed
 * because its catalogue upload failed would be trading something real for something
 * cosmetic. The poll loop is where connectivity problems are already reported.
 */
export function startWorkflowReporter(
  service: WorkflowService,
  workflows: readonly WorkflowReport[],
  options: WorkflowReporterOptions,
): WorkflowReporter {
  const hash = reportHash(workflows);
  const send = (): void => {
    void service
      .reportWorkflows({
        identity: options.identity,
        ...(options.taskQueue === undefined
          ? {}
          : {taskQueue: options.taskQueue}),
        hash,
        workflows,
      })
      .catch(() => {});
  };

  send();
  const timer = setInterval(send, options.intervalMs ?? REPORT_INTERVAL_MS);
  // Unref'd, unlike a workflow's timer: this one produces no work and owes nobody an
  // outcome, so it must not be the reason a process refuses to exit. Contrast
  // `MemoryTimerService`, whose handles are ref'd precisely because a pending timer there
  // means a workflow is waiting on it.
  timer.unref?.();

  return {
    hash,
    stop(): void {
      clearInterval(timer);
    },
  };
}

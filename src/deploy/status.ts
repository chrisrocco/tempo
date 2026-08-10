/**
 * @fileoverview
 * `status` — what a deployment is actually doing, as data.
 *
 * Returns a structure and formats nothing. How this reads on a terminal is a
 * decision for whoever assembles a command-line tool, and baking one presentation
 * in here would make every other one work around it.
 *
 * ## Two sources, because either alone can be reassuring and wrong
 *
 * **systemd** says whether each process is up, enabled, and how often it has been
 * restarted. It answers with no server running, which is when the question is
 * most urgent.
 *
 * **The server's worker registry** says who is actually polling, per queue and
 * role — see `server/worker_registry.ts`.
 *
 * A worker can be the first without being the second: the process is up, systemd
 * is satisfied, and nothing is being served. That is the failure this function
 * exists to expose, and neither source can see it alone — which is why `status`
 * asks both and reports them side by side rather than picking whichever is
 * cheaper.
 *
 * ## Unreachable is an answer, not an error
 *
 * **This never rejects because the server did not answer.** "The units are up and
 * nothing is listening on 7777" is the most useful thing it could ever return,
 * and a function that threw on a refused connection could not say it. So the
 * server half is optional and carries the reason it is missing.
 *
 * That is also why the reachability probe lives here rather than in a client
 * helper: the one caller that genuinely wants "is anything there" as a value
 * instead of an exception is this one.
 *
 * ## It does not need root
 *
 * `systemctl show` is readable by anyone and the RPC has no auth. Worth stating
 * because `up` and `down` both refuse without root, and an operator who has just
 * met those two would reasonably assume this one does too.
 */

import {
  isQueueServed,
  workersServing,
  type ExecutionGroup,
  type QueueWorkers,
} from '../protocol';
import {createRemoteService} from '../services';
import {DEFAULT_SERVER_URL} from '../tempo';
import {ALL_UNITS} from './layout';
import type {Host} from './ports/host';
import {unitState, type UnitState} from './systemctl';

/** Where to look. */
export interface StatusOptions {
  /** The server to ask. Default `DEFAULT_SERVER_URL`. */
  serverUrl?: string;
}

/** One queue, as both sources see it together. */
export interface QueueReport {
  taskQueue: string;
  /** Is a workflow-task poll arriving recently enough to count as served? */
  workflowServed: boolean;
  /** Is an activity-task poll? */
  activityServed: boolean;
  /** Identities serving this queue in either role, including wildcard pollers. */
  workers: readonly string[];
  /** Execution counts on this queue, absent if nothing has ever run on it. */
  executions?: ExecutionGroup;
}

/** What the server said, when it said anything. */
export interface ServerReport {
  reachable: true;
  queues: readonly QueueReport[];
  /**
   * Queues with executions and nothing polling them. The single most actionable
   * line in a status: work is waiting and no worker will ever claim it.
   */
  unservedQueues: readonly string[];
}

/** Why the server said nothing. */
export interface ServerUnreachable {
  reachable: false;
  /** The URL that was tried, so the answer names what it failed to reach. */
  serverUrl: string;
  /** What went wrong, as far as it can be known from the outside. */
  reason: string;
}

/** Everything `status` found. */
export interface DeploymentStatus {
  /** One entry per unit, server first. */
  units: readonly UnitState[];
  server: ServerReport | ServerUnreachable;
  /**
   * True when every unit is active and the server answered. The one-line summary
   * a caller can branch on without re-deriving it from the parts.
   */
  healthy: boolean;
}

/**
 * Ask the server what its fleet looks like.
 *
 * Both reads are issued together: they are one question, and serializing them
 * would double the latency for nothing. A failure of either is reported as
 * unreachable rather than thrown — see the fileoverview.
 */
async function readServer(
  serverUrl: string,
): Promise<ServerReport | ServerUnreachable> {
  const service = createRemoteService(serverUrl);
  let queues: QueueWorkers[];
  let groups: ExecutionGroup[];
  try {
    const [q, g] = await Promise.all([
      service.listQueues(),
      service.groupExecutions(),
    ]);
    queues = q;
    groups = g.byTaskQueue;
  } catch (e) {
    return {
      reachable: false,
      serverUrl,
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  const counts = new Map(groups.map((g) => [g.key, g]));
  // The union of both sources, because each answers half of it. A queue with
  // workers and no executions is an idle pool; a queue with executions and no
  // workers is the one worth waking someone for, and listing only what has been
  // polled would hide precisely the second.
  const names = [
    ...new Set([...queues.map((q) => q.taskQueue), ...counts.keys()]),
  ].sort();

  // One instant for every queue, so two rows of the same report cannot disagree
  // about whether a poll was recent.
  const now = Date.now();

  // `isQueueServed` and `workersServing` rather than reading `workers` directly:
  // both encode the rule that a worker polling every queue serves this one too,
  // and a client applying that rule itself is a client that will disagree with
  // the dashboard about how big a fleet is.
  const reports: QueueReport[] = names.map((taskQueue) => {
    const executions = counts.get(taskQueue);
    return {
      taskQueue,
      workflowServed: isQueueServed(queues, taskQueue, 'workflow', now),
      activityServed: isQueueServed(queues, taskQueue, 'activity', now),
      workers: [
        ...new Set(
          [
            ...workersServing(queues, taskQueue, 'workflow'),
            ...workersServing(queues, taskQueue, 'activity'),
          ].map((w) => w.identity),
        ),
      ],
      ...(executions === undefined ? {} : {executions}),
    };
  });

  return {
    reachable: true,
    queues: reports,
    // Only queues that have work: an idle unserved queue is a pool nobody is
    // using, which is not a problem, and reporting it as one trains an operator
    // to ignore this field.
    unservedQueues: reports
      .filter(
        (r) =>
          (r.executions?.running ?? 0) > 0 &&
          !r.workflowServed &&
          !r.activityServed,
      )
      .map((r) => r.taskQueue),
  };
}

/** Read a deployment's state from systemd and from the server it runs. */
export async function status(
  options: StatusOptions,
  host: Host,
): Promise<DeploymentStatus> {
  const serverUrl = options.serverUrl ?? DEFAULT_SERVER_URL;

  // Sequential rather than concurrent: three `systemctl show` calls against one
  // machine, where the ordering of the result matters more than the milliseconds.
  const units: UnitState[] = [];
  for (const unit of ALL_UNITS) units.push(await unitState(host, unit));

  const server = await readServer(serverUrl);

  return {
    units,
    server,
    healthy:
      server.reachable &&
      units.every((u) => u.activeState === 'active') &&
      server.unservedQueues.length === 0,
  };
}

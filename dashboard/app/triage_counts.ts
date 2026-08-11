/**
 * @fileoverview
 * The numbers behind "is anything wrong right now", derived from the two reads
 * the queues view already makes.
 *
 * DOM-free, so the suite covers it (`spec/dashboard/triage_counts.spec.ts`) —
 * the same split as `routes.ts` / `router.ts`. The cases worth pinning down are
 * the ones where the honest answer is "not known yet", which a number cannot
 * express and a zero would misrepresent.
 *
 * ## Totals come from the task-queue grouping, not the name one
 *
 * `ExecutionGroups` carries both, and either would sum to the same totals —
 * every execution has exactly one task queue and exactly one name. The queue
 * grouping is used because the unserved count needs it anyway, and reading one
 * of the two is less to get wrong than reading both.
 *
 * ## `stuck` overlaps `running` and must not be added to it
 *
 * A wedged execution *is* running (see `isStuck` in the protocol), so the four
 * statuses sum to the total and `stuck` does not. The strip renders them side by
 * side rather than as parts of a whole, for that reason.
 */

import {
  isQueueServed,
  type ExecutionGroups,
  type QueueLiveness,
} from 'workflow-engine/protocol';

/** What the strip shows. */
export interface TriageCounts {
  running: number;
  /** Running, but the engine cannot replay them. A subset of `running`. */
  stuck: number;
  failed: number;
  /**
   * Queues with running executions that nothing is polling for workflow work.
   *
   * `undefined` until the fleet has been read. That is not the same as zero, and
   * rendering it as zero would report "nothing is wrong with the workers" on
   * every first paint — an unanswered question dressed as a good answer.
   */
  unservedQueues: number | undefined;
}

/**
 * Fold the two reads into the strip's numbers.
 *
 * `undefined` when the groups have not arrived, because there is nothing
 * truthful to render yet. The fleet is allowed to be missing on its own — the
 * counts are still worth showing without it.
 */
export function triageCounts(
  groups: ExecutionGroups | undefined,
  queues: QueueLiveness[] | undefined,
  now: number,
): TriageCounts | undefined {
  if (groups === undefined) return undefined;

  let running = 0;
  let stuck = 0;
  let failed = 0;
  for (const group of groups.byTaskQueue) {
    running += group.running;
    stuck += group.stuck;
    failed += group.failed;
  }

  return {
    running,
    stuck,
    failed,
    unservedQueues: unserved(groups, queues, now),
  };
}

/**
 * How many queues have work that cannot move.
 *
 * Only queues with something *running* count. An idle queue nobody polls is a
 * pool at rest, which is fine and is exactly what the queues view shows without
 * alarm — flagging it here would make the strip cry wolf on every dev machine
 * with a stopped worker and no live executions.
 *
 * The workflow role is the one checked. Nothing polling for workflow tasks means
 * the execution cannot be replayed at all, so it cannot progress by any route;
 * an absent *activity* worker still leaves an execution that can advance to its
 * next dispatch. `isQueueServed` handles the wildcard queue, so a worker polling
 * everything serves every row.
 */
function unserved(
  groups: ExecutionGroups,
  queues: QueueLiveness[] | undefined,
  now: number,
): number | undefined {
  if (queues === undefined) return undefined;
  return groups.byTaskQueue.filter(
    (group) =>
      group.running > 0 && !isQueueServed(queues, group.key, 'workflow', now),
  ).length;
}

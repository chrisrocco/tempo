/**
 * @fileoverview
 * The queue of executions that need a workflow task run. It is the distributed
 * replacement for the old in-process `pump`: instead of a per-execution mutex +
 * rerun flag held in one process, wakes enqueue an execution here, a worker polls
 * it (taking a lease), and completion releases it. It adds a lease so a crashed
 * worker's task redelivers on timeout.
 *
 * The queue carries two guarantees, each preventing a concrete bug. They are the
 * reason this is a queue and not just a list of pending executions.
 *
 * **Job 1 — mutual exclusion: at most one task in flight per execution.** If a
 * wake could start a second, concurrent task for an execution already being
 * worked, both would replay against overlapping history and both could reach the
 * live edge for the same command seq — dispatching the same activity twice and
 * settling the result twice. One in-flight task per execution makes that
 * impossible. (A lease race can still hand two workers a task for the same
 * execution; that case is caught downstream by the version check in
 * `server_core.completeWorkflowTask`, which discards the loser. Safe, because
 * replay commits no external effects.)
 *
 * **Job 2 — no lost wakeups: a wake arriving mid-task coalesces into exactly one
 * more task.** A task works off the history it was built with. A signal appended
 * after that snapshot but before the task completes would otherwise be invisible
 * to it, and the workflow would park forever despite a pending signal. Recording
 * the wake and re-enqueuing once on completion closes that window. Coalescing
 * (rather than one task per wake) is what keeps a burst of signals from producing
 * a burst of redundant replays.
 */

import type { TaskToken } from '../../protocol';

export interface WorkflowTaskQueue {
  /**
   * Mark an execution as needing a task. If one is in flight, coalesce (run once
   * more). `taskQueue` is remembered for the execution, so the many callers that
   * merely wake it need not know how it was routed.
   */
  enqueue(workflowId: string, taskQueue?: string): void;
  /**
   * Take the next ready execution on `taskQueue`, leased with a token. Omitting
   * the name matches any pool — how the in-process runtime serves everything
   * with one set of loops.
   */
  poll(
    taskQueue?: string,
  ): { token: TaskToken; workflowId: string } | undefined;
  /** Ack a leased task; if a wake arrived while it was in-flight, re-enqueue it. */
  complete(token: TaskToken): void;
}

/**
 * @fileoverview
 * The port timers are scheduled through. Unlike the fire-immediately stub it
 * replaces, this models a durable timer: `schedule` records + arms a timer that
 * fires after its delay, and `onFire` is the sweep's callback back into the
 * server (append `timerFired`, wake the execution). `recover` is the startup
 * sweep — after a restart the in-memory `setTimeout` handles are gone, so the
 * server re-arms (or immediately fires past-due) every timer still in the table.
 * The durable adapter (a DB-backed table + a crash-tolerant sweep with failover)
 * is the Phase 4/5 swap; the server logic here does not change. Cross-process
 * sweep leader-election is unbuilt (ROADMAP Phase 9).
 *
 * A timer is otherwise the *same mechanism as an activity*: `sleep(ms)` allocates
 * a seq, registers a completion promise, and emits a `startTimer` command that a
 * `timerFired` event resolves. The only differences are the command payload and
 * that the "worker" is this service. The fire-time is recorded in history rather
 * than read from the clock at replay, which is what keeps time deterministic.
 */

export interface TimerService {
  /** Wire the sweep's fire callback. Called once at server startup. */
  onFire(handler: (workflowId: string, seq: number) => void): void;
  /** Arm a timer for (workflowId, seq) to fire at absolute epoch-ms `fireAt` (past-due => now). */
  schedule(workflowId: string, seq: number, fireAt: number): void;
  /** Remove a scheduled timer that has not yet fired. */
  cancel(workflowId: string, seq: number): void;
  /**
   * Remove every timer an execution is still holding.
   *
   * Called when an execution settles, and it takes the id rather than a list of seqs
   * on purpose: the caller would have to derive those from history, and at the moment
   * of settling its copy of that history is stale — the batch that ended the execution
   * may itself have armed a timer. The table is the only thing that already knows, so
   * it does the filtering and nothing can be missed.
   */
  cancelAll(workflowId: string): void;
  /** Startup sweep: re-arm (or immediately fire past-due) timers in the table. */
  recover(): void;
  /** Clear all in-flight timers (teardown). */
  stop(): void;
}

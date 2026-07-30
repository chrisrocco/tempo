// The port timers are scheduled through. Unlike the fire-immediately stub it
// replaces, this models a durable timer: `schedule` records + arms a timer that
// fires after its delay, and `onFire` is the sweep's callback back into the
// server (append `timerFired`, wake the execution). `recover` is the startup
// sweep — after a restart the in-memory `setTimeout` handles are gone, so the
// server re-arms (or immediately fires past-due) every timer still in the table.
// The durable adapter (a DB-backed table + a crash-tolerant sweep with failover)
// is the Phase 4/5 swap; the server logic here does not change. See doc 03 / 06.
export interface TimerService {
  /** Wire the sweep's fire callback. Called once at server startup. */
  onFire(handler: (workflowId: string, seq: number) => void): void;
  /** Record + arm a durable timer for (workflowId, seq) firing `ms` from now. */
  schedule(workflowId: string, seq: number, ms: number): void;
  /** Remove a scheduled timer that has not yet fired. */
  cancel(workflowId: string, seq: number): void;
  /** Startup sweep: re-arm (or immediately fire past-due) timers in the table. */
  recover(): void;
  /** Clear all in-flight timers (teardown). */
  stop(): void;
}

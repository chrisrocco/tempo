/**
 * @fileoverview
 * `pump` is the concurrency guard that sits between "something wants this
 * execution to make progress" (a start, or a signal arriving) and the actual
 * `drive` loop that runs workflow tasks. It is a per-target mutex combined with
 * a single coalescing "run again" flag, and it exists to prevent two specific,
 * concrete bugs. Neither is hypothetical — both fall directly out of how `drive`
 * works, so dropping `pump` reintroduces them.
 *
 * It is scoped to the in-process `LocalService`: the distributed server does not
 * have it, replacing its two jobs with a leased task queue and an optimistic
 * version check (see the "scope" note below, and doc 04 / doc 06).
 *
 * Background: why a guard is needed at all
 * ----------------------------------------
 * `drive(exec)` is async and suspends at every `await` — awaiting an activity,
 * awaiting each microtask drain inside `replay`, awaiting a child result. The
 * runtime is single-threaded, but async functions still *interleave* at those
 * suspension points. Meanwhile `drive` reads history by *snapshotting* it
 * (`rec.history.slice()`) and, once it reaches the live edge, both emits and
 * *executes* commands. Those two facts — interleaving at awaits, plus a
 * point-in-time history snapshot — are what make an unguarded `drive` unsafe.
 *
 * Job 1: mutual exclusion (never two drives for one target at once)
 * ----------------------------------------------------------------
 * If `signal()` simply called `drive(exec)` directly, a signal landing while a
 * drive was suspended would start a *second* drive that interleaves with the
 * first. Both operate on the same execution, from possibly different history
 * snapshots, and both can reach the live edge for the same command `seq` — which
 * means running the same activity twice (a real duplicated side effect) and
 * settling the result promise twice. The `if (target.running) return` guard
 * makes a competing drive impossible: a wake that arrives during a drive never
 * launches another one.
 *
 * Job 2: no lost wakeups (coalesce a mid-drive wake into one more drive)
 * ---------------------------------------------------------------------
 * This is the subtle one, and it exists *because* `drive` works off a `.slice()`
 * snapshot. Consider:
 *
 *   1. `drive` snapshots the history (no pending signal) and starts
 *      `await replay(...)`.
 *   2. During that await, a signal arrives: `signal()` appends a `signal` event
 *      to the history. But `drive` is reading its snapshot, which does not
 *      include the new event, so replay never sees it.
 *   3. Replay finishes with the workflow still parked on its `condition`
 *      (`commands.length === 0`), and `drive` returns "parked."
 *
 * The signal is now sitting in history, unprocessed, and the workflow is asleep.
 * With no re-drive it sleeps forever despite a signal that should have woken it —
 * a classic lost wakeup. `pump` closes that window: when the signal arrived at
 * step 2, `pump` saw `running === true` and set `rerun = true` rather than doing
 * nothing. After `drive` returns, the `do { … } while (rerun)` loop sees the flag
 * and drives once more; that fresh drive snapshots the *updated* history (now
 * containing the signal) and the workflow wakes. The flag turns "a change
 * happened while I was busy" into "run exactly once more when I'm done."
 *
 * Why the loop here is not redundant with drive's own loop
 * -------------------------------------------------------
 * `drive`'s internal `for (;;)` keeps going while the workflow *itself* produces
 * commands to execute (its own forward progress). `pump`'s `do…while` re-runs
 * `drive` only when an *external* wake arrived mid-flight. Different triggers, so
 * both loops are needed. The `status === 'running'` check stops the outer loop
 * from re-driving a target that already completed or failed during the last run.
 *
 * Scope and the path to a real system
 * -----------------------------------
 * `pump` only serializes within a *single* target. Different executions pump
 * concurrently, which is safe here only because they share no mutable state.
 * `pump` is the in-memory stand-in for two things a persisted, multi-worker
 * runtime needs: a real async mutex / per-workflow single-in-flight task queue
 * (Job 1), and at-least-once wake delivery without lost wakeups (Job 2). The
 * `running` boolean evaporates the moment two worker processes share a database,
 * which is why the durable version replaces it with an optimistic-locking token
 * (a version per execution; appends rejected if another worker advanced it
 * first) plus a durable task queue. Same two jobs, enforced across processes
 * instead of across `await` points in one process.
 */

/** The minimal shape `pump` coordinates over. A per-execution pump-state satisfies this. */
export interface PumpTarget {
  /** True while a `drive` loop is currently in flight for this target. */
  running: boolean;
  /** Set when a wake arrives mid-drive; requests exactly one more drive. */
  rerun: boolean;
  /** Terminal when not `'running'`; stops the pump from re-driving a settled target. */
  status: 'running' | 'completed' | 'failed';
}

/**
 * Ensure `drive(target)` runs, serialized so that at most one drive is in flight
 * for `target` at a time. If a call arrives while a drive is running, it does not
 * start a second drive — it marks the target dirty so exactly one more drive runs
 * after the current one finishes.
 *
 * @param target the per-execution object carrying the `running`/`rerun`/`status` flags
 * @param drive  the work to run; called with `target`, may suspend on awaits
 */
export function pump<T extends PumpTarget>(target: T, drive: (target: T) => Promise<void>): void {
  if (target.running) { target.rerun = true; return; }   // already draining → just mark dirty
  target.running = true;
  (async () => {
    try {
      do {
        target.rerun = false;
        await drive(target);
      } while (target.rerun && target.status === 'running');
    } finally {
      target.running = false;
    }
  })();
}

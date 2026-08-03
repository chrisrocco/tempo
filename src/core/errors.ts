/**
 * @fileoverview
 * The two failures the engine itself raises, as opposed to anything a workflow
 * throws. They are opposites in how they should be handled: one is expected and
 * catchable, the other means the engine can no longer trust what it is doing.
 */

/**
 * Thrown into workflow code when a run is cancelled: the outstanding operation
 * the workflow was awaiting (activity, timer, condition, child) rejects with it,
 * so cancellation unwinds through ordinary try/catch/finally. A workflow may catch
 * it to finish cleanly, or let it propagate and end cancelled. Re-exported from
 * the author entrypoint so workflows can catch it.
 */
export class CancelledFailure extends Error {
  constructor(message = 'cancelled') {
    super(message);
    this.name = 'CancelledFailure';
    // keep `instanceof` working when compiled down to ES5-ish targets
    Object.setPrototypeOf(this, CancelledFailure.prototype);
  }
}

/**
 * History and the workflow code disagree: an event arrived that the code, as it
 * is written now, cannot account for. Replay stops rather than guessing, because
 * every alternative is worse — resolving a promise with another operation's
 * result corrupts state silently and surfaces arbitrarily far downstream.
 *
 * **Not for workflow authors to catch.** A workflow cannot recover from its own
 * history having diverged. The fields exist so the *engine* can report the
 * divergence precisely: `seq` locates it, and the pair says what each side
 * believed. Nothing else in the system can reconstruct that after the fact — by
 * the time a human looks, the workflow code may have changed again.
 */
export class NondeterminismError extends Error {
  readonly seq: number;
  /** What the workflow did at this seq on this replay. */
  readonly expected: string;
  /** What history records at this seq. */
  readonly actual: string;

  constructor(detail: {seq: number; expected: string; actual: string}) {
    super(
      `nondeterminism at seq ${detail.seq}: history has ${detail.actual}, but the workflow ${detail.expected}`,
    );
    this.name = 'NondeterminismError';
    this.seq = detail.seq;
    this.expected = detail.expected;
    this.actual = detail.actual;
    Object.setPrototypeOf(this, NondeterminismError.prototype);
  }
}

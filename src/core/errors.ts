/**
 * @fileoverview
 * CancelledFailure is thrown into workflow code when a run is cancelled: the
 * outstanding operation the workflow was awaiting (activity, timer, condition,
 * child) rejects with it, so cancellation unwinds through ordinary try/catch/
 * finally. A workflow may catch it to finish cleanly, or let it propagate and end
 * cancelled. Re-exported from the author entrypoint so workflows can catch it.
 */

export class CancelledFailure extends Error {
  constructor(message = 'cancelled') {
    super(message);
    this.name = 'CancelledFailure';
    // keep `instanceof` working when compiled down to ES5-ish targets
    Object.setPrototypeOf(this, CancelledFailure.prototype);
  }
}

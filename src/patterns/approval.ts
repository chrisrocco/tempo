/**
 * @fileoverview
 * A human decision as a workflow step:
 *
 *     const decision = await waitForApproval({
 *       signal: 'approve-release',
 *       detail: {version: '2.4.0', notes},
 *     });
 *     if (!decision.approved) return 'declined';
 *
 * The workflow parks; whoever operates it sees *what it is waiting for* on the
 * execution's parked state; the decision arrives as a signal whose payload says
 * who made it and from where. That last part is deliberate: a client-sent
 * signal carries no provenance of its own — the engine cannot know who clicked
 * — so attribution lives in the payload, asserted by the sender, and lands in
 * history with the signal. The durable record of an approval is the signal
 * event itself.
 *
 * ## This is a convention, not engine mechanism
 *
 * Everything here is `setHandler` + `condition({awaiting})` + `clearHandler` —
 * no new context state, no new history event, no command. What the helper
 * actually contributes is the shape of `awaiting`:
 *
 *     {kind: 'approval', signal: <name>, detail: <caller's detail>}
 *
 * The engine treats that as opaque JSON. A dashboard that recognizes
 * `kind: 'approval'` has everything it needs to render the request and act on
 * it — `signal` names exactly what to send back, `detail` is whatever the
 * author wanted a human to see — and a dashboard that recognizes nothing still
 * shows an execution parked at a named site. Keeping the vocabulary here, in a
 * pattern, is what keeps it out of the engine: a second convention tomorrow is
 * a second helper, not a protocol change.
 *
 * ## One decision, first writer wins
 *
 * The handler records the first payload to arrive and the wait ends there.
 * A second decision signaled after that is not lost — it goes to the
 * pre-registration buffer once `clearHandler` runs — but nothing here reads
 * it: this helper models a gate, not a ballot. A workflow needing several
 * votes should consume the signal with `signalStream` and count.
 *
 * ## The decision is data, not control flow
 *
 * A denial returns rather than throws. Which paths are failures is the
 * workflow's call to make, and a helper that threw on `approved: false` would
 * be deciding it — turning the most ordinary outcome of asking a human into an
 * error path, and pushing every caller into try/catch as branching syntax.
 */

import {condition} from '../core/condition';
import {clearHandler, setHandler, type SignalDef} from '../core/signals';

export interface ApprovalRequest {
  /**
   * The signal the decision must arrive on. The name is published in
   * `awaiting.signal`, so it is also the address a dashboard sends to — make it
   * unique within the workflow if several approvals can be outstanding at once.
   */
  signal: SignalDef | string;
  /**
   * What is being approved, for the human being asked. Free-form JSON,
   * published verbatim as `awaiting.detail`; the engine and this helper never
   * read it. Keep it a description — it is stored on every task the wait
   * survives, and capped with the rest of `awaiting` (`MAX_AWAITING_BYTES`).
   */
  detail?: unknown;
}

/**
 * The suggested decision payload. An assertion, not a check: like every signal
 * payload it crossed the wire as JSON, and the sender's honesty is the only
 * authority behind the attribution fields. `waitForApproval` resolves with
 * whatever arrived; type it yourself (`waitForApproval<MyDecision>`) when your
 * dashboard sends a richer shape.
 */
export interface ApprovalDecision {
  approved: boolean;
  /** Who decided — an email, a username, whatever identity the sender has. */
  approvedBy?: string;
  /** Where the decision was made: 'dashboard', 'cli', an automation's name. */
  via?: string;
  /** Anything the approver wanted to say about it. */
  note?: string;
}

/**
 * Park until a decision arrives on `request.signal`, advertising the wait on
 * the execution's parked state, and resolve with the decision's payload.
 */
export async function waitForApproval<D = ApprovalDecision>(
  request: ApprovalRequest,
): Promise<D> {
  const name =
    typeof request.signal === 'string' ? request.signal : request.signal.name;
  let decision: D | undefined;
  let decided = false;
  // A flag beside the value, not `decision !== undefined`: a payload is JSON
  // from the wire, and `undefined` — while a sender's bug — must end the wait
  // rather than hang it.
  setHandler({name}, (payload: D) => {
    if (decided) return; // first writer wins; see the fileoverview
    decision = payload;
    decided = true;
  });
  try {
    await condition(() => decided, {
      awaiting: {
        kind: 'approval',
        signal: name,
        ...(request.detail === undefined ? {} : {detail: request.detail}),
      },
    });
  } finally {
    // On resolution and on cancellation alike: give the name back, so a later
    // wait on the same signal registers cleanly instead of being displaced.
    clearHandler({name});
  }
  return decision as D;
}

/**
 * @fileoverview
 * What happens to a child workflow when the execution that started it closes.
 *
 * A child outlives the *task* that spawned it by design — that is what makes it a
 * separate execution rather than a function call. What it should do when its
 * parent finishes has no answer the engine can pick for everyone: a poller
 * started to feed its parent is garbage the moment the parent is gone, while a
 * fire-and-forget follow-up job is started precisely so that it will outlive the
 * thing that queued it. So it is a per-child choice, recorded at dispatch, the
 * same shape Temporal's `ParentClosePolicy` has.
 *
 * ## The three, and what each guarantees
 *
 * - **`terminate`** — end the child outright. The **default**, matching Temporal.
 *   It is the only one that *guarantees* the child stops: cancellation is
 *   cooperative, so a child that catches `CancelledFailure` and carries on cannot
 *   be stopped by asking. The cost is that the child gets no chance to clean up,
 *   which is the same cost `terminate` carries everywhere else in this engine.
 * - **`cancel`** — request cancellation and let the child unwind through its own
 *   `try`/`finally`. The right choice when the child holds something that needs
 *   releasing, and the wrong one when it might decline. Temporal spells this
 *   `REQUEST_CANCEL`; the shorter name matches the vocabulary the rest of this
 *   surface already uses (`handle.cancel()`, `client.cancel`).
 * - **`abandon`** — leave it running. What the engine did unconditionally before
 *   this existed, and still the right answer for a child deliberately started to
 *   outlive its parent.
 *
 * ## Closing is not cancelling
 *
 * This governs what happens when a parent **finishes** — completes, fails, or is
 * terminated. It does not govern what happens when a parent is **cancelled**,
 * which already cascades to every child regardless of policy and continues to.
 *
 * The distinction is worth holding onto, because "abandon" sounds like it should
 * cover both. Cancelling a parent says *stop this work*, and a subtree of it is
 * still that work; a child started to outlive a completed parent is not thereby a
 * child that should survive the work being called off. Reading `abandon` as
 * "nothing my parent does ever reaches me" would make the one explicit way to
 * stop a whole tree quietly incomplete.
 *
 * A rollover is not a close either: `continueAsNew` keeps its children by design
 * (see `server_core`), and no policy fires on it.
 *
 * ## Where the choice is remembered
 *
 * On the `childStarted` marker, not only on the command. The process that closes
 * a parent need not be the one that dispatched its children, and may be running
 * different code — so the policy in force is the one recorded when the child was
 * started, and editing the option in the workflow's source does not retroactively
 * change what already-dispatched children do.
 */

/** What to do with a child when its parent closes. See the module comment. */
export type ParentClosePolicy = 'terminate' | 'cancel' | 'abandon';

/**
 * What a child gets when none is named: `terminate`, as in Temporal.
 *
 * The alternative — keeping the old unconditional `abandon` as the default —
 * would have been the compatible choice, and was rejected for what it hides. An
 * abandoned child is invisible: nothing lists it as orphaned, nothing alerts on
 * it, and the shape most likely to be abandoned is the infinite poller, which
 * goes on polling a source nobody reads while holding a claimed workflow id. A
 * wrongly terminated child, by contrast, is *loud* — it shows as `terminated` in
 * `tempo list` with the reason on the record.
 *
 * Choosing the failure that announces itself over the one that accumulates
 * silently is the same trade the poison-task policy makes in `server_core`.
 */
export const DEFAULT_PARENT_CLOSE_POLICY: ParentClosePolicy = 'terminate';

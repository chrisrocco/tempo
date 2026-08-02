/**
 * @fileoverview
 * ★ ACTIVITY ENTRYPOINT — what activity code imports.
 *
 * The third kind of user code, alongside workflows (`workflow.ts`) and hosts
 * (`index.ts`). An activity is an ordinary async function and needs nothing from
 * here to work; this exists for the few things that only mean something *while an
 * activity is running*.
 *
 * The separation is the point rather than tidiness. `heartbeat()` exported from
 * the host entrypoint would invite calling it from a workflow, where it is
 * meaningless — workflow code is replayed, and a heartbeat is a statement about
 * wall-clock liveness. Keeping it here says which side of the determinism
 * boundary it belongs to, the same way `workflow.ts` says what a workflow may
 * reach.
 *
 * Activities are, by contrast, deliberately unconstrained: this is where I/O
 * lives, so there is no purity rule to enforce and no equivalent of the
 * author-entrypoint check. Importing from here is a convenience, not a boundary.
 */

export { heartbeat } from './worker/activity_context';

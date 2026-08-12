/**
 * @fileoverview
 * `applyEvent` routes one recorded history event back into the in-memory promise
 * it belongs to. Signals fan out to their handler (or buffer if none is
 * registered yet); every other event completes the parked promise keyed by its
 * `seq`. This is also where the engine checks that history and code still agree —
 * all three of those checks live here, including the one that is not about an
 * individual event (`assertHistoryAccounted`, at the bottom).
 *
 * ## Three divergence checks, catching different failures
 *
 * **A completion for an unknown seq** — nothing is parked on it — means history
 * has an operation the code no longer has. That check has always been here.
 *
 * **A marker that disagrees with the command issued at its seq** catches the case
 * the first one cannot see. Correlation is by `seq`, assigned in call order, so
 * two concurrent branches that merely *swap order* produce seqs that are both
 * parked and both resolve — each with the other's result. No error, a string where
 * a number was expected, and the first symptom arbitrarily far downstream. Markers
 * already record what was dispatched; comparing them against what the workflow
 * asked for at that seq turns that silent corruption into a stopped replay.
 *
 * Coverage is deliberately partial, and worth knowing precisely:
 *
 * | Command            | Marker                  | Checked                        |
 * | ------------------ | ----------------------- | ------------------------------ |
 * | `scheduleActivity` | `activityScheduled`     | type + **name**                |
 * | `startTimer`       | `timerStarted`          | type only (`fireAt` absolute)  |
 * | `startChild`       | `childStarted`          | type + **`detached`**          |
 * | `cancelChild`      | `childCancelRequested`  | type + **`targetSeq`**         |
 * | `signalWorkflow`   | `workflowSignaled`      | type + **target + name**       |
 * | `recordPatch`      | `patchRecorded`         | type + **`patchId`**           |
 *
 * So a swap between two same-named activities with different arguments still
 * slips through; argument comparison is expensive on large payloads and risks
 * false positives on serialization differences, so it is deliberately out.
 *
 * `parentClosePolicy` is out too, and for a different reason worth separating
 * from that one. It *is* cheap to compare — but the marker is the copy that
 * governs (`server_core.closeChildren` reads history, never the replayed
 * command), so a policy that differs on this replay changes nothing about what
 * happens. Checking it would turn editing an option in the source into a
 * nondeterminism error on every in-flight execution, in exchange for catching a
 * divergence with no consequence. Contrast `detached`, which is checked because
 * it decides whether a completion is coming back.
 *
 * Every command now leaves a marker. `cancelChild` was the exception until issue
 * #50, on the grounds that its effect is already durable on the child — true, and
 * beside the point once replay began deciding suppression by asking whether
 * history holds a seq. A command with no marker cannot answer that question, which
 * is what left it silently droppable.
 *
 * **Absence is not divergence.** A marker whose seq the workflow never issued is
 * skipped rather than rejected. The check is about *disagreement*; treating
 * silence as a mismatch would fail correct workflows in the cancellation window,
 * where a run stops allocating seqs the moment `cancelRequested` is applied.
 *
 * ## Absence is not divergence — until the run says it is finished
 *
 * That last paragraph is right about *when an event is applied* and it left a real
 * failure uncovered, which is the third check below (`assertHistoryAccounted`).
 *
 * A run that stops short of a seq history holds a marker for is, mid-flight,
 * indistinguishable from a correct one: it may simply not have got there yet, and
 * the cancellation window is a case where it never will and should not. But a run
 * that **declares itself done** has made that absence permanent and load-bearing.
 * History says an activity was dispatched and is still running; the workflow
 * returns; the execution is settled on the strength of a replay that never issued
 * it. The activity is orphaned, the result is wrong, and nothing is raised — the
 * event that would have disagreed with the code was never applied, so the two
 * per-event checks above never look at it.
 *
 * That is not a hypothetical. It is the measured failure on issue #52: replayed
 * under changed replay semantics, an execution whose second stage had *completed*
 * threw `NondeterminismError` at seq 1, while the same execution with that stage
 * still in flight completed with `done=true`, `result="abandoned"`, zero commands
 * and no error. The loud case was the lucky one — and it was lucky twice over,
 * because it was loud only under a driver that applies a whole batch before running
 * the workflow. Under *this* loop, which stops the instant the workflow settles,
 * neither of those two lines throws on its own: the events that would have objected
 * are never reached. The check below is what makes the half that orphans work loud
 * under either driver.
 *
 * So the rule the two halves share, stated once: **an unaccounted seq is a
 * question until the run settles, and an answer once it does.** Absence stays
 * legitimate while the run is still parked — it may yet reach that seq, and a
 * cancelled run deliberately will not — and becomes a divergence at the moment the
 * run commits to an outcome that cannot be revised. The check is deliberately not
 * extended to a parked run: a run wedged before a seq it should have reached is
 * already counted, bounded and reported as a stuck execution (adoption blocker 2),
 * whereas a settled one has escaped that machinery entirely by looking successful.
 */

import type {Command, CompletionEvent, HistoryEvent} from '../protocol';
import type {WorkflowContext} from './context';
import {CancelledFailure, NondeterminismError} from './errors';

/** How a command reads in an error message. */
function describeCommand(cmd: Command): string {
  if (cmd.type === 'scheduleActivity') return `scheduleActivity ${cmd.name}`;
  if (cmd.type === 'startChild')
    return `startChild${cmd.detached ? ' (detached)' : ''}`;
  if (cmd.type === 'cancelChild') return `cancelChild of seq ${cmd.targetSeq}`;
  if (cmd.type === 'startWorkflow')
    return `startWorkflow ${cmd.name} as ${cmd.targetId}`;
  if (cmd.type === 'signalWorkflow')
    return `signalWorkflow ${cmd.signalName} to ${cmd.targetId}`;
  if (cmd.type === 'recordPatch') return `patched ${cmd.patchId}`;
  return cmd.type;
}

/**
 * Compare a marker against the command recorded at its seq. Returns the mismatch
 * as a message, or undefined when they agree — the caller owns the throw so the
 * event's own description is built in one place.
 */
function markerMismatch(
  ev: HistoryEvent & {seq: number},
  cmd: Command,
): string | undefined {
  if (ev.type === 'activityScheduled') {
    if (cmd.type !== 'scheduleActivity' || cmd.name !== ev.name)
      return describeCommand(cmd);
    return undefined;
  }
  if (ev.type === 'timerStarted')
    return cmd.type === 'startTimer' ? undefined : describeCommand(cmd);
  if (ev.type === 'childCancelRequested') {
    // `targetSeq` is the whole content of a cancel, and it is a claim about the
    // workflow's own logic: which spawn this call meant. A different one on this
    // replay means that logic has moved, and the parent would cancel a child it
    // never meant to while the intended one runs on.
    if (cmd.type !== 'cancelChild' || cmd.targetSeq !== ev.targetSeq)
      return describeCommand(cmd);
    return undefined;
  }
  if (ev.type === 'workflowSignaled') {
    // Both halves are the workflow's own logic — who to tell, and what to tell
    // them — and neither is derived by the engine. A replay that picks a
    // different target sends a message to a workflow that was never meant to have
    // it while the intended one waits, and a different name is a message the
    // target has no handler for. Both are silent: nothing parks on a signal it
    // sent, so there is no waiter to notice.
    if (
      cmd.type !== 'signalWorkflow' ||
      cmd.targetId !== ev.targetId ||
      cmd.signalName !== ev.signalName
    )
      return describeCommand(cmd);
    return undefined;
  }
  if (ev.type === 'workflowStarted') {
    // Both fields are the workflow's own logic and neither is derived, so both are
    // checkable — unlike `childStarted`, whose id may have been the engine's to
    // invent. The id is the sharper of the two: it is the dedup key, so a replay
    // that computes a different one starts a second execution of work history says
    // was already started, and nothing notices. An independent start threads no
    // completion back, so there is no waiter to wedge and no result to come out
    // wrong — the duplicate simply runs.
    if (cmd.type !== 'startWorkflow' || cmd.targetId !== ev.targetId)
      return describeCommand(cmd);
    if (cmd.name !== ev.name) return `startWorkflow ${cmd.name}`;
    return undefined;
  }
  if (ev.type === 'patchRecorded') {
    // The id is the whole content of the marker, and comparing it is what makes a
    // patch retired the wrong way loud. Deleting `if (patched('x'))` without
    // leaving a `deprecatePatch('x')` behind means this seq — which history has
    // pinned to a version decision — is handed to whatever command comes next, and
    // every seq after it shifts by one. Presence-only checking would accept that.
    if (cmd.type !== 'recordPatch' || cmd.patchId !== ev.patchId)
      return describeCommand(cmd);
    return undefined;
  }
  if (ev.type === 'childStarted') {
    if (cmd.type !== 'startChild' || cmd.detached !== ev.detached)
      return describeCommand(cmd);
    // An id the workflow chose is checkable in a way a derived one is not: it
    // came from the workflow's own logic, so a different one on this replay
    // means that logic has moved. Left unchecked the parent would go on awaiting
    // the child history names while believing it started another.
    if (cmd.workflowId !== undefined && cmd.workflowId !== ev.childId)
      return `startChild ${cmd.workflowId}`;
    return undefined;
  }
  return undefined;
}

/**
 * How a recorded event reads in an error message. Markers name what they
 * dispatched; the completions fall through to their bare type, which is all
 * `assertHistoryAccounted` needs of them.
 */
function describeEvent(ev: HistoryEvent): string {
  if (ev.type === 'activityScheduled') return `activityScheduled ${ev.name}`;
  if (ev.type === 'childStarted')
    return `childStarted ${ev.childId}${ev.detached ? ' (detached)' : ''}`;
  if (ev.type === 'workflowStarted')
    return `workflowStarted ${ev.name} as ${ev.targetId}`;
  if (ev.type === 'childCancelRequested')
    return `childCancelRequested of seq ${ev.targetSeq}`;
  if (ev.type === 'workflowSignaled')
    return `workflowSignaled ${ev.signalName} to ${ev.targetId}`;
  if (ev.type === 'patchRecorded') return `patchRecorded ${ev.patchId}`;
  return ev.type;
}

export function applyEvent(ctx: WorkflowContext, ev: HistoryEvent): void {
  if (ev.type === 'signal') {
    const h = ctx.signalHandlers.get(ev.name);
    if (h) h(ev.payload);
    else ctx.bufferedSignals.push(ev);
    return;
  }
  if (
    ev.type === 'activityScheduled' ||
    ev.type === 'timerStarted' ||
    ev.type === 'childStarted' ||
    ev.type === 'workflowStarted' ||
    ev.type === 'childCancelRequested' ||
    ev.type === 'workflowSignaled' ||
    ev.type === 'patchRecorded'
  ) {
    // Markers resolve nothing — their presence in history is what keeps replay
    // from re-dispatching the command. They are, however, the record of what was
    // dispatched, so this is the one chance to notice the code has moved.
    const cmd = ctx.requested.get(ev.seq);
    const mismatch = cmd && markerMismatch(ev, cmd);
    if (mismatch)
      throw new NondeterminismError({
        seq: ev.seq,
        expected: `issued ${mismatch}`,
        actual: describeEvent(ev),
      });
    return;
  }
  if (ev.type === 'cancelRequested') {
    // Cancellation propagates: mark the run cancelled and reject everything it is
    // currently awaiting with CancelledFailure. New operations reject on creation
    // (see workflow_api / condition). The workflow unwinds via normal try/catch.
    ctx.cancelled = true;
    const err = new CancelledFailure();
    for (const waiter of ctx.completions.values()) waiter.reject(err);
    ctx.completions.clear();
    for (const cond of ctx.blockedConditions.values()) cond.reject(err);
    ctx.blockedConditions.clear();
    return;
  }
  // ev is now a CompletionEvent — guaranteed to carry a seq
  const waiter = ctx.completions.get(ev.seq);
  if (!waiter)
    throw new NondeterminismError({
      seq: ev.seq,
      expected: 'is not awaiting that seq',
      actual: ev.type,
    });
  ctx.completions.delete(ev.seq);
  if (ev.type === 'activityFailed' || ev.type === 'childFailed')
    waiter.reject(failureError(ev));
  else if (ev.type === 'timerFired') waiter.resolve(undefined);
  else waiter.resolve(ev.result);
}

/**
 * Rebuild the error a failed activity or child hands back to workflow code.
 *
 * The recorded stack is assigned unconditionally — **including when there is
 * none**. The stack this Error is born with describes *replay*: frames inside
 * apply_event, in a different process from the failure, re-derived on every
 * re-run. That is worse than no stack at all, because it looks like one while
 * pointing at the engine rather than at the line that threw, and it would be
 * stored and printed as though it were the origin. So an origin without a stack
 * (a thrown non-Error) yields an error without one, which is the honest answer.
 *
 * Determinism is unaffected: the value comes out of history, so every replay
 * reconstructs the same error.
 */
function failureError(ev: {error: string; stack?: string}): Error {
  const error = new Error(ev.error);
  error.stack = ev.stack;
  return error;
}

/**
 * Markers for work that is owed something back — a result, a firing.
 *
 * The same three kinds `server/pending_work.ts` reports as outstanding, and that is
 * not a coincidence to be tidied away: both modules are asking about *dispatched
 * work that has not finished*, from opposite ends. That one says what the execution
 * is waiting on; this one says whether the code still knows it is. They cannot share
 * the derivation — `core/` may import only `protocol/`, and putting a rule the
 * engine needs behind the server would be the wrong direction for the rule as well
 * as for the import — so the shared fact is the marker invariant in `protocol/`,
 * which both read.
 *
 * A detached child is included even though no completion is ever coming for it. It
 * is running work, and a parent that no longer issues its `startChild` cannot
 * `cancelChild` it either — `cancelChild` names the spawning seq, and that seq is
 * now something else's.
 *
 * `workflowStarted` is **excluded**, and the contrast is the point rather than an
 * inconsistency. What makes an unreached `childStarted` a problem is that the seq was
 * the only handle on the child; an independent execution was never addressable by seq
 * to begin with — it is reached by an id the workflow's own logic computed, which a
 * settling run does not invalidate. Including it would fire on precisely the case the
 * command exists for: a scheduler that stops starting a run it once started has not
 * orphaned it, because the run was never the scheduler's to hold. A seq that comes
 * back as something *else* is still caught, by `markerMismatch` above.
 */
function dispatchesWork(ev: HistoryEvent): ev is HistoryEvent & {seq: number} {
  return (
    ev.type === 'activityScheduled' ||
    ev.type === 'timerStarted' ||
    ev.type === 'childStarted'
  );
}

/** The events that close a dispatch, so the seq is owed nothing further. */
function completesWork(ev: HistoryEvent): ev is CompletionEvent {
  return (
    ev.type === 'activityCompleted' ||
    ev.type === 'activityFailed' ||
    ev.type === 'timerFired' ||
    ev.type === 'childCompleted' ||
    ev.type === 'childFailed'
  );
}

/**
 * The third check: a run that settles must account for every piece of dispatched
 * work history says is still outstanding.
 *
 * Called once, by `replay`, after the event loop has finished. Where the two checks
 * above compare an event against the command at its seq, this one asks the question
 * neither of them can — **is there work history recorded as dispatched, and not yet
 * finished, that this replay never issued a command for?** — and it is answerable
 * only at the end, because the evidence is the events the run never reached.
 *
 * An unaccounted outstanding seq is an activity running right now, a timer armed, or
 * a child executing, with nothing in the code as written today that will ever hear
 * from it. Settling the execution anyway publishes a result computed without it and
 * orphans it, silently. Raising instead makes it a workflow-task failure, which is
 * what the whole poison-task path is built for — counted, backed off, named in
 * `Client.describe()`, and **recoverable by redeploying corrected workflow code**,
 * because nothing durable has been written. The wrong answer would not have been
 * recoverable.
 *
 * ## Three exclusions, and why each is not a hole
 *
 * - **A parked run.** It has committed to nothing, so there is nothing yet to be
 *   wrong about, and mid-flight absence is the legitimate case the module comment
 *   above defends.
 * - **A cancelled run.** Cancellation *is* the sanctioned way to stop allocating
 *   seqs mid-run: `cancelRequested` rejects everything outstanding, and every later
 *   primitive rejects on creation, so an unwinding run legitimately never reaches
 *   seqs its history holds.
 * - **Work that already finished.** A seq whose completion is in history orphans
 *   nothing: the effect happened, and a run that no longer consumes its result has
 *   ignored a value rather than abandoned a job. It is also the one shape a
 *   *correct* workflow reaches without any code change at all —
 *   `continueAsNewSuggested` is a server-provided input that flips partway through a
 *   run, so `while (!workflowInfo().continueAsNewSuggested)` legitimately runs fewer
 *   iterations on a later task than it did on an earlier one, leaving completed
 *   activities behind it. Checking those would fail that workflow, and the failure
 *   would be a genuine one to fix in the checker rather than in the workflow.
 *
 *   Note what the exclusion does *not* extend to: the same hint flipping while an
 *   activity is still in flight, so the loop exits with work outstanding. That is
 *   caught, and rightly — rolling over mid-reconciliation abandons the activity, and
 *   `WorkflowInfo.continueAsNewSuggested` already says to act on the hint at a clean
 *   checkpoint. The task failure retries, and the retry that sees the completion
 *   passes.
 *
 * Reported at the **earliest** unaccounted seq, by walking `events` in order: that is
 * where the two versions of the code parted company, and everything after it is
 * downstream of that. Two passes over history, on the last replay of an execution's
 * life.
 */
export function assertHistoryAccounted(ctx: WorkflowContext): void {
  if (!ctx.done && !ctx.failed) return;
  if (ctx.cancelled) return;
  const finished = new Set<number>();
  for (const ev of ctx.events) if (completesWork(ev)) finished.add(ev.seq);
  for (const ev of ctx.events) {
    if (!dispatchesWork(ev)) continue;
    if (finished.has(ev.seq) || ctx.requested.has(ev.seq)) continue;
    throw new NondeterminismError({
      seq: ev.seq,
      expected: 'settled without ever issuing it',
      actual: describeEvent(ev),
    });
  }
}

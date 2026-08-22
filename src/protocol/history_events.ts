/**
 * @fileoverview
 * Recorded history is the durable log a workflow is replayed against. Every
 * event either completes a command (and is keyed by that command's `seq`) or is
 * an externally injected signal (which is not tied to a command, so has no seq).
 * Keeping those two families in separate unions lets `applyEvent` narrow with a
 * single `type === 'signal'` check instead of hunting for the seq-bearing ones.
 *
 * A third family sits between them: **markers**, which carry a seq but complete
 * nothing. They record that a command was dispatched, which is what stops replay
 * dispatching it twice and what crash recovery rebuilds pending work from. Every
 * command leaves one (see `server_core`), so they are not a union worth naming —
 * but they are the reason "has a seq" and "completes something" are different
 * questions.
 *
 * `patchRecorded` is the one marker that does not record a dispatch. It records a
 * *decision* the workflow made — which side of a version branch it took — and it is
 * the only event here that workflow code reads back. It is still a marker in the
 * sense that matters: it holds a seq, it completes nothing, and its presence is what
 * keeps replay from re-deciding.
 *
 * A fourth family completes nothing *and* suppresses nothing: **informational**
 * events, written for whoever reads the execution later rather than for replay.
 * `activityStarted`, `activityRetryScheduled`, `conditionParked` and
 * `conditionUnparked` are these. Three properties separate them from markers, and
 * `applyEvent` depends on all three: nothing on replay resolves or is suppressed by
 * them, several may share one key, and their absence from a history written before
 * they existed is not a divergence. They exist because an engine whose value is
 * answering "what happened" should not leave its two commonest waiting states —
 * a backoff gap and a parked condition — as blanks between events.
 */

import type {ActivityOptions} from './activity_options';
import type {ParentClosePolicy} from './parent_close_policy';

/**
 * What every recorded event carries, whatever kind it is.
 *
 * `ts` is stamped by the server at the moment the event is appended, once, and
 * is thereafter part of the durable record — so replaying the same history
 * yields the same timestamps, and nothing derived from it can diverge. It is the
 * server's clock, not any worker's: workers are stateless and interchangeable,
 * and their clocks are not.
 *
 * Optional because histories written before this field existed have none.
 * Readers must treat a missing `ts` as "unknown", never as zero — an execution
 * that predates this change is not one that happened in 1970.
 *
 * **Deliberately not exposed to workflow code.** A recorded timestamp is
 * deterministic, so a `workflow.now()` built on it would be sound, but that is a
 * primitive with its own design (which event's clock does a bare `now()` read?)
 * rather than a field to reach through `applyEvent` for.
 */
export interface HistoryEventBase {
  /** Epoch milliseconds, from the server, at append time. */
  ts?: number;
}

/** Fields common to events that complete a specific command. */
export interface CompletionEventBase extends HistoryEventBase {
  /** The seq of the command this event completes. */
  seq: number;
}

export interface ActivityCompletedEvent extends CompletionEventBase {
  type: 'activityCompleted';
  result: unknown;
}

export interface ActivityFailedEvent extends CompletionEventBase {
  type: 'activityFailed';
  error: string;
  /**
   * The activity's own stack, from the worker process that ran it. Optional
   * because history written before this field existed has none, and because a
   * thrown non-Error has none to take.
   */
  stack?: string;
}

export interface TimerFiredEvent extends CompletionEventBase {
  type: 'timerFired';
}

/**
 * `childId` is denormalized onto both child outcomes even though the same
 * `seq` already appears on the `childStarted` that dispatched it.
 *
 * Not redundancy: history is *paged* (see `MAX_HISTORY_PAGE`), and a child that
 * ran for a while has its dispatch and its outcome hundreds of events apart. A
 * reader holding one page can pair them only if both carry the id, so without
 * this a failed child is a row saying "child failed" with no way to reach the
 * child — which is exactly the case that most needs reaching, since a failed
 * child permanently burns its workflow id and is never retried.
 *
 * Optional because histories written before this field existed have none.
 * Readers must treat a missing `childId` as "unknown", never as absent — the
 * child existed either way.
 */
export interface ChildCompletedEvent extends CompletionEventBase {
  type: 'childCompleted';
  result: unknown;
  /** The child's workflow id — see the note above. */
  childId?: string;
}

export interface ChildFailedEvent extends CompletionEventBase {
  type: 'childFailed';
  error: string;
  /** The child's workflow id — see the note above. */
  childId?: string;
}

/**
 * Marker: an activity has been dispatched (before it runs). Carries the command's
 * seq but is NOT a completion — it resolves nothing on replay. Its jobs: record
 * "scheduled before running" for crash-recovery idempotency, and advance history
 * past the command so a re-emitted `scheduleActivity` isn't re-dispatched. It also
 * carries the dispatch payload (name/args/options) so a resumed process can
 * re-enqueue the task from history alone. Markers do double duty: they stop a
 * re-emitted command from re-dispatching, and they are the "scheduled before
 * running" record crash recovery reconstructs from.
 */
export interface ActivityScheduledEvent extends HistoryEventBase {
  type: 'activityScheduled';
  seq: number;
  name: string;
  args: unknown[];
  options: ActivityOptions;
}

/**
 * A worker took an activity task and the attempt began.
 *
 * Not a marker, and the distinction matters: `activityScheduled` is written by the
 * engine to stop a re-emitted command from re-dispatching, whereas this is written
 * for whoever is *looking* at the execution later. Nothing on replay depends on it,
 * nothing is suppressed by it, and its absence from an older history is not a
 * divergence.
 *
 * ## What it is for
 *
 * Without it the only two activity timestamps are `activityScheduled.ts` and the
 * completion's, so every reader — timeline, dashboard, operator — sees one span that
 * silently conflates **queue time** with **execution time**. Those have opposite
 * remedies: queue time says the worker pool is saturated, execution time says the
 * activity is slow. That distinction is what makes "a worker process runs one
 * activity at a time" (issue #44) measurable rather than a suspicion.
 *
 * ## One per attempt, and that is the point
 *
 * **Several of these can share one `seq`** — this is the only event type of which
 * that is true, so code reading history by seq must not assume uniqueness. A retried
 * activity is picked up more than once, and each pickup appends one.
 *
 * That reverses part of an earlier decision, deliberately. `server_core` argued
 * against per-attempt events on history-bloat grounds, which kept attempt counts in
 * mutable state and left retries invisible in the log: a span over a retried
 * activity covered every attempt *and* every backoff gap, indistinguishably. The
 * trade is now the other way round — storage is cheap, and an engine whose whole
 * value is answering "what happened" should not economise on the answer. The reasoning
 * at `ServerCore.failWorkflowTask` was updated rather than left contradicting this.
 */
export interface ActivityStartedEvent extends HistoryEventBase {
  type: 'activityStarted';
  /** The `scheduleActivity` seq this attempt is for. Not unique across events — see above. */
  seq: number;
  /**
   * The worker that took it, when it named itself.
   *
   * Optional because `identity` is optional on the poll. Free to carry — the server
   * already has it — and it answers a question nothing else in history can: *which*
   * process ran this attempt, which is where a fleet running mixed code shows itself
   * (issue #65).
   */
  identity?: string;
}

/**
 * An attempt failed and another is due — the gap between two `activityStarted`s.
 *
 * ## What it is for
 *
 * `activityStarted` made attempts legible; it did not make the *space between*
 * them legible. A started attempt with no completion after it means one of two
 * opposite things — the attempt is running right now, or it failed and the seq is
 * idle until its backoff expires — and history had no way to say which. Every
 * reader therefore painted a retrying activity as busy, which is the reading most
 * likely to be wrong and the least likely to prompt anyone to look.
 *
 * `PendingActivityView.nextAttemptAt` answers this, and is deliberately not
 * enough. It is *live* state: it exists while a backoff is outstanding and is
 * cleared when the activity settles. So the question is answerable about an
 * execution retrying right now and unanswerable about one that retried an hour
 * ago — and the second is what a timeline is, a reconstruction from events alone.
 *
 * ## The reversal, named
 *
 * `ServerCore.reportActivityResult` argued that what stays out of history is "a
 * second event per *failure*". This is that event, and the reasoning it displaces
 * was narrower than it looked rather than wrong: the bloat is bounded by
 * `maximumAttempts`, a number the author chose, so a policy allowing five attempts
 * admits at most four of these. The argument was written against an unbounded
 * per-failure stream. What the attempt counter it defended does is answer the same
 * question *live*, which is the half that was never in dispute.
 *
 * `error` is here because it is otherwise destroyed. `activityFailed` records the
 * *final* failure; each earlier one overwrites the last in the attempt counter, so
 * an activity that failed three different ways before succeeding keeps none of
 * them — and a flap's first failure is usually the one that explains it.
 */
export interface ActivityRetryScheduledEvent extends HistoryEventBase {
  type: 'activityRetryScheduled';
  /**
   * The `scheduleActivity` seq. Not unique across events, for the same reason
   * `activityStarted` is not: a retried activity produces one of each per round.
   */
  seq: number;
  /**
   * The attempt that **failed**, counting from 1.
   *
   * Deliberately the opposite convention from `PendingActivityView.attempt`, which
   * is the attempt about to *run*. Both are right for what they describe — an event
   * records something that happened, a pending view claims what is next — and the
   * pair is exactly the off-by-one that type's own doc warns about. `attempt + 1`
   * is what runs next.
   */
  attempt: number;
  /** How many the policy allows in all, so a reader need not join to the dispatch. */
  maxAttempts: number;
  /** When the next attempt is due, epoch ms. */
  nextAttemptAt: number;
  /**
   * Why this attempt failed.
   *
   * A message and no stack, which is the one economy taken here: a stack per
   * failed attempt is the part that would actually grow, and the final failure —
   * the one most likely to be opened — keeps its stack on `activityFailed`.
   */
  error: string;
}

/**
 * Marker: a timer has been started. Records the absolute `fireAt` so a resumed
 * process re-arms it from history (past-due timers fire at once) — history stays
 * the single source of truth for time, so a workflow's sense of "now" is never
 * read from the host clock at replay. Not workflow-visible; `sleep`
 * still resolves on the `timerFired` completion.
 */
export interface TimerStartedEvent extends HistoryEventBase {
  type: 'timerStarted';
  seq: number;
  fireAt: number;
}

/**
 * Marker: a child workflow has been started. Same role as `activityScheduled` —
 * records the dispatch for recovery and advances history past the `startChild`
 * command so replay doesn't re-launch it.
 *
 * Recorded for **both** kinds of child, because both are dispatched work and the
 * marker invariant is about dispatch, not about completion (see `server_core`).
 * `detached` says which kind, and that is the only thing downstream needs it for:
 * a blocking child's completion arrives later as a `childCompleted` /
 * `childFailed` keyed by the same seq, while a detached child never reports back
 * at all. Recovery must not synthesize a completion for one that is never coming.
 */
export interface ChildStartedEvent extends HistoryEventBase {
  type: 'childStarted';
  seq: number;
  childId: string;
  /** true = fire-and-forget (`startChild`); false = blocking (`executeChild`). */
  detached: boolean;
  /**
   * What becomes of this child when its parent closes — see
   * `parent_close_policy.ts`.
   *
   * Recorded here rather than only held in memory because the process that closes
   * a parent need not be the one that started its children: `resumeFromHistory`
   * rebuilds the child map from these events, and it must rebuild the policies
   * with them or a restart would quietly turn every child into an abandoned one.
   *
   * **Optional, and absent means `abandon`** — not the default. That is a
   * deliberate exception to how the other optional fields here read. A missing
   * `ts` or `childId` is a fact the writer *had* and did not record, so a reader
   * treats it as unknown; a missing policy is a child dispatched before policies
   * existed, when the engine unconditionally left children running. Absent
   * therefore records what the engine actually did, which means deploying this
   * change cannot alter what an already-dispatched child does.
   */
  parentClosePolicy?: ParentClosePolicy;
}

/**
 * Marker: a cancel has been requested for a detached child. Same role as the
 * markers above — it records the dispatch so replay does not re-request. It is
 * the command whose marker looks skippable, because a cancel's durable record
 * already exists on the *child*; `server_core`'s header owns why that is not
 * enough, and why every command leaves a marker here instead.
 *
 * Written **after** the cancel is dispatched, as `childStarted` is. Nothing
 * re-drives a cancel on restart, so replay re-emitting the command is its only
 * recovery, and a marker written first is precisely what would suppress it.
 * `server_core`'s header owns that argument too, and is honest about how much of
 * the marker-ordering split is actually forced.
 */
export interface ChildCancelRequestedEvent extends HistoryEventBase {
  type: 'childCancelRequested';
  seq: number;
  /** The seq of the `startChild` whose child this cancels. */
  targetSeq: number;
}

/**
 * Marker: an independent execution was started from workflow code. Same role as
 * `childStarted` — it records the dispatch so replay does not start a second one —
 * and deliberately not the same event, because the two record different things.
 *
 * `childStarted` records a *relationship*: it carries `detached` and its seq is what
 * `cancelChild` addresses, because a child is something the starter can still act on.
 * This records only that a start happened, since an independent execution is not
 * reachable from the starter by anything but its id. Reusing `childStarted` with a
 * flag would have put a parent link in history for an execution that has none, and
 * `closeChildren` reads that history.
 *
 * Written **after** the launch, as `childStarted` is, and safe for the same reason:
 * a claimed id that already exists correlates rather than starting a second
 * execution, so a replayed command is idempotent. Marker-first would suppress the
 * only recovery a crash between the two has.
 */
export interface WorkflowStartedEvent extends HistoryEventBase {
  type: 'workflowStarted';
  seq: number;
  /** The execution that was started. Always a workflow-chosen id — see `StartWorkflowCommand`. */
  targetId: string;
  /**
   * The workflow name it was started with, kept because the id alone does not say
   * what ran. `activityScheduled` keeps its name for the same reason, and this is
   * the only record on *this* side of what the start was for: the execution itself
   * has no parent link pointing back here.
   */
  name: string;
  /**
   * Whether this start created the execution, or found the claimed id already taken.
   *
   * The counterpart of `workflowSignaled.delivered`, and recorded for the same
   * reason: it is the interesting failure of this command, and the starter cannot
   * see it — nothing parks on an independent start, so there is no promise to
   * reject. `false` is usually correct and expected (a schedule re-firing the same
   * nominal time must not run twice), which is exactly why it should be legible
   * rather than inferred.
   */
  created: boolean;
}

/**
 * Marker: a signal has been sent to another execution. Same role as the markers
 * above — it records the dispatch so replay does not send a second one.
 *
 * The asymmetry to hold in mind: **a signal sent is numbered, a signal received
 * is not.** Sending is a command, so it takes a seq in the sender's history like
 * any other dispatch; arriving is an external input, so the `SignalEvent` on the
 * target stays seq-less and is unchanged by this. The two events are the two ends
 * of one delivery and they are deliberately not the same shape.
 *
 * Written **after** the delivery, as `childStarted` and `childCancelRequested`
 * are, and for the same reason: nothing re-drives a signal on restart, so replay
 * re-emitting the command is its only recovery, and a marker written first would
 * suppress it. That ordering is only safe because delivery is idempotent —
 * `SignalEvent.source` is what makes it so.
 */
export interface WorkflowSignaledEvent extends HistoryEventBase {
  type: 'workflowSignaled';
  seq: number;
  /** The execution that was signalled. */
  targetId: string;
  signalName: string;
  /**
   * **The payload is deliberately not here.** `activityScheduled` carries its
   * args because nothing else does — the task is rebuilt from it on recovery —
   * whereas a signal's payload is already durable on the target, which is the
   * copy that gets read. Keeping a second one would double the bytes of the
   * highest-volume command there is (a poller relaying every item it finds) to
   * store something one link away. `describe` on the target is where to look.
   */
  /**
   * Whether the target took it: false when nothing holds that id, or when it has
   * already settled.
   *
   * Recorded rather than dropped, because a signal into the void is the failure
   * mode of this command and the sender cannot see it — `signalWorkflow` does not
   * park, so there is no promise to reject. Temporal reports the same condition as
   * a typed `EXTERNAL_WORKFLOW_EXECUTION_NOT_FOUND` on an awaitable command; this
   * keeps the fact and drops the await (see `core/workflow_api.signalWorkflow`).
   *
   * A duplicate suppressed by `SignalEvent.source` reads `true`: it *was*
   * delivered, by the dispatch this one is repeating.
   */
  delivered: boolean;
}

/**
 * Marker: the workflow took the patched branch of `patched(patchId)` at this seq.
 *
 * The only marker that records a **decision** rather than a dispatch, and the only
 * one whose value is read back by workflow code. Everything else here is written so
 * that replay does not repeat an effect; this is written so that replay reaches the
 * same fork in the road. `core/workflow_api.patched` owns the argument for why the
 * decision cannot simply be recomputed — in short, the code that would recompute it
 * is the code that changed.
 *
 * ## Its seq is the whole mechanism
 *
 * A version branch changes how many commands the workflow issues, and `seq` is
 * assigned in call order, so a branch decided differently on a later replay
 * renumbers everything after it. This marker is keyed by seq for exactly that
 * reason: it does not merely say "this execution is patched", it says **which
 * position in the command sequence the decision occupies.** That is what lets
 * `patched` answer by asking one question of history — *what does this seq already
 * hold?* — and get an answer that is stable for the life of the execution:
 *
 * - this marker, with this id → the patched branch was taken here, take it again;
 * - some other event → pre-patch code owned this seq, so the pre-patch branch was
 *   taken here and must be taken again;
 * - nothing at all → no code has ever reached this seq, so nothing is owed and the
 *   decision is free to be made now and recorded.
 *
 * A patch-id-keyed marker with no seq would answer the first question and not the
 * third, which is the case that matters: an id-keyed set says "this execution is
 * patched" and therefore says it about the iterations of a loop that ran *before*
 * the patch shipped, renumbering their commands on the next replay.
 *
 * ## One per call, not one per execution
 *
 * A `patched` call inside a loop records a marker per iteration, because each
 * iteration is a separate position in the command sequence and each is pinned
 * separately. Deduplicating by id would be cheaper in bytes and wrong in the way
 * above. The cost is real for a long-lived workflow — it is one more event per
 * iteration, on the executions that already care most about history size — and the
 * answer to it is the answer to history growth generally: `continueAsNew`. A run
 * that rolls over starts with no patch markers and re-decides from the frontier,
 * which is correct, because it also starts with no commands for them to renumber.
 *
 * Carries no `delivered`, no payload, and nothing else: the id and the seq are the
 * whole fact.
 */
export interface PatchRecordedEvent extends HistoryEventBase {
  type: 'patchRecorded';
  seq: number;
  /** The author's name for one change, as passed to `patched`. */
  patchId: string;
}

/**
 * The workflow parked on a `condition()`, and which one.
 *
 * The one state a workflow can be in that history has never recorded. `condition`
 * leaves no history *by design* — that is what makes it free — and the cost is
 * that an execution waiting correctly and an execution wedged are identical from
 * events alone: both are a running record whose last event is arbitrarily old.
 * `ParkedCondition` answers that, and answers it only for right now.
 *
 * For a scheduler this is not a gap at the margin. A paused schedule parks with no
 * timer at all, deliberately, so *nothing* is pending and *nothing* enters history
 * for as long as the pause lasts — see `schedule/scheduler.workflow.ts`.
 * Reconstructed from events, the healthiest state that workflow has is
 * indistinguishable from its worst.
 *
 * ## Transitions, not evaluations
 *
 * Written when the parked set *changes*, never per check. `condition` is
 * re-evaluated at every activation, so an event per evaluation would put a
 * workflow's history in proportion to how often it is woken — which, for anything
 * signal-driven, is the one thing history must not scale with. A condition still
 * parked across ten tasks appends nothing on nine of them.
 */
export interface ConditionParkedEvent extends HistoryEventBase {
  type: 'conditionParked';
  /**
   * The condition's id, from the `condSeq` counter.
   *
   * **Not a command seq, and named so it cannot be mistaken for one.** Parking is
   * deliberately kept out of command numbering (see `ParkedCondition.seq`), so
   * this shares no space with the `seq` on every other event here: no marker check
   * applies to it, no completion is owed for it, and `assertHistoryAccounted` must
   * not count it as dispatched work.
   */
  condSeq: number;
  /** Where `condition()` was called, innermost first. Absent when uncaptured. */
  site?: string;
  /**
   * The `ParkedCondition.awaiting` the workflow declared, as it stood when the
   * span opened. Stamped here so the record of *having waited* keeps what the
   * wait was for after the live parked state has moved on — how long approval
   * took is a question asked mostly after it was granted.
   */
  awaiting?: unknown;
}

/**
 * A parked condition is no longer parked.
 *
 * Named for the state change rather than its cause, because the cause is not
 * always satisfaction: a cancelled run rejects every blocked condition, and a
 * settling one reports an empty parked set. `conditionResolved` would have been
 * the more natural word and a claim this event cannot support.
 *
 * Its job is to *close the span* the park opened. Without it a reader has to infer
 * that a park ended because some later event exists, which is wrong precisely when
 * a workflow parks again on the same line — the loop case, where the spans it
 * would merge are the ones worth telling apart.
 */
export interface ConditionUnparkedEvent extends HistoryEventBase {
  type: 'conditionUnparked';
  /** The `conditionParked.condSeq` this closes. */
  condSeq: number;
}

/**
 * Which dispatch produced a signal, when a workflow sent it.
 *
 * Two jobs, and the second is the load-bearing one:
 *
 * - **Provenance.** A signal is otherwise the one event that says nothing about
 *   where it came from, which is the first question asked of one that arrived
 *   unexpectedly.
 * - **Idempotent delivery.** `signalWorkflow` writes its marker *after* the
 *   delivery, so a process that dies in between leaves replay to re-send. The
 *   server drops a re-send by matching this triple against the target's history,
 *   which turns "at least once" into "once" for the window that matters.
 *
 * `runId` is in the key because a sender's `seq` counter restarts at zero on
 * continue-as-new, and the senders that use this most — pollers — roll over
 * constantly. Without it, item 3 of run 1 and item 3 of run 2 would be the same
 * dispatch and the second would be silently dropped.
 *
 * **The dedup window is the target's current history.** A target that continues
 * as new discards the record along with everything else, so a re-send that
 * straddles its rollover is delivered twice. Narrow — it needs a crash and a
 * rollover interleaved — but real, and the honest claim is "once, except across
 * the target's own rollover" rather than "exactly once".
 */
export interface SignalSource {
  /** The sending execution. */
  workflowId: string;
  /** Which run of it — see the note above. */
  runId: number;
  /** The `signalWorkflow` command's seq in that run. */
  seq: number;
}

/**
 * Externally injected; not tied to a command, so it carries no seq.
 *
 * "Externally" now includes another workflow: a signal from `signalWorkflow`
 * arrives here exactly as a client's does, and carries a `source` saying so. That
 * is deliberate — the target's code, its handlers, and its replay cannot tell the
 * two apart, so a workflow that consumes signals needs no knowledge of who is
 * feeding it.
 */
export interface SignalEvent extends HistoryEventBase {
  type: 'signal';
  name: string;
  payload: unknown;
  /**
   * The dispatch that sent this, when a workflow sent it. Absent on a signal
   * injected by a client — which is what makes its presence the answer to "did
   * this come from inside the system?"
   */
  source?: SignalSource;
}

/**
 * Externally injected cancellation request (from a client, or a parent cancelling
 * a child). Like a signal it carries no seq; applying it rejects the run's
 * outstanding operations with a CancelledFailure. Recorded so the cancel point is
 * fixed in history and replay stays deterministic — cancellation is an event, not
 * a side effect.
 */
export interface CancelRequestedEvent extends HistoryEventBase {
  type: 'cancelRequested';
}

/** Events that complete a command — all carry a `seq`. */
export type CompletionEvent =
  | ActivityCompletedEvent
  | ActivityFailedEvent
  | TimerFiredEvent
  | ChildCompletedEvent
  | ChildFailedEvent;

export type HistoryEvent =
  | CompletionEvent
  | ActivityScheduledEvent
  | ActivityStartedEvent
  | ActivityRetryScheduledEvent
  | TimerStartedEvent
  | ChildStartedEvent
  | WorkflowStartedEvent
  | ChildCancelRequestedEvent
  | WorkflowSignaledEvent
  | PatchRecordedEvent
  | ConditionParkedEvent
  | ConditionUnparkedEvent
  | SignalEvent
  | CancelRequestedEvent;

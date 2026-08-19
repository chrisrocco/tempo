/**
 * @fileoverview
 * The deterministic primitives workflow code calls. Each one records a command
 * (stamped with the next `seq`) and hands back a promise that stays parked until
 * the matching completion event is applied during replay. Only the workflow
 * entrypoint (`workflow.ts`) re-exports these.
 *
 * Everything here lives on the deterministic side of the boundary: these
 * primitives are how a workflow reaches the outside world *without* reaching for
 * it directly. "Current time" and "an external result" both arrive through
 * history rather than being read from the host. That is why the surface is
 * exactly this and no wider — a non-deterministic capability added here would
 * make replay irreproducible and belongs on the runtime/host side instead.
 *
 * `patched` is the odd one out and worth flagging here: it is the only primitive
 * that *reads* history rather than adding to it, and the only one whose return
 * value workflow code branches on. Its own comment carries the argument.
 */

import {
  DEFAULT_PARENT_CLOSE_POLICY,
  durationToMs,
  type ActivityOptions,
  type Command,
  type CommandSpec,
  type Duration,
  type ExecutionParentView,
  type ParentClosePolicy,
} from '../protocol';
import {getContext, type WorkflowContext} from './context';
import {CancelledFailure} from './errors';
import type {SignalDef} from './signals';

/**
 * The one place a command becomes real. Every site that mints a `Command` must go
 * through here: `requested` is recorded unconditionally (it is what the marker
 * check compares against on replay) while `commands` — what the server has yet to
 * see — is appended only for work history does not already hold. Setting one
 * without the other is the bug this helper exists to prevent: a command that
 * skipped `requested` looks unrequested on the next replay and would fail the
 * check on a perfectly correct workflow.
 *
 * Suppression asks one question: **does history already hold an event at this
 * seq?** A marker or a completion is proof the server acted on the command, so
 * re-emitting would double-dispatch; a seq history has never seen is work the
 * server has never done. Nothing about *where* replay has got to enters into it —
 * that was `isLive`, and it was a fact about position standing in for a fact about
 * content (issue #39). Every command leaves a marker as of issue #50, so the
 * question is always answerable.
 *
 * `continueAsNew` is the one command with no event of its own, and it needs no
 * exception: dispatching one *empties* the run's history
 * (`resetForContinueAsNew`), so a run being replayed against events has provably
 * never had one dispatched. "No trace" is decisive there rather than unknown, and
 * re-emitting is the only way the rollover ever happens.
 */
function issue(ctx: WorkflowContext, command: Command): void {
  ctx.requested.set(command.seq, command);
  if (!ctx.dispatchedSeqs.has(command.seq)) ctx.commands.push(command);
}

function scheduleCommand(spec: CommandSpec): Promise<unknown> {
  const ctx = getContext();
  if (ctx.cancelled) return Promise.reject(new CancelledFailure()); // no new work after cancel
  const seq = ctx.seq++;
  issue(ctx, {...spec, seq} as Command);
  return new Promise<unknown>((resolve, reject) =>
    ctx.completions.set(seq, {resolve, reject}),
  );
}

function scheduleActivity(
  name: string,
  options: ActivityOptions,
  args: unknown[],
): Promise<unknown> {
  return scheduleCommand({type: 'scheduleActivity', name, args, options});
}

export function runActivity<T = unknown>(
  name: string,
  ...args: unknown[]
): Promise<T> {
  return scheduleActivity(name, {}, args) as Promise<T>;
}

/**
 * A durable timer: milliseconds, or a duration string — `sleep('30 minutes')`.
 * Parsed here, before the command is minted, so the wire and history carry only
 * the number; the parse is a pure function of the source text, which is what
 * makes the string form replay-safe.
 */
export function sleep(duration: Duration): Promise<void> {
  return scheduleCommand({
    type: 'startTimer',
    ms: durationToMs(duration),
  }) as Promise<void>;
}

/** How a child is started. Both child primitives take the same shape. */
export interface ChildOptions {
  /** Arguments for the child workflow function. */
  args?: unknown[];
  /**
   * The child's execution id. Omit and the engine derives one from lineage,
   * which is unique per call site and per run.
   *
   * Supply one to say *which* execution this is, and the id becomes a claim: a
   * child is started only if nothing holds that id already, and otherwise this
   * correlates to the existing execution. That turns "start a planner" into "make
   * sure there is exactly one planner for calendar event X" — a dedup key drawn
   * from the domain rather than from call order, which survives the parent
   * replaying, restarting, or asking twice.
   *
   * **It must be deterministic.** It is computed during replay like everything
   * else, so derive it from workflow arguments, activity results, or signals —
   * never from a clock or a random. Choosing a different id on a later replay is
   * a divergence, and `apply_event` will say so rather than silently start a
   * second child.
   */
  workflowId?: string;
  /**
   * Which pool of workers runs the child. Defaults to the parent's queue, which
   * is almost always right — a child is part of the same application. Name one
   * to hand work to a different pool.
   */
  taskQueue?: string;
  /**
   * What becomes of this child when this workflow closes. Defaults to
   * `'terminate'`; `'cancel'` lets the child unwind, `'abandon'` leaves it
   * running. See `protocol/parent_close_policy.ts` for what each guarantees and
   * why the default is the harsh one.
   *
   * Set `'abandon'` for a child deliberately started to outlive its parent — a
   * follow-up job, a handoff. Leave it alone for anything started to serve this
   * workflow, which is the case that leaks otherwise: an infinite poller feeding a
   * parent goes on polling forever once the parent is gone, and nothing reports
   * that it has.
   *
   * It is read from history, not from this call, whenever the parent actually
   * closes — so changing it in the source affects children started from then on,
   * not ones already running.
   */
  parentClosePolicy?: ParentClosePolicy;
}

/**
 * Blocking child: start a child workflow and await its result. The parent parks
 * and is resumed by a `childCompleted` event correlated back by `seq` — the same
 * dispatch-and-park path an activity takes. Contrast `startChild`, whose detached
 * children carry no completion event at all, which is why they need no waiter.
 *
 * With an explicit `workflowId` that is already taken, this awaits the existing
 * execution rather than starting a second one — including one that has already
 * finished, whose result is delivered immediately.
 */
export function executeChild<T = unknown>(
  name: string,
  options: ChildOptions = {},
): Promise<T> {
  return scheduleCommand({
    type: 'startChild',
    childName: name,
    childArgs: options.args ?? [],
    detached: false,
    workflowId: options.workflowId,
    taskQueue: options.taskQueue,
    parentClosePolicy: options.parentClosePolicy ?? DEFAULT_PARENT_CLOSE_POLICY,
  }) as Promise<T>;
}

/** A fire-and-forget child's handle: it can be cancelled, but its result is not awaited. */
export interface ChildHandle {
  cancel(): void;
}

/**
 * Fire-and-forget child: start a child workflow and keep going — no await, no
 * completion is threaded back. Returns a handle to cancel it. This is the
 * spawn-and-cancel shape a monitor workflow needs: park on a `condition`, and as
 * items appear and disappear, spawn a child per item and cancel it when the item
 * goes away. Cancel is itself replay-safe: it emits a `cancelChild` command the
 * server acts on once.
 *
 * Pair it with an explicit `workflowId` and the spawn becomes idempotent against
 * the *domain* rather than the call: a scanner that sees the same item twice
 * claims the same id twice and starts one child. Worth doing even when the
 * scanner already tracks what it has seen — that bookkeeping is in the workflow's
 * own state, and this check is not.
 */
export function startChild(
  name: string,
  options: ChildOptions = {},
): ChildHandle {
  const ctx = getContext();
  if (ctx.cancelled) return {cancel() {}};
  const targetSeq = ctx.seq++;
  issue(ctx, {
    type: 'startChild',
    childName: name,
    childArgs: options.args ?? [],
    detached: true,
    workflowId: options.workflowId,
    taskQueue: options.taskQueue,
    parentClosePolicy: options.parentClosePolicy ?? DEFAULT_PARENT_CLOSE_POLICY,
    seq: targetSeq,
  });
  return {
    cancel() {
      const c = getContext();
      if (c.cancelled) return;
      const seq = c.seq++;
      issue(c, {type: 'cancelChild', targetSeq, seq});
    },
  };
}

/**
 * Send a signal to another execution, by workflow id.
 *
 * The counterpart of `setHandler` across an execution boundary: what arrives at
 * the target is an ordinary signal, indistinguishable from one a client injected,
 * so the receiving code needs no knowledge of who is feeding it.
 *
 *     const parent = workflowInfo().parent;
 *     await pollForever({
 *       everyMs: 30_000,
 *       poll: () => act.listComments(pr),
 *       differ: byId((c) => c.id),
 *       onAdded: (c) => signalWorkflow(parent!.workflowId, newComment, c),
 *     });
 *
 * That shape — a child poller feeding a waiting parent — is what this exists for.
 * The alternative was an activity that calls `client.signal`, which puts the
 * delivery path outside the determinism boundary and makes it at-least-once: an
 * activity whose completion was lost is retried, and the target sees the item
 * twice. Here the engine dispatches it, and the delivery is deduplicated against
 * the target's history (see `SignalSource`).
 *
 * ## Fire-and-forget, and what that gives up
 *
 * Nothing is awaited: this returns `void`, allocates a seq for its marker, and
 * parks nothing. A signal to an id nothing holds — or to an execution that has
 * already settled — therefore cannot be caught. It is *recorded*, as
 * `workflowSignaled.delivered: false` on the sender plus a `signal.undelivered`
 * log line, so the failure is greppable rather than invisible.
 *
 * The awaitable form Temporal has (`SignalExternalWorkflowExecutionFailed`, a
 * typed `NOT_FOUND` cause) was considered and declined for now. It costs a second
 * history event and a park **on every signal**, which lands on the sender that
 * sends the most — a poller relaying every item it finds — to report an outcome
 * there is usually no recovery for. The recovery that would matter is "my target
 * is gone, stop producing", and `parentClosePolicy` already does that job better:
 * a poller feeding its parent is terminated when that parent closes, rather than
 * discovering its death one undelivered item at a time. Reopen this if a caller
 * has a real branch to write on the failure; the event already carries the
 * answer, so making it awaitable is a completion event away.
 *
 * Also unbuilt, deliberately: no cap on signals per execution (Temporal's
 * `maximumSignalsPerExecution`) and no `childWorkflowOnly` guard restricting the
 * target to this workflow's own children. Both are restrictions, and a restriction
 * is cheap to add and breaking to remove — so neither is guessed at before a
 * caller needs it.
 */
export function signalWorkflow(
  workflowId: string,
  signal: SignalDef,
  payload?: unknown,
): void {
  const ctx = getContext();
  if (ctx.cancelled) return; // no new work after cancel, as with startChild
  issue(ctx, {
    type: 'signalWorkflow',
    targetId: workflowId,
    signalName: signal.name,
    payload,
    seq: ctx.seq++,
  });
}

/** What `startWorkflow` needs to know beyond the id and the name. */
export interface StartWorkflowExternalOptions {
  args?: unknown[];
  /** Which pool runs it. Defaults to this execution's queue, as `startChild` does. */
  taskQueue?: string;
}

/**
 * Start an execution that is not this one's child, addressed by an id you choose.
 *
 * The third way to start work, and the one to reach for when the new execution must
 * outlive *anything* that happens to the starter:
 *
 * | | outlives completion | outlives cancellation | reachable afterwards |
 * | --- | --- | --- | --- |
 * | `executeChild` | n/a — awaited | no | the awaited result |
 * | `startChild` | with `abandon` | **no** | the returned handle |
 * | `startWorkflow` | yes | yes | by id only |
 *
 * The middle column is the whole reason this exists. `parentClosePolicy` governs a
 * parent *closing*; cancellation cascades to children regardless of it, because
 * cancelling a parent means *stop this work* and a subtree of it is still that work
 * (`protocol/parent_close_policy.ts` argues for that, and it is right). So a child
 * cannot be the shape of a scheduled run: cancelling the schedule would cancel runs
 * already in flight, which is the behaviour Temporal's Schedules exist to fix in
 * their own older `CronSchedule`.
 *
 * ## The id is required, and is the dedup
 *
 * A claimed id that already exists **correlates instead of starting a second
 * execution** — the same claim semantics `startChild`'s optional `workflowId` has, but
 * mandatory here because nothing else can reach the result. No handle is returned
 * (there is no `cancelChild` counterpart to hand back; that coupling is what is being
 * avoided) and no parent link is recorded, so an unnamed independent execution would
 * be addressable by nothing.
 *
 * Make the id a fact about the domain and the start becomes idempotent against the
 * domain:
 *
 * ```ts
 * startWorkflow(`${scheduleId}-${nominalTime}`, 'nightlyReport', {args: [day]});
 * ```
 *
 * A schedule that fires the same nominal time twice — a retried task, a rollover
 * landing on the same boundary — starts one execution. The marker records which of
 * the two happened as `workflowStarted.created`, because "already there" is the
 * expected case and should be legible rather than inferred.
 *
 * ## What it gives up
 *
 * Everything `signalWorkflow` gives up, for the same reasons: no await, no failure to
 * catch, nothing threaded back. It returns `void` and allocates one seq for its
 * marker. To act on what you started, address it by id — `signalWorkflow`, or a
 * client held by an activity. To *know* what it did, read `describe` on that id.
 */
export function startWorkflow(
  workflowId: string,
  name: string,
  options: StartWorkflowExternalOptions = {},
): void {
  const ctx = getContext();
  if (ctx.cancelled) return; // no new work after cancel, as with startChild
  issue(ctx, {
    type: 'startWorkflow',
    targetId: workflowId,
    name,
    args: options.args ?? [],
    taskQueue: options.taskQueue,
    seq: ctx.seq++,
  });
}

/**
 * What history already says about the seq a patch primitive is standing on.
 *
 * The three cases are the whole of the versioning mechanism, and they are three
 * rather than two because "history holds nothing here" is a different answer from
 * "history holds the other branch here". Collapsing them is how a version
 * primitive turns into a nondeterminism generator.
 */
type PatchState =
  /** No code has ever reached this seq. Nothing is owed; decide freely. */
  | 'unreached'
  /** This patch's marker is here. The patched branch was taken and is pinned. */
  | 'recorded'
  /** Some other event owns this seq, so the code that wrote it had no patch here. */
  | 'foreign';

function patchState(
  ctx: WorkflowContext,
  seq: number,
  patchId: string,
): PatchState {
  if (!ctx.dispatchedSeqs.has(seq)) return 'unreached';
  return ctx.patchesBySeq.get(seq) === patchId ? 'recorded' : 'foreign';
}

/**
 * Has this execution adopted the change called `id`?
 *
 * The versioning primitive: it lets a workflow's body gain a branch while
 * executions of it are in flight, which is otherwise the change that diverges
 * replay from history and wedges every running execution (adoption blocker 3 in
 * ROADMAP.md, issue #52). Wrap the new code, leave the old code in the `else`, and
 * both an execution that has already run the old path and one that has not can
 * replay the same source:
 *
 * ```ts
 * if (patched('schedule-jitter')) {
 *   await sleepJittered(delayMs);
 * } else {
 *   await sleep(delayMs);
 * }
 * ```
 *
 * `id` is an author's name for one change, and it must be unique within the
 * workflow. It is compared, not just counted (see `apply_event`), so two patches
 * that swap places in the source is a divergence rather than a silent re-branch.
 *
 * ## `patched`, not `getVersion(id, min, max)`
 *
 * Temporal has both shapes. `getVersion` returns an integer and handles a call
 * site that evolves repeatedly: version 1 then 2 then 3, with the workflow
 * switching on the number. `patched` is one boolean per change.
 *
 * The boolean is chosen because the integer's extra power is bought with a range
 * the author must maintain by hand, and the failure mode of getting it wrong is
 * silent. `getVersion(id, min, max)` asks for the *supported* range, so pruning a
 * branch means raising `min`, and raising it past a version some in-flight
 * execution recorded is a nondeterminism error discovered at replay time on
 * production data. With one id per change there is no range: a change is adopted
 * or it is not, three sequential changes are three ids, and each is retired
 * independently. The version numbers were never the thing being reasoned about;
 * "did this execution get the fix" was.
 *
 * It does not foreclose `getVersion`. The marker records a `patchId` at a seq, and
 * an integer version is that same shape with a different payload — a
 * `versionRecorded` marker carrying a number, read by the same "what does this seq
 * hold" question. Nothing here has to be unpicked to add it; a caller who genuinely
 * needs an ordered range can have it, and a boolean per change stops being the
 * answer only when someone can show a call site where three ids read worse than
 * one integer.
 *
 * ## Why the answer is recorded rather than recomputed
 *
 * Because the thing that would recompute it is the thing that changed. A workflow
 * being replayed is being replayed by *new* code, so any test the new code
 * performs — a feature flag, a comparison against the arguments, a config lookup —
 * answers for the new code, not for the code that wrote the history. The only
 * witness to what the old code did is the history the old code produced. So the
 * first execution to reach a patch writes its answer down, and every later replay
 * of that execution reads it back.
 *
 * ## The recorded answer is read before the branch allocates a seq
 *
 * This is the sharp edge, and it is worth being explicit about why the obvious
 * implementation is wrong. A version branch changes how many commands are issued,
 * and `seq` is assigned in call order — so if the answer were decided *after* the
 * branch started allocating, or decided differently on a later replay, every seq
 * after the branch would renumber and every completion in history would find the
 * wrong waiter.
 *
 * So: `patched` reads `ctx.seq` **without consuming it**, asks history what is
 * already recorded there, and only then decides. It consumes the seq in exactly
 * the case where history holds (or is about to hold) its own marker there, and
 * consumes nothing in the case where history holds pre-patch code's event there.
 * Either way the branch body starts allocating from the seq the recorded history
 * says it should, and it never has to give one back — the decision is final before
 * the first line of either branch runs.
 *
 * ## What is actually guaranteed, stated precisely
 *
 * **Once an execution has taken a branch at a call site, it takes that branch
 * forever.** That is a claim about *dispatched work*, not about start time, and the
 * difference is deliberate:
 *
 * - An execution whose history already holds a command at this seq took the
 *   pre-patch branch there, and keeps taking it — for that call site, for the life
 *   of the run.
 * - An execution that has never reached this seq is owed nothing. It adopts the
 *   patch, records the marker, and keeps it.
 *
 * So a long-lived workflow looping over `patched` keeps the old shape for the
 * iterations it already ran and takes the new one from the next iteration on, which
 * is what a schedule wants: iterations already committed to history stay as they
 * were recorded, and the fix applies going forward.
 *
 * Note what this does *not* claim: that an execution started before the deploy
 * takes the `false` branch forever. Nothing in history distinguishes "started
 * before the patch existed" from "started after it and has not reached it yet" —
 * that needs a per-execution stamp of the code or engine semantics in force
 * (question 4 on issue #52, deliberately not built here). Pinning on committed
 * history instead is the strongest guarantee available without one, and it is the
 * one replay safety actually needs: the branch cannot change under an execution
 * that has already acted on it.
 *
 * ## Rules for the author
 *
 * - **The call must be reached on every replay, in the same order.** It is an
 *   ordinary primitive that allocates a seq; putting it behind a non-deterministic
 *   condition is the same mistake as putting `runActivity` there.
 * - **Never rename or re-use an `id`.** The id is compared against history, so a
 *   rename is a divergence on every execution that recorded the old one.
 * - **Deleting the call is not the same as deleting the branch.** See
 *   `deprecatePatch`, which exists precisely because the marker holds a seq that
 *   still has to be accounted for after the `if` is gone.
 */
export function patched(id: string): boolean {
  const ctx = getContext();
  // Peeked, not allocated. Consuming it here and rolling back on the `false` path
  // would work today and would be the wrong shape: it makes seq allocation depend
  // on control flow inside this function rather than on what history records.
  const seq = ctx.seq;
  // Deliberately not gated on `ctx.cancelled`, unlike every dispatching primitive
  // above. This is a read of a fact, not new work, and a cancelled run unwinding
  // through `finally` must see the same branch its forward path saw — returning
  // `false` for a patch whose marker is sitting in history would have one run take
  // both sides. Allocating a seq during the cancellation window is safe because
  // the decision is a function of history, so every replay allocates the same one.
  if (patchState(ctx, seq, id) === 'foreign') return false;
  ctx.seq++;
  // Suppressed by `issue` when history already holds the marker, so re-deciding
  // costs nothing; emitted only by the first replay to reach this seq.
  issue(ctx, {type: 'recordPatch', patchId: id, seq});
  return true;
}

/**
 * Retire a patch: keep its seq accounted for, stop recording it for new work.
 *
 * The second half of a two-step change, and the reason `patched` is not a call site
 * you are stuck with forever. Once every execution that predates the patch has
 * drained, the `else` branch is dead code — but **removing the `if` is not the same
 * as removing the call.** Executions that recorded a marker still have a
 * `patchRecorded` sitting at that seq, and code that no longer issues anything
 * there will allocate that seq for whatever comes next. That is a divergence, and
 * `apply_event` reports it as one rather than letting the commands shift silently.
 *
 * So the migration is:
 *
 * 1. `if (patched('x')) { new } else { old }` — ship the change.
 * 2. `deprecatePatch('x'); new` — once nothing is left on the old branch, delete
 *    the `else` and the `if`, leaving this. Executions carrying the marker consume
 *    their seq and are satisfied; executions started from here on record nothing
 *    and pay nothing, because the branch is no longer a branch.
 * 3. Delete this line too, once every execution carrying a marker for `x` has
 *    drained.
 *
 * Step 3 needs a drain, so this does not abolish draining — it moves it off the
 * critical path. The deploy that *changes behaviour* is step 1 and it needs no
 * drain at all; steps 2 and 3 are cleanup, and can wait as long as they like.
 *
 * **Do not skip step 1's cooldown.** Deprecating while pre-patch executions are
 * still in flight makes the new branch unconditional for a run whose history
 * records the old one, which is exactly the divergence this whole mechanism exists
 * to prevent. It is loud rather than silent — the seq that the deleted `else`
 * branch used to own now carries a mismatched command — but loud on production
 * executions is still a bad afternoon.
 */
export function deprecatePatch(id: string): void {
  const ctx = getContext();
  const seq = ctx.seq;
  // Only the pinned case consumes anything. `unreached` must not record a marker —
  // the whole point of deprecating is that new executions stop carrying them — and
  // `foreign` is a pre-patch execution, which has nothing here to account for.
  if (patchState(ctx, seq, id) !== 'recorded') return;
  ctx.seq++;
  // Always suppressed (history holds the marker, or we would not be here), so this
  // records the claim for the divergence check and emits nothing.
  issue(ctx, {type: 'recordPatch', patchId: id, seq});
}

/**
 * Terminal: end this run and start a fresh one carrying `args`. It emits a
 * `continueAsNew` command and returns a promise that never resolves, so no code
 * runs after it — `return continueAsNew(...)` (or `await` it) halts the run.
 *
 * This is how a long-running or infinite workflow avoids unbounded history
 * growth: every execution has a history ceiling, so any unbounded workflow needs
 * *some* continue-as-new strategy. It is not optional for long-lived workflows.
 *
 * The core's job ends at emitting the terminal command and halting. The actual
 * close-and-restart is a stateful, transactional act only the server can do
 * atomically — new runId, fresh empty history, enqueue a task, spare the children
 * (see `server_core.applyWorkflowTaskResult`). Do **not** be tempted to make
 * `replay` handle this by looping internally or re-seeding its own context:
 * keeping the division is what stops a genuinely run-spanning mechanism from
 * smuggling run-spanning state into an engine that should know about exactly one
 * run at a time.
 */
export function continueAsNew(...args: unknown[]): Promise<never> {
  return scheduleCommand({type: 'continueAsNew', args}) as Promise<never>;
}

export interface WorkflowInfo {
  /**
   * This execution's own id — the one a client passed to `start`, or the one the
   * engine derived for a child.
   *
   * The address to hand out when something outside has to reach back in. An
   * activity that launches an external process, or files a webhook, needs somewhere
   * for the callback to signal, and the workflow is the only thing that can supply
   * it: an activity has no ambient access to it (`activity.ts` exports `heartbeat`
   * and nothing else, deliberately), so it travels as an argument.
   *
   * ```ts
   * await act.launchJob({callbackWorkflowId: workflowInfo().workflowId});
   * ```
   *
   * **The id, and not the run.** A signal addressed to this id lands on whichever
   * run is current, which is what a caller wants: `continueAsNew` replaces the run
   * and keeps the execution, so a callback pinned to a run would be pinned to the
   * one about to be rolled over. That matters most for exactly the workflows that
   * live long enough to hand out callbacks.
   *
   * Replay-safe, and more plainly so than anything else here — fixed before the
   * first task and unchanged for the execution's whole life.
   */
  workflowId: string;
  /**
   * True when the server hints that history has grown enough to roll over.
   *
   * A server-provided *input*, not a command — it flows in via the task and is
   * re-evaluated at every activation boundary. Acting on it is the author's
   * choice, and it should be acted on at a **clean checkpoint** (state coherent,
   * queue drained), never mid-reconciliation. It is only a hint: a workflow may
   * equally roll over on its own threshold or cadence, and a high-throughput one
   * may want to continue as new earlier than suggested.
   */
  continueAsNewSuggested: boolean;
  /**
   * The arguments this run was started with — the same values the workflow
   * function received.
   *
   * Reachable without threading them through, which is what a helper needs in
   * order to continue as new *as the same workflow*: it can carry the arguments
   * forward without the caller having to hand them over, and without them
   * appearing in the helper's own signature.
   *
   * Replay-safe: they come from the record with the task, and are fixed for the
   * life of the run. A copy, so a caller cannot reach back through it into the
   * context.
   */
  args: unknown[];
  /**
   * The execution that started this one, or absent if a client did.
   *
   * How a child learns its parent's id without being handed it as an argument —
   * the same reason `args` is here. `signalWorkflow` addresses a target by id, so
   * without this the child → parent direction would require every parent to pass
   * its own id down, which it cannot always know either: an id the engine derived
   * from lineage is not visible to the workflow that owns it.
   *
   * Absent is a real answer, not a missing one: a root execution has no parent, so
   * code that needs one must say what it does without it. Fixed for the whole
   * execution — a rollover does not change who started it — so branching on it is
   * replay-safe.
   */
  parent?: ExecutionParentView;
}

/** Read server-provided facts about the current run off the context. */
export function workflowInfo(): WorkflowInfo {
  const ctx = getContext();
  return {
    workflowId: ctx.workflowId,
    continueAsNewSuggested: ctx.continueAsNewSuggested,
    args: [...ctx.args],
    // Copied for the same reason `args` is: a caller must not be able to reach
    // back through the returned object and mutate the context.
    parent: ctx.parent && {...ctx.parent},
  };
}

/**
 * Any callable, for filtering a module namespace down to its functions.
 *
 * The `any[]` rest parameter is load-bearing and cannot be `unknown[]`: under
 * `strictFunctionTypes` a concrete `(name: string) => string` is **not**
 * assignable to `(...args: unknown[]) => unknown`, so the filter would reject
 * every real activity. The return type carries no such constraint, so it stays
 * `unknown`.
 */
type AnyFn = (...args: any[]) => unknown;

/**
 * A record of activity signatures, keyed by activity name — the shape to write
 * when declaring an activity interface by hand. `proxyActivities` does not
 * require it: it takes any object type and proxies the function-valued members.
 */
export type ActivityInterface = Record<string, AnyFn>;

/**
 * What `proxyActivities<A>` hands back: `A`'s function-valued members, each as an
 * async call. Non-function members are dropped rather than rejected, which is what
 * lets a whole module namespace be the type argument — an activities module is
 * free to export constants alongside its activities.
 */
export type ActivityProxy<A> = {
  [K in keyof A as A[K] extends AnyFn ? K : never]: A[K] extends AnyFn
    ? (...args: Parameters<A[K]>) => Promise<Awaited<ReturnType<A[K]>>>
    : never;
};

/**
 * A typed façade over `runActivity`: returns a proxy whose methods forward to the
 * activity of the same name, carrying `options` on the command. `A` drives the
 * compile-time argument and return types; at runtime this is a thin forwarder and
 * the typing is the whole payoff.
 *
 * **The primitive, not the author-facing call.** Workflow authors use
 * `proxyActivities` from `workflow.ts`, which wraps this to also register the
 * implementations it was handed. That wrapper cannot live here: registration is host
 * state and `core/` is a pure function of history, which is the property that makes
 * replay reproducible and the core testable against hand-written histories.
 *
 * The `options` it carries are declared in `protocol/` and **interpreted only by
 * the server** when it turns the command into an activity task. The core emits
 * them and does nothing with them — they are just more history-in/commands-out
 * payload.
 */
export function createActivityProxy<A extends object>(
  options: ActivityOptions = {},
): ActivityProxy<A> {
  return new Proxy({} as ActivityProxy<A>, {
    get(_target, prop) {
      const name = String(prop);
      return (...args: unknown[]) => scheduleActivity(name, options, args);
    },
  });
}

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
 */

import type {ActivityOptions, Command, CommandSpec} from '../protocol';
import {getContext, type WorkflowContext} from './context';
import {CancelledFailure} from './errors';

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

export function sleep(ms: number): Promise<void> {
  return scheduleCommand({type: 'startTimer', ms}) as Promise<void>;
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
}

/** Read server-provided facts about the current run off the context. */
export function workflowInfo(): WorkflowInfo {
  const ctx = getContext();
  return {
    continueAsNewSuggested: ctx.continueAsNewSuggested,
    args: [...ctx.args],
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
 * A typed façade over `runActivity`: `proxyActivities<A>(options)` returns a proxy
 * whose methods forward to the activity of the same name, carrying `options` on
 * the command. Pure sugar living in the core (re-exported from `workflow.ts`);
 * `A` drives the compile-time argument/return types — typically
 * `proxyActivities<typeof activities>()` against an imported activities module.
 * The typing is the whole payoff; at runtime this is a thin forwarder.
 *
 * The `options` it carries are declared in `protocol/` and **interpreted only by
 * the server** when it turns the command into an activity task. The core emits
 * them and does nothing with them — they are just more history-in/commands-out
 * payload.
 */
export function proxyActivities<A extends object>(
  options: ActivityOptions = {},
): ActivityProxy<A> {
  return new Proxy({} as ActivityProxy<A>, {
    get(_target, prop) {
      const name = String(prop);
      return (...args: unknown[]) => scheduleActivity(name, options, args);
    },
  });
}

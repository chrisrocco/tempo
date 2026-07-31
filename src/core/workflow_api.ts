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

import type { ActivityOptions, Command, CommandSpec } from '../protocol';
import { getContext } from './context';
import { CancelledFailure } from './errors';

function scheduleCommand(spec: CommandSpec): Promise<unknown> {
  const ctx = getContext();
  if (ctx.cancelled) return Promise.reject(new CancelledFailure()); // no new work after cancel
  const seq = ctx.seq++;
  const command = { ...spec, seq } as Command;
  if (ctx.isLive) ctx.commands.push(command);
  return new Promise<unknown>((resolve, reject) =>
    ctx.completions.set(seq, { resolve, reject }),
  );
}

function scheduleActivity(
  name: string,
  options: ActivityOptions,
  args: unknown[],
): Promise<unknown> {
  return scheduleCommand({ type: 'scheduleActivity', name, args, options });
}

export function runActivity<T = unknown>(
  name: string,
  ...args: unknown[]
): Promise<T> {
  return scheduleActivity(name, {}, args) as Promise<T>;
}

export function sleep(ms: number): Promise<void> {
  return scheduleCommand({ type: 'startTimer', ms }) as Promise<void>;
}

/** Blocking child: start a child workflow and await its result. */
export function executeChild<T = unknown>(
  name: string,
  ...args: unknown[]
): Promise<T> {
  return scheduleCommand({
    type: 'startChild',
    childName: name,
    childArgs: args,
    detached: false,
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
 */
export function startChild(name: string, ...args: unknown[]): ChildHandle {
  const ctx = getContext();
  if (ctx.cancelled) return { cancel() {} };
  const targetSeq = ctx.seq++;
  const command: Command = {
    type: 'startChild',
    childName: name,
    childArgs: args,
    detached: true,
    seq: targetSeq,
  };
  if (ctx.isLive) ctx.commands.push(command);
  return {
    cancel() {
      const c = getContext();
      if (c.cancelled) return;
      const seq = c.seq++;
      const cancelCommand: Command = { type: 'cancelChild', targetSeq, seq };
      if (c.isLive) c.commands.push(cancelCommand);
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
  return scheduleCommand({ type: 'continueAsNew', args }) as Promise<never>;
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
}

/** Read server-provided facts about the current run off the context. */
export function workflowInfo(): WorkflowInfo {
  const ctx = getContext();
  return { continueAsNewSuggested: ctx.continueAsNewSuggested };
}

type AnyFn = (...args: any[]) => any;

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

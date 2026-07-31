/**
 * @fileoverview
 * The deterministic primitives workflow code calls. Each one records a command
 * (stamped with the next `seq`) and hands back a promise that stays parked until
 * the matching completion event is applied during replay. Only the workflow
 * entrypoint (`workflow.ts`) re-exports these; see docs/concepts/determinism-boundary.md.
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

const scheduleActivity = (
  name: string,
  options: ActivityOptions,
  args: unknown[],
): Promise<unknown> =>
  scheduleCommand({ type: 'scheduleActivity', name, args, options });

export const runActivity = <T = unknown>(
  name: string,
  ...args: unknown[]
): Promise<T> => scheduleActivity(name, {}, args) as Promise<T>;
export const sleep = (ms: number): Promise<void> =>
  scheduleCommand({ type: 'startTimer', ms }) as Promise<void>;
/** Blocking child: start a child workflow and await its result. */
export const executeChild = <T = unknown>(
  name: string,
  ...args: unknown[]
): Promise<T> =>
  scheduleCommand({
    type: 'startChild',
    childName: name,
    childArgs: args,
    detached: false,
  }) as Promise<T>;

/** A fire-and-forget child's handle: it can be cancelled, but its result is not awaited. */
export interface ChildHandle {
  cancel(): void;
}

/**
 * Fire-and-forget child: start a child workflow and keep going — no await, no
 * completion is threaded back. Returns a handle to cancel it. This is the
 * spawn-and-cancel shape the bug-hotlist monitor needs (docs/concepts/conditions-signals-timers.md; ROADMAP). Cancel
 * is itself replay-safe: it emits a `cancelChild` command the server acts on once.
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
 * runs after it — `return continueAsNew(...)` (or `await` it) halts the run. The
 * actual close-and-restart is the server's job (docs/concepts/continue-as-new.md); the core just stops here.
 */
export const continueAsNew = (...args: unknown[]): Promise<never> =>
  scheduleCommand({ type: 'continueAsNew', args }) as Promise<never>;

export interface WorkflowInfo {
  /** True when the server hints that history has grown enough to roll over. */
  continueAsNewSuggested: boolean;
}

/** Read server-provided facts about the current run off the context. */
export const workflowInfo = (): WorkflowInfo => {
  const ctx = getContext();
  return { continueAsNewSuggested: ctx.continueAsNewSuggested };
};

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
 * See docs/architecture/distribution.md and docs/concepts/type-model.md.
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

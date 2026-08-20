/**
 * @fileoverview
 * `createWorkflow`: define a workflow under its wire name, register it globally,
 * and hand back a typed reference that *dispatches* it as a child.
 *
 * At `src/` root beside `activity_registry.ts`, because it is the same move made
 * for the same reason. A worker is handed its workflows as one object
 * (`startWorker({workflows})`), and for roots that is right — an entrypoint
 * should name what it serves. It stops being right for children: a decomposed
 * workflow's helpers each start children of their own, the entrypoint has to
 * name every one of those modules from memory, and the failure is quiet — an
 * unregistered child name parks the execution on a queue whose workers fail
 * every task for it. `activity_registry.ts` closed the same gap for activities
 * by tying registration to **use**: `proxyActivities` types the call site and
 * records the implementation in one call. This does it for workflows: invoking
 * a child requires importing its reference, importing evaluates `createWorkflow`,
 * and evaluation registers it — the import graph is the registration graph, and
 * only roots are named by hand.
 *
 * ## The reference dispatches; only the engine runs the body
 *
 * What `createWorkflow` returns is deliberately NOT the function it was given.
 * `await processOrder(args)` inside a workflow must start a **child execution**
 * — its own history, its own cancellation scope, its own parent-close policy —
 * and a returned-as-is function would instead run the child's body inline in
 * the parent's replay: the child's activities would interleave into the
 * parent's history and it would half-work until it didn't. So the reference
 * wraps `executeChild` (and `startChild`, via `.detached()`), the *registry* holds
 * the real function for the engine to invoke, and a unit test that wants the
 * body calls `.impl`, which is the same function the author wrote: the
 * descriptor rides on it, and nothing about it changed.
 *
 * ## The name is the author's now
 *
 * `startWorker({workflows})` lets the export name be the registered name,
 * chosen at the entrypoint. A reference usable at a call site has to know its
 * wire name at *definition* time, and `fn.name` is not a candidate — workers
 * ship as bundled artifacts, and minification renames functions silently. So
 * the author writes it as `key`, which also means two modules that never see
 * each other can claim one name. That conflict is **recorded, not thrown**:
 * these calls run at module load, where a throw fires mid-evaluation and
 * crashes the process on import instead of reporting anything actionable
 * (`activity_registry.ts` argues this at length). `startWorker` checks
 * `workflowNameConflicts()` once every module has loaded, refuses to start, and
 * names the escape hatch — an explicit `startWorker({workflows})` entry, which
 * wins over anything registered here.
 *
 * ## What it costs
 *
 * The same thing the activity registry cost, admitted the same way:
 * `StartWorkerOptions` is no longer the complete account of a worker's
 * workflows either — what it serves now depends on which modules were loaded.
 * That coupling is also the correctness: a worker that loads a parent loads the
 * children the parent can actually start, so the served set derives from the
 * bundle's import graph and two workers of one binary cannot skew.
 *
 * `createLocalRuntime` deliberately does **not** read this registry — it is the
 * explicit test seam, and stays one (a reference passed to `registerWorkflow`
 * is unwrapped there, but nothing registers itself). The registry feeds
 * `startWorker`, in every mode including `--local`.
 */

import {
  executeChild,
  startChild,
  type ChildHandle,
  type ChildOptions,
} from './core';
import {describeWorkflow, type AnyWorkflowFn} from './workflow_descriptor';
import type {WorkflowDescriptor} from './protocol';

/** Any callable. `any[]` rest params are required for assignability — see `core/workflow_api`. */
type AnyFn = (...args: any[]) => unknown;

/**
 * `Symbol.for`, not a local `Symbol()`, for the reason `workflow_descriptor.ts`
 * gives: a module can evaluate twice, and every copy has to agree on the brand
 * or one copy's references would be invisible to another's unwrapping.
 */
const IMPL = Symbol.for('tempo.workflowImpl');

const registered = new Map<string, AnyFn>();
const conflicted = new Set<string>();

/**
 * A registered workflow, as its callers see it: invoke it to run it as a
 * blocking child, `.execute()` when the blocking call needs options,
 * `.detached()` for fire-and-forget, `.impl` for the body itself.
 *
 * The two methods share one shape — the typed props, then the options —
 * and map one-to-one onto the primitives: call/`.execute` is `executeChild`,
 * `.detached` is `startChild`, so the table in `core/workflow_api.ts` reads
 * unchanged through the reference. The typing is the half of this that
 * `startChild('name', options)` could never have: `Parameters` in and the
 * resolved return type out, checked against the implementation rather than
 * asserted at every call site.
 */
export interface WorkflowRef<F extends AnyWorkflowFn> {
  /**
   * Run the workflow as a **blocking child** of the calling workflow and return
   * its result — sugar for `.execute(args)` with every option defaulted, which
   * is the overwhelmingly common call. Only callable inside a workflow; from
   * anywhere else it throws an error that says where each caller should go
   * instead.
   */
  (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>;
  /** The wire name — what `client.start` takes and what a task is routed by. */
  readonly workflowName: string;
  /**
   * The implementation itself — what the engine replays, and what a unit test
   * calls to run the body directly, since calling the reference dispatches.
   */
  readonly impl: F;
  /**
   * The blocking call with its options: a `workflowId` claim (a taken id
   * **awaits the existing execution** instead of starting a second one —
   * including one already finished, whose result returns immediately), a
   * `taskQueue`, a `parentClosePolicy` for the case where the parent closes
   * mid-await. `executeChild`, typed; the direct call above is this with
   * defaults. Props and options are two parameters rather than one object
   * because the props are the workflow's own and the options are the engine's,
   * and merging them would let a workflow shadow `taskQueue`.
   */
  execute(
    props?: Parameters<F>[0],
    options?: Omit<ChildOptions, 'props'>,
  ): Promise<Awaited<ReturnType<F>>>;
  /**
   * Start the workflow as a **detached child**: fire-and-forget, no completion
   * is ever threaded back, and the handle can cancel it — `startChild`, typed.
   * `options` is where a `workflowId` claim, a `taskQueue`, or a
   * `parentClosePolicy` goes.
   *
   * Detached, after the wire flag it sets, and deliberately not "background":
   * `background()` on this same surface runs a concurrent branch *inside* the
   * calling workflow — same execution, same history, result retrievable — and
   * this is its opposite, a separate execution nothing is ever heard from
   * again. One word for both would blur the exact line this API exists to
   * draw.
   */
  detached(
    props?: Parameters<F>[0],
    options?: Omit<ChildOptions, 'props'>,
  ): ChildHandle;
}

/**
 * A workflow's whole declaration: its key, its body, and what it says about
 * itself.
 *
 * One object rather than `(key, definition)` because the key is a property of
 * the workflow like the rest of them, and a positional first argument made the
 * described and undescribed forms read as two different APIs — one a pair, one a
 * literal. There is also no argument order to get backwards.
 */
export interface WorkflowRegistration<
  F extends AnyWorkflowFn,
> extends WorkflowDescriptor {
  /**
   * The wire name: what `client.start` takes, what a task is routed by, and what
   * a second `createWorkflow` claiming it collides with.
   *
   * Written here rather than derived from the export name because a reference
   * has to know its name at *definition* time, and `fn.name` is not a candidate
   * — workers ship as bundled artifacts and minification renames functions
   * silently.
   */
  key: string;
  /**
   * The workflow itself, taking the props described above as one object.
   *
   * Named `run` rather than `start` because `start` is taken, and taken by the
   * opposite side: `client.start` and `service.start` *dispatch* a workflow from
   * outside, and this is the body that then runs. Two meanings of one word
   * across one API is worse than a word that is merely less evocative.
   */
  run: F;
}

/**
 * Define a workflow, register it, and return the dispatching reference — see the
 * fileoverview for why the reference is not the function.
 *
 * The descriptor rides on `.impl` and reaches the catalogue through the same
 * `workflowDescriptor` read as before, so a workflow that describes itself and
 * one that does not are the same call with more fields.
 *
 * Registering the **same** function under a key twice is a no-op — a module
 * genuinely can evaluate twice. A *different* function under a taken key is
 * recorded for `startWorker` to refuse, never thrown here (fileoverview).
 */
export function createWorkflow<F extends AnyWorkflowFn>(
  registration: WorkflowRegistration<F>,
): WorkflowRef<F> {
  const {key: name, run, ...descriptor} = registration;
  // Unconditional: this is the only thing that writes a descriptor, so there is
  // never an existing one to overwrite. An empty one reads as "not described"
  // everywhere it is consumed.
  const impl = describeWorkflow(run, descriptor);

  const existing = registered.get(name);
  if (existing && existing !== impl) conflicted.add(name);
  registered.set(name, impl);

  const execute = (
    props?: Parameters<F>[0],
    options: Omit<ChildOptions, 'props'> = {},
  ): Promise<Awaited<ReturnType<F>>> => {
    try {
      return executeChild<Awaited<ReturnType<F>>>(name, {...options, props});
    } catch (e) {
      throw asDispatchError(e, name);
    }
  };

  const ref = Object.assign((...args: Parameters<F>) => execute(args[0]), {
    workflowName: name,
    impl,
    execute,
    detached(
      props?: Parameters<F>[0],
      options: Omit<ChildOptions, 'props'> = {},
    ): ChildHandle {
      try {
        return startChild(name, {...options, props});
      } catch (e) {
        throw asDispatchError(e, name);
      }
    },
  }) as WorkflowRef<F>;
  // The brand `workflowImplOf` unwraps by. Non-enumerable, like the descriptor:
  // invisible to everything that does not ask for it.
  Object.defineProperty(ref, IMPL, {value: impl, enumerable: false});
  return ref;
}

/**
 * Turn the context error from `core/` into one that answers the question the
 * caller is actually about to ask — "why didn't my function run?". The generic
 * message is correct but names the mechanism, not the mistake: a reference
 * *looks* like the function it replaced, and each wrong caller has a right
 * place to go. Anything else that escaped is not ours to reword.
 */
function asDispatchError(e: unknown, name: string): unknown {
  if (
    !(e instanceof Error) ||
    !e.message.includes('outside a workflow context')
  )
    return e;
  return new Error(
    `${name} is a workflow reference: calling it dispatches a child workflow, which only works inside another workflow. ` +
      `From application code, start it through a client (client.start('${name}', props)); ` +
      `from a unit test, run the body directly with .impl(...).`,
  );
}

/**
 * The registered implementation behind `fn`, when `fn` is a `WorkflowRef`;
 * `fn` itself otherwise.
 *
 * Every seam that registers a function *for the engine to invoke* must pass
 * through this — `startWorker`'s fold does, and so does
 * `createLocalRuntime.registerWorkflow` — because registering the reference
 * itself would be quietly fatal: the engine would invoke it inside the very
 * context it dispatches from, and the workflow would `executeChild` itself
 * forever instead of running.
 */
export function workflowImplOf(fn: AnyFn): AnyFn {
  const impl = (fn as unknown as Record<symbol, unknown>)[IMPL];
  return typeof impl === 'function' ? (impl as AnyFn) : fn;
}

/**
 * What one `startWorker({workflows})` entry registers: a `WorkflowRef` under
 * **its own** wire name — the name is intrinsic to the workflow now, and an
 * export alias must not become a second name for it — and a plain function
 * under its export name, the rule that has always held.
 */
export function resolveWorkflowRegistration(
  exported: string,
  fn: AnyFn,
): [string, AnyFn] {
  const impl = workflowImplOf(fn);
  return impl === fn
    ? [exported, fn]
    : [(fn as unknown as WorkflowRef<AnyWorkflowFn>).workflowName, impl];
}

/**
 * Names that more than one distinct implementation claimed. `startWorker`
 * refuses to start while any of these is not resolved by an explicit
 * `options.workflows` entry — the same contract as `activityNameConflicts`.
 */
export function workflowNameConflicts(): string[] {
  return [...conflicted];
}

/**
 * Everything registered so far, as the `[name, fn]` pairs a worker registry
 * takes. A copy, so a worker's snapshot cannot shift under it after
 * `WORKER_READY` has reported what it serves.
 */
export function registeredWorkflowImpls(): [string, AnyFn][] {
  return [...registered];
}

/**
 * Forget everything registered. For specs, with the sharp edge
 * `resetActivityRegistry` documents: module-scope registrations run once per
 * process, so a cleared registration is gone for good — save and restore
 * (`spec/support/isolate_workflow_registry.ts`) rather than merely clearing.
 */
export function resetWorkflowRegistry(): void {
  registered.clear();
  conflicted.clear();
}

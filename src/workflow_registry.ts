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
 * the author writes it as `key`.
 *
 * That is why `startWorker` also takes a **list** — `{workflows: [order]}`.
 * Once the name is on the workflow, the map's keys have nothing to supply, and
 * a list cannot let an export alias disagree with the key. The map stays for
 * the case the key does not cover: a workflow that is just a function, whose
 * export name is the only name it has (`resolveListedWorkflow`).
 *
 * An author-written name also means two modules that never see each other can
 * claim one name. That conflict is **recorded, not thrown**:
 * these calls run at module load, where a throw fires mid-evaluation and
 * crashes the process on import instead of reporting anything actionable
 * (`activity_registry.ts` argues this at length). `startWorker` checks
 * `workflowNameConflicts()` once every module has loaded, refuses to start, and
 * names the escape hatch — an explicit `startWorker({workflows})` entry, which
 * wins over anything registered here.
 *
 * ## Props are described once, in the schema — and only there
 *
 * `props` takes a schema value from the `schema/` library (`t.object({...})`)
 * and nothing else: the schema renders itself into the descriptor the catalogue
 * publishes *and* types the `run` it sits beside, so the props shape is written
 * once. `workflow.ts` re-exports `t` for exactly this, so a workflow module can
 * author one at module scope without reaching past the author entrypoint.
 *
 * A **pre-rendered JSON Schema document used to be accepted here too**, for a
 * caller who already held one. It no longer is. The two forms were one API with
 * two truths: the document form wrote the props shape twice — once as the
 * document, once as `run`'s annotation — with nothing relating them, which is
 * the duplication the schema form exists to end. Keeping both meant the
 * guarantee could only ever be "written once, if you picked the right form",
 * and every reader of a declaration had to ask which form produced it. So the
 * form that cannot drift is the only one now.
 *
 * What that costs is real and was taken deliberately: a document that cannot be
 * re-authored — generated elsewhere, or read from a file — has no form here any
 * more. Such a workflow describes its props with `t` or registers undescribed,
 * which `WorkflowRegistration` is now the whole of. Nothing downstream moved:
 * the descriptor still carries a rendered `WorkflowPropsSchema`, so the
 * catalogue, the wire, and every reader of one see exactly what they did
 * before.
 *
 * A `props` that is not a schema is **thrown at the call site**, the one thing
 * this file throws at module load. The conflict rule above records rather than
 * throws because a conflict is emergent across modules and only `startWorker`
 * holds enough to report it; this is the opposite — a local authoring mistake
 * in the file the stack trace names, already refused by TypeScript for anyone
 * who has types, and whose only other outcome would be registering with no
 * props: silently publishing an undescribed workflow, which is the failure a
 * descriptor exists to prevent.
 *
 * **The schema describes; it does not run.** `createWorkflow` renders it and
 * keeps nothing else: no wrapper parses props before the body, because that
 * would move where a bad start fails — out of the caller and into a workflow
 * task, on replay as well as on the first attempt — which
 * `protocol/workflow_descriptor.ts` argues is a separate decision with its own
 * failure semantics to choose. So the props a body receives are the props the
 * caller sent, and `run` is typed `InferInput` rather than `InferOutput`: a
 * `t.defaulted` key is optional for the caller and *absent* for the handler,
 * because nothing filled it. A workflow that wants the filled value parses in
 * its own first lines, with the same schema value it declared.
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
import type {InferInput, Schema} from './libraries/schema';
import type {WorkflowDescriptor, WorkflowPropsSchema} from './protocol';

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
 * What both declaration forms carry: a workflow's key and what it says about
 * itself, short of the props the two forms differ over.
 *
 * One object rather than `(key, definition)` because the key is a property of
 * the workflow like the rest of them, and a positional first argument made the
 * described and undescribed forms read as two different APIs — one a pair, one a
 * literal. There is also no argument order to get backwards.
 *
 * Split out rather than repeated so `title` and `description` keep one home:
 * they are `WorkflowDescriptor`'s, and both forms inherit them from there.
 */
export interface WorkflowDeclaration extends Omit<WorkflowDescriptor, 'props'> {
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
}

/**
 * The declaration for a workflow that **describes no props**: its key, whatever
 * else it says about itself, and the body.
 *
 * This was also the form that carried a pre-rendered JSON Schema document.
 * That half is gone (fileoverview), and what is left is the case a schema
 * library was never needed for: a workflow whose props are not described, which
 * still lists under its name like a workflow with no descriptor at all.
 */
export interface WorkflowRegistration<
  F extends AnyWorkflowFn,
> extends WorkflowDeclaration {
  /**
   * Not a document. Props are described by a schema now — `t.object({...})`
   * from `workflow-engine/schema`, re-exported by the author entrypoint — and a
   * declaration carrying one is a `SchemaWorkflowRegistration`.
   *
   * Declared as `never` rather than left off the interface so the key survives
   * as somewhere to write this down: a rendered document fails to compile
   * either way, but only this way is there a `props` to hover over when it
   * does. The compiler's own message will not explain the migration — an
   * overload mismatch is reported against the call, not the key — so the
   * explanation lives here, in the throw an untyped caller gets, and in the
   * fileoverview.
   */
  props?: never;
  /**
   * The workflow itself, taking its props as one object — undescribed, so the
   * annotation written here is their only account, read by nothing else.
   *
   * Named `run` rather than `start` because `start` is taken, and taken by the
   * opposite side: `client.start` and `service.start` *dispatch* a workflow from
   * outside, and this is the body that then runs. Two meanings of one word
   * across one API is worse than a word that is merely less evocative.
   */
  run: F;
}

/**
 * The declaration with its props written as a **schema** — `t.object({...})`
 * from `workflow-engine/schema`, re-exported by the author entrypoint — which
 * both renders the descriptor and types the body beside it.
 *
 * ```ts
 * const Nightly = Tempo.t.object({
 *   day: Tempo.t.string({description: 'The date to total, as YYYY-MM-DD.'}),
 * });
 *
 * export const nightlyReport = Tempo.createWorkflow({
 *   key: 'nightlyReport',
 *   title: 'Nightly revenue report',
 *   props: Nightly,
 *   async run({day}) {   // {day: string}, inferred — not annotated
 *     return total(day);
 *   },
 * });
 * ```
 *
 * `props` is **required** here, which is what makes this shape the one
 * TypeScript picks: a declaration without it is a `WorkflowRegistration` and
 * types `run` from the annotation the author wrote. There is no third state to
 * disambiguate at the call site — the rendered document that used to be one is
 * no longer a form (fileoverview).
 *
 * `run` is a method rather than a property so its parameter stays bivariant:
 * a body written against a narrower props type — the common case, since the
 * schema is what determined it — is still assignable. And it is typed
 * `InferInput`, not `InferOutput`, because nothing parses the props on the way
 * in (fileoverview): a `t.defaulted` key is optional for the caller and absent
 * for the handler until the handler parses it.
 */
export interface SchemaWorkflowRegistration<
  S extends Schema,
  R,
> extends WorkflowDeclaration {
  /** The props schema: rendered into the descriptor, and typing `run` beside it. */
  props: S;
  /** The workflow itself, taking the props the schema describes. */
  run(props: InferInput<S>): Promise<R>;
}

/** Both forms as one shape, which is what the implementation reads. */
type AnyWorkflowRegistration<F extends AnyWorkflowFn> = Omit<
  WorkflowRegistration<F>,
  'props'
> & {props?: Schema};

/**
 * The descriptor's `props`: the author's schema, rendered.
 *
 * A schema is recognised by its `validate` method rather than by a brand or an
 * `instanceof`, because the port is an interface anything may implement and
 * nothing implementing it declares that it does. What fails that check was the
 * pre-rendered document being carried through untouched; there is no such form
 * now, so failing it is an authoring mistake and throws (fileoverview) naming
 * what to write instead. Only an untyped caller can get here — TypeScript
 * refuses a non-schema `props` at the declaration.
 *
 * A schema that renders nothing — `toJsonSchema` is the port's optional half —
 * leaves the descriptor with no props, which reads as "not described", exactly
 * like a workflow that said nothing. Same tolerance as
 * `connectors/catalogue.ts` shows an unrenderable operation schema, and for the
 * same reason: refusing to register would take a workflow that runs perfectly
 * well off its queue over missing documentation.
 */
function renderProps(
  name: string,
  props: Schema,
): WorkflowPropsSchema | undefined {
  if (typeof props?.validate !== 'function') {
    throw new Error(
      `createWorkflow('${name}'): props must be a schema, not a rendered JSON Schema document. ` +
        `Author it with t from workflow-engine/schema — props: t.object({day: t.string()}) — ` +
        `which renders the same document into the descriptor and types run beside it. ` +
        `A document you cannot re-author has no form here: describe the props with t, ` +
        `or drop props and register the workflow undescribed.`,
    );
  }
  return props.toJsonSchema?.() as WorkflowPropsSchema | undefined;
}

/**
 * Define a workflow, register it, and return the dispatching reference — see the
 * fileoverview for why the reference is not the function.
 *
 * The descriptor rides on `.impl` and reaches the catalogue through the same
 * `workflowDescriptor` read as before, so a workflow that describes itself and
 * one that does not are the same call with more fields.
 *
 * Two declaration forms, told apart by `props`: a schema
 * (`SchemaWorkflowRegistration` — it types `run` as well as describing it), or
 * no props at all (`WorkflowRegistration`). A rendered JSON Schema document is
 * no longer either of them, and passing one throws with the schema to write
 * instead. What is stored is the rendered document, as it always was, so
 * nothing downstream of here knows which form was written.
 *
 * Registering the **same** function under a key twice is a no-op — a module
 * genuinely can evaluate twice. A *different* function under a taken key is
 * recorded for `startWorker` to refuse, never thrown here (fileoverview).
 */
export function createWorkflow<S extends Schema, R>(
  registration: SchemaWorkflowRegistration<S, R>,
): WorkflowRef<(props: InferInput<S>) => Promise<R>>;
export function createWorkflow<F extends AnyWorkflowFn>(
  registration: WorkflowRegistration<F>,
): WorkflowRef<F>;
export function createWorkflow<F extends AnyWorkflowFn>(
  registration: AnyWorkflowRegistration<F>,
): WorkflowRef<F> {
  const {key: name, run, props, ...rest} = registration;
  const rendered = props === undefined ? undefined : renderProps(name, props);
  const descriptor: WorkflowDescriptor =
    rendered === undefined ? {...rest} : {...rest, props: rendered};
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
 * What one entry of the **list** form registers: a `WorkflowRef` under its own
 * wire name.
 *
 * The list exists because the key is now a property of the workflow, so the map
 * form's export keys have nothing left to supply — `{workflows: [order]}` says
 * what the map said, without inviting an export alias to disagree with the key.
 *
 * A plain function is refused here rather than registered, because a list has no
 * name to give it and `fn.name` is not a candidate — workers ship bundled and
 * minification renames functions silently, which is the same reason `key` is
 * written by hand. The map form remains exactly right for plain functions, and
 * the error says so; this is a missing name, not a deprecation.
 *
 * Not a compile error, because it cannot be: an array is an `object`, so the
 * option's type admits either form and neither branch can exclude the other.
 */
export function resolveListedWorkflow(
  fn: AnyFn,
  index: number,
): [string, AnyFn] {
  const impl = workflowImplOf(fn);
  if (impl === fn)
    throw new Error(
      `workflows[${index}] is a plain function, which carries no wire name. ` +
        `Declare it with createWorkflow({key, run}) to give it one, or pass a ` +
        `module namespace — startWorker({workflows: modules}) — where the ` +
        `export name supplies it.`,
    );
  return [(fn as unknown as WorkflowRef<AnyWorkflowFn>).workflowName, impl];
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

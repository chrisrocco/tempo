/**
 * @fileoverview
 * The activities a workflow module declared it would call, waiting for a worker to
 * pick them up.
 *
 * Process-global mutable state, which is otherwise absent from this repo, so it is
 * worth being precise about what buys it.
 *
 * ## The problem it solves
 *
 * A worker is handed its activities as one object: `startWorker({activities})`. For
 * a small artifact that is fine — a module namespace picks up new exports on its
 * own. It stops being fine when a workflow is large and decomposed, because each
 * helper module reaches for its own activities and the entrypoint has to name every
 * one of those modules from memory. Nothing checks the list is complete, and the
 * failure is quiet: `activity_worker` answers an unregistered name with
 * `no activity <name>`, an activity *failure*, so it retries with backoff and the
 * execution parks with no indication that a wire is missing.
 *
 * ## Why this shape works where an earlier attempt did not
 *
 * A previous version put registration next to the *implementation* —
 * `registerActivities({charge})` at the bottom of an activities module — and it
 * could not work. Workflow modules reach activities through `import type`, which is
 * erased, so the module never loaded and its registration never ran; the only thing
 * that could load it was the worker entrypoint, which is the step being removed.
 *
 * Registration is tied to **use** instead. `proxyActivities` both types the proxy
 * and records the implementations, so declaring that a workflow will call an
 * activity *is* registering it. There is no order to get wrong and nothing to keep
 * in step: the entrypoint imports its workflows, loading them runs their
 * `proxyActivities` calls, and the worker has exactly the activities its workflows
 * asked for.
 *
 * ## What it costs
 *
 * `StartWorkerOptions` is no longer the complete account of a worker's activities —
 * `src/tempo.ts` argues at length that the options object is the configuration, and
 * this is a documented exception to it. What a worker can run now depends on which
 * workflow modules were loaded, which is exactly the coupling that makes it correct:
 * a worker that loads a workflow can serve that workflow.
 *
 * Nothing here is exported from `src/index.ts`. The reset below exists for specs,
 * and the host entrypoint says everything it exports is "here because something
 * cannot be built without it" — a registry-clearing function is not that.
 */

/** Any callable. `any[]` rest params are required for assignability — see `core/workflow_api`. */
type AnyFn = (...args: any[]) => unknown;

const registered = new Map<string, AnyFn>();
const conflicted = new Set<string>();

/**
 * Record activity implementations under their property names.
 *
 * Re-registering the **same** function under a name is a no-op: a module genuinely
 * can evaluate twice — resolved through two paths, or present in both a bundle and
 * a `require` — and that is not a mistake anyone made.
 *
 * A *different* function under a name already taken is **recorded, not rejected
 * here** — the last one wins in this map, and `startWorker` then refuses to start.
 *
 * Throwing at this point is the obvious answer and is not available. Every
 * `proxyActivities` call registers, and those calls run at module load, so a throw
 * fires while modules are still being evaluated, before any application or test setup
 * exists to catch it: a process that crashes on import rather than reporting something
 * actionable. Deferring the failure to `startWorker` costs nothing — by then every
 * module has loaded, so the picture is complete — and buys an error that names the
 * activity and says what to do about it.
 *
 * The escape hatch is `startWorker({activities})`, which wins over anything declared,
 * so an artifact that must be unambiguous names the implementation it means.
 *
 * Non-callable properties are skipped, so handing over a whole module namespace that
 * also exports constants is fine — the same filtering the type level applies.
 */
export function registerActivityImpls(impls: object): void {
  for (const [name, fn] of Object.entries(impls)) {
    if (typeof fn !== 'function') continue;
    const existing = registered.get(name);
    if (existing && existing !== fn) conflicted.add(name);
    registered.set(name, fn as AnyFn);
  }
}

/**
 * Names that more than one distinct implementation claimed.
 *
 * `startWorker` refuses to start when any of these is not resolved by an explicit
 * `options.activities` entry — see above for why the check is there rather than at
 * registration. Exported so a build check can assert on it directly too.
 */
export function activityNameConflicts(): string[] {
  return [...conflicted];
}

/**
 * Everything registered so far, as the `[name, fn]` pairs a worker registry takes.
 *
 * A copy: `startWorker` snapshots it rather than reading through, so a worker's set
 * cannot shift under it after the readiness line has already reported what it
 * serves.
 */
export function registeredActivityImpls(): [string, AnyFn][] {
  return [...registered];
}

/**
 * Forget everything registered.
 *
 * Exists because a process-global needs one and specs are the reason: without it, a
 * workflow module imported by one spec would leak into every spec after it. The cost
 * of globalness, made explicit rather than hidden.
 *
 * **Resetting is destructive in a way that is easy to miss.** Registrations made at
 * module scope — which is where `proxyActivities` is meant to be called — happen
 * once per process, because module evaluation is cached. Clearing the registry does
 * not put a module back in a state where its declaration will run again; that
 * registration is simply gone for the rest of the process. A spec that resets between
 * cases and also relies on an imported workflow module's declarations has to restore
 * them, which is what `spec/support/isolate_activity_registry.ts` does by
 * saving and restoring rather than clearing.
 *
 * This does not arise in production, where modules load once and the process runs
 * until it is replaced. It is purely a consequence of a test suite sharing one
 * process, and it is the sharpest edge on this whole mechanism.
 */
export function resetActivityRegistry(): void {
  registered.clear();
  conflicted.clear();
}

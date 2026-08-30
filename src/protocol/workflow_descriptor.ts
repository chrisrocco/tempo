/**
 * @fileoverview
 * What a workflow says about itself, for whoever is looking at a list of them.
 *
 * A registered workflow is a function under a name, and a name is all a reader gets:
 * `listQueues()` can say a worker serves `nightlyReport` and nothing about what that is
 * or what it takes. This is the vocabulary for saying the rest — a title, a sentence, and
 * the shape of the arguments — so a dashboard can present the deployed workflows rather
 * than requiring someone to go and read the source.
 *
 * In `protocol/` because it is data that will cross the wire to a reader who has no
 * access to the functions. Nothing here is used during replay.
 *
 * ## The engine describes; the workflow validates
 *
 * A props schema is carried and handed to whoever asked. **Nothing on this side of the
 * wire enforces it**: a start is accepted whatever its props, and a document reported
 * here is a description rather than a gate — which is what lets a workflow with no live
 * worker, or one two workers describe differently, still be started and still be listed.
 *
 * Enforcement lives where the schema does. A workflow declared with a schema
 * (`createWorkflow`) parses its props before its body, so bad props fail that execution
 * with the schema's own message; see `workflow_props.ts` for why the parse sits there
 * rather than in front of the start, and what it would take to move it. The document
 * here is what that schema rendered, and a form drawing it is reading the same rules the
 * workflow will apply. `WorkflowPropsSchema` records what taking a schema shape cost.
 *
 * ## Every field is optional
 *
 * Including `title`. A workflow with no descriptor at all still appears in a listing under
 * its registered name, so a partial descriptor is not a special case — absence falls back
 * to the name the same way everywhere, and adoption can be one workflow at a time rather
 * than all or nothing.
 */

/**
 * A JSON Schema, as far as this package needs to know one.
 *
 * Deliberately structural and open. Nothing here validates, so the fields named
 * are only the ones a *renderer* reads; the index signature carries everything
 * else — `$schema`, `enum`, `format`, `allOf` — through untouched, which is what
 * lets a document rendered by any tool — the schema library's `t`, or a vendor a
 * consumer already uses — be passed straight in. Inventing a closed type would
 * mean tracking a spec this package has no reason to implement, and rejecting
 * valid schemas whenever it fell behind.
 */
export interface JsonSchema {
  type?: string;
  /** What this value is, for the note under the field. */
  description?: string;
  [keyword: string]: unknown;
}

/**
 * What a workflow must be started with: a JSON Schema over its one props object.
 *
 * ## This replaced an ordered list, and the trade is real
 *
 * It was `readonly WorkflowProp[]` — a named list, chosen because *"the thing
 * reading this is drawing a form: a row per field"*, and because a list fixes
 * the order those rows appear in. JSON Schema `properties` is a **map**, so that
 * guarantee is gone: field order is now whatever a renderer's iteration gives
 * it, which in practice is insertion order for string keys and is not promised
 * by the format.
 *
 * Taken anyway, because the alternative cost more. Anything that generates this
 * — `createWorkflow` rendering a `t` schema, or a consumer holding one from the
 * vendor they already use — holds a JSON Schema, and a bespoke list meant
 * converting into a shape only this package understands, then back out again in
 * whatever reads it. A renderer that needs a specific order can carry one; a
 * caller that had to translate had no way to avoid it.
 *
 * The other half of the trade is a caveat that dies here: the list could only
 * describe a workflow that already took one object, so a variadic one *"still
 * registers and still runs; it simply lists under its name with no props"*.
 * Every workflow now takes one props object, so every workflow is describable.
 */
export interface WorkflowPropsSchema {
  type?: 'object';
  /** One entry per key of the props object `run` receives. */
  properties?: Readonly<Record<string, JsonSchema>>;
  /** Which of them the workflow needs. */
  required?: readonly string[];
  [keyword: string]: unknown;
}

/**
 * One workflow as a worker reports it: the name it is registered under, plus whatever it
 * says about itself.
 *
 * The name is here and not on `WorkflowDescriptor` because a descriptor describes the
 * workflow while the name identifies it — `createWorkflow`'s `key`, or the key in
 * `startWorker({workflows})`. This is the pairing, made where both are known.
 */
export interface WorkflowReport extends WorkflowDescriptor {
  /** The registered name — what `client.start` takes and what a task is routed by. */
  name: string;
}

/**
 * A workflow as a catalogue shows it, gathered across every worker that reports one.
 *
 * `title` is resolved rather than optional here, because every reader would otherwise
 * write the same `?? name` fallback and one of them would forget.
 */
export interface WorkflowSummary extends WorkflowReport {
  title: string;
  /**
   * The queues live workers currently serve it on, in the order first seen.
   *
   * Currently: a queue appears only while a worker there still vouches for its
   * report by polling with the report's digest, so a pool whose workers are gone
   * drops off rather than reading forever as a place this workflow can run.
   */
  taskQueues: string[];
  /**
   * True when workers disagree about what this workflow is.
   *
   * Two workers reporting different descriptions for one name is a fleet running two
   * versions of a worker binary (#65). The catalogue keeps the first report and raises
   * this rather than silently choosing, because which one is right is not a question the
   * server can answer — only that they differ, which is the part worth surfacing.
   */
  conflicting?: boolean;
}

/** What a workflow says about itself. */
export interface WorkflowDescriptor {
  /**
   * A human name for a list — "Nightly revenue report", not `nightlyReport`.
   *
   * Absent means a reader falls back to the registered name, which is why there is no
   * `name` field here: `createWorkflow`'s `key` is the identifier, and a second place to
   * write it is a second place for it to be wrong.
   */
  title?: string;
  /** A sentence about what it does, for the row underneath the title. */
  description?: string;
  /**
   * What must be passed to start it — a JSON Schema over the one object `run`
   * receives. See `WorkflowPropsSchema`, which records what this shape costs.
   *
   * Absent means "not described", which a form renders as nothing rather than as
   * a workflow taking no arguments. It is metadata, never validated here: the
   * engine starts what it is asked to start. A workflow that declared its props
   * as a schema rejects props this document disagrees with when it runs, which
   * is a failed execution rather than a refused start.
   */
  props?: WorkflowPropsSchema;
}

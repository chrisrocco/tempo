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
 * ## The engine describes; it does not validate
 *
 * `input` is a JSON Schema and the engine **never reads it** — it is stored, carried, and
 * handed to whoever asked. That is the distinction that keeps this cheap: describing is
 * data, validating is a library, and this package has no runtime dependencies and intends
 * to keep none.
 *
 * The consequence is deliberate rather than reluctant. A consumer who writes schemas with
 * zod converts at the boundary — `zodToJsonSchema(Input)` — and keeps zod as *their*
 * dependency. A consumer who writes the object by hand is equally served. And whether
 * arguments are checked before a workflow runs stays where it already is: the workflow's
 * own first lines, or the caller. Adding validation here would change failure semantics
 * for every execution, which is a separate decision with its own argument to make.
 *
 * ## Every field is optional
 *
 * Including `title`. A workflow with no descriptor at all still appears in a listing under
 * its registered name, so a partial descriptor is not a special case — absence falls back
 * to the name the same way everywhere, and adoption can be one workflow at a time rather
 * than all or nothing.
 */

/**
 * A JSON Schema document, carried opaquely.
 *
 * Typed as an open record rather than a modelled schema type, and that is not laziness:
 * modelling it would commit this package to a dialect and a version of one, and would
 * imply the engine understands what it holds. It does not. The looseness is the contract.
 */
export type JsonSchema = {readonly [key: string]: unknown};

/**
 * One value a workflow must be started with.
 *
 * A named list rather than one schema over a positional array, because the thing reading
 * this is drawing a form: a row per field, with a label and a note under it. A positional
 * schema can express the same set and has to be taken apart again by every reader before
 * it can be rendered, and a caller reading it has to count.
 *
 * The *list* is this package's shape — names, order, whether a value is required. The
 * *type* of each value is a JSON Schema, so nothing here invents a type language.
 */
export interface WorkflowProp {
  /** The key on the props object `start` receives. */
  name: string;
  /** What this value is, for the note under the field. */
  description?: string;
  /** Whether the workflow needs it. Absent means optional. */
  required?: boolean;
  /**
   * The value's type, as a JSON Schema, carried opaquely — the engine never reads it.
   *
   * Absent is allowed and means "no stated type", which a form renders as free text. That
   * is better than the alternative of forcing a schema onto every prop and getting
   * `{type: 'string'}` written reflexively where the author meant "I have not decided".
   */
  schema?: JsonSchema;
}

/** What a workflow says about itself. */
export interface WorkflowDescriptor {
  /**
   * A human name for a list — "Nightly revenue report", not `nightlyReport`.
   *
   * Absent means a reader falls back to the registered name, which is why there is no
   * `name` field here: the key in `startWorker({workflows})` is the identifier, and a
   * second place to write it is a second place for it to be wrong.
   */
  title?: string;
  /** A sentence about what it does, for the row underneath the title. */
  description?: string;
  /**
   * What must be passed to start it, in the order a form should show them.
   *
   * These are the keys of the **single object** `start` receives — described workflows
   * take one props object rather than a positional list, which is the one constraint this
   * shape adds. It buys a start form that can be rendered and submitted without anyone
   * having to know an argument order, and it costs the ability to describe a workflow
   * whose signature is `(a, b)`. Such a workflow still registers and still runs; it simply
   * lists under its name with no props.
   */
  props?: readonly WorkflowProp[];
}

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
   * The **whole argument list**, as one JSON Schema — an array schema, because
   * `start(name, args)` takes a positional list.
   *
   * One schema for the list rather than one per argument, so that what a caller must
   * pass is answerable by reading a single document. A per-argument form matches the
   * call shape more literally and leaves nothing to render a form from without
   * reassembling it.
   *
   * ```ts
   * input: {
   *   type: 'array',
   *   prefixItems: [{type: 'string', title: 'Customer id'}],
   *   minItems: 1,
   * }
   * ```
   */
  input?: JsonSchema;
}

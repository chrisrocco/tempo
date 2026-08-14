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
 * ## Small and closed, rather than a schema language
 *
 * A prop's type is one of four names, not a schema document. This started as an opaque
 * JSON Schema and was narrowed deliberately.
 *
 * JSON Schema is a real specification and a reasonable thing to reach for — but it is not
 * *one* thing. There are drafts that disagree in ways that bite (an array-valued `items`
 * in draft-07 is `prefixItems` in 2020-12), so adopting it is not a decision but the start
 * of one: which draft, and which subset does a form renderer actually honour. That is the
 * same version-skew problem a schema library would have brought, one layer down, and
 * without a library to report when the answer is wrong.
 *
 * Worse, it would have been a claim this package does not keep. Typed honestly, an opaque
 * schema is `{[key: string]: unknown}` — a name over "any object", which the engine never
 * reads and never checks. Anyone meeting a field called `schema` reasonably assumes
 * `minLength` and `pattern` mean something here. They would not.
 *
 * Four names are checkable by the compiler, exhaustively switchable by a renderer, and
 * describe exactly what gets rendered. `json` keeps anything structured expressible — a
 * text area whose contents are parsed — so nothing becomes impossible, only unstructured.
 * Widening this later is easy; walking back from a field named after a standard we only
 * partly implement would not have been.
 *
 * ## The engine describes; it does not validate
 *
 * A prop's `type` is carried and handed to whoever asked. It is not enforced when a
 * workflow starts, and that stays true deliberately: whether arguments are checked belongs
 * in the workflow's own first lines or in the caller, and moving it here would change
 * failure semantics for every execution — a separate decision with its own argument to
 * make.
 *
 * ## Every field is optional
 *
 * Including `title`. A workflow with no descriptor at all still appears in a listing under
 * its registered name, so a partial descriptor is not a special case — absence falls back
 * to the name the same way everywhere, and adoption can be one workflow at a time rather
 * than all or nothing.
 */

/**
 * What kind of value a prop takes.
 *
 * A closed union so a renderer can switch exhaustively and the compiler will tell it when
 * this grows. `json` is the escape hatch for anything structured: a free-form value the
 * caller supplies as JSON, rendered as a text area rather than a typed control.
 */
export type WorkflowPropType = 'string' | 'number' | 'boolean' | 'json';

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
   * What kind of value it takes.
   *
   * Absent means "not stated", which a form renders as free text — better than forcing a
   * type onto every prop and collecting `'string'` written reflexively where the author
   * had not decided. A reader that needs a default should treat absent as `'string'`
   * rather than refusing to render the field.
   */
  type?: WorkflowPropType;
}

/**
 * One workflow as a worker reports it: the name it is registered under, plus whatever it
 * says about itself.
 *
 * The name is here and not on `WorkflowDescriptor` because a descriptor is written by an
 * author who does not know it — the name is the key in `startWorker({workflows})`, chosen
 * at registration. This is the pairing, made where both are known.
 */
export interface WorkflowReport extends WorkflowDescriptor {
  /** The registered name — what `start` takes and what a task is routed by. */
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
  /** The queues some worker serves it on, in the order first seen. */
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
